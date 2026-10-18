import fs from 'fs';
import path from 'path';
import http from 'http';

const MODEL = 'gemma4:31b-cloud';
const BASE = 'D:/dataset/fashioniq';
const SPLITS = path.join(BASE, 'image_splits');
const OUT_SQL = 'D:/mall/update-names-desc-v2.sql';
const CKPT = 'D:/mall/vision-checkpoint-v2.jsonl';

const CATS = [
  { key: 'dress', zh: '连衣裙' },
  { key: 'shirt', zh: '衬衫' },
  { key: 'toptee', zh: 'T恤' },
];

const CONCURRENCY = Number(process.env.CONCURRENCY || 5);
const LIMIT = Number(process.env.LIMIT || 0); // 0 = 全量

const esc = (s) => String(s)
  .replace(/\\/g, '\\\\')
  .replace(/'/g, "''")
  .replace(/\r?\n/g, ' ');

function ollamaGenerate(payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = http.request({
      host: 'localhost', port: 11434, path: '/api/generate', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('bad response json: ' + data.slice(0, 200))); }
      });
    });
    req.setTimeout(0);
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

const prompt = (catZh) => `你是资深电商服装文案与命名专家。这是一件${catZh}类商品，请仔细观察图片，从颜色、图案纹理、领型、袖长、版型、面料质感、风格气质、适用场合等维度提炼最显著的特征，生成中文商品名和卖点描述。

硬性要求：
1. name：必须以"${catZh}"二字结尾（例如"...${catZh}"），长度6-12字；名称中只能出现一个服装品类词（即结尾的"${catZh}"），前面禁止再出现"衬衫""T恤""连衣裙""开衫""卫衣""外套"等其他品类词；只突出1-2个最显著特征（颜色/图案/版型/风格），用词自然专业、不堆砌不重复、禁止中英混杂、禁止生造词。
2. sub_title：一句话卖点（12-24字），具体描述材质、版型、风格或场合亮点，禁止套用"百搭""简约""时尚"等空泛词，每条都要有差异化。

参考示例：
1) 纯色圆领T恤 -> {"name":"修身纯棉圆领T恤","sub_title":"高支精梳棉亲肤透气，通勤清爽有型"}
2) 蓝白条纹衬衫 -> {"name":"蓝白条纹休闲衬衫","sub_title":"挺括牛津纺垂感佳，通勤休闲两相宜"}
3) 碎花吊带连衣裙 -> {"name":"法式碎花吊带连衣裙","sub_title":"轻盈雪纺飘逸显瘦，浪漫度假风"}

只输出 JSON，格式 {"name":"...","sub_title":"..."}，不要输出任何其他文字。`;

function parseJson(text) {
  if (!text) return null;
  let s = String(text).trim();
  const m = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (m) s = m[1].trim();
  try {
    return JSON.parse(s);
  } catch {
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try { return JSON.parse(s.slice(start, end + 1)); } catch { return null; }
    }
    return null;
  }
}

function collectTasks() {
  const lists = CATS.map((c) => {
    const val = JSON.parse(fs.readFileSync(path.join(SPLITS, `split.${c.key}.val.json`), 'utf8'));
    return val.map((asin) => ({ catKey: c.key, catZh: c.zh, asin }));
  });
  const tasks = [];
  const maxLen = Math.max(...lists.map((l) => l.length));
  for (let i = 0; i < maxLen; i++) {
    for (const l of lists) {
      if (i < l.length) tasks.push(l[i]);
    }
  }
  return tasks;
}

function loadDone() {
  const done = new Set();
  if (fs.existsSync(CKPT)) {
    for (const line of fs.readFileSync(CKPT, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line);
        if (o.asin) done.add(o.catKey + ':' + o.asin);
      } catch { /* skip */ }
    }
  }
  return done;
}

async function genOne(task) {
  const imgPath = path.join(BASE, task.catKey, task.asin + '.jpg');
  if (!fs.existsSync(imgPath)) return { ...task, error: 'missing-image' };
  const b64 = fs.readFileSync(imgPath, 'base64');
  let lastErr = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const data = await ollamaGenerate({
        model: MODEL,
        prompt: prompt(task.catZh),
        images: [b64],
        stream: false,
        format: 'json',
        think: false,
        options: { temperature: 0.9 },
      });
      if (data.error) { lastErr = data.error; continue; }
      const parsed = parseJson(data.response);
      if (parsed && typeof parsed.name === 'string' && typeof parsed.sub_title === 'string') {
        return { ...task, name: parsed.name.trim(), sub_title: parsed.sub_title.trim() };
      }
      lastErr = 'unparsable: ' + String(data.response).slice(0, 80);
    } catch (e) {
      lastErr = e.message;
    }
  }
  return { ...task, error: lastErr };
}

async function main() {
  const all = collectTasks();
  const tasks = LIMIT > 0 ? all.slice(0, LIMIT) : all;
  const done = loadDone();
  const pending = tasks.filter((t) => !done.has(t.catKey + ':' + t.asin));

  console.log(`total=${all.length} to-process=${pending.length} concurrency=${CONCURRENCY}`);

  const stream = fs.createWriteStream(CKPT, { flags: 'a' });
  let ok = 0, fail = 0, idx = 0;
  const t0 = Date.now();
  const queue = pending.slice();

  async function worker() {
    while (queue.length) {
      const task = queue.shift();
      const res = await genOne(task);
      stream.write(JSON.stringify(res) + '\n');
      idx++;
      if (res.error) fail++; else ok++;
      const el = Date.now() - t0;
      const rate = (idx / (el / 1000)).toFixed(2);
      if (idx % 10 === 0 || idx === pending.length) {
        console.log(`[${idx}/${pending.length}] ok=${ok} fail=${fail} elapsed=${(el / 1000).toFixed(0)}s rate=${rate}/s`);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pending.length) }, () => worker()));
  stream.end();

  console.log(`DONE ok=${ok} fail=${fail} total_elapsed=${((Date.now() - t0) / 1000).toFixed(0)}s`);

  if (ok > 0 && LIMIT === 0) {
    const rows = [];
    for (const line of fs.readFileSync(CKPT, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const o = JSON.parse(line);
      if (o.error || !o.name) continue;
      const pic = `http://localhost:8092/images/${o.catKey}/${o.asin}.jpg`;
      rows.push(`UPDATE pms_product SET name='${esc(o.name)}', sub_title='${esc(o.sub_title)}' WHERE pic='${pic}';`);
    }
    if (rows.length) {
      fs.writeFileSync(OUT_SQL, 'SET NAMES utf8mb4;\nSET autocommit=0;\n' + rows.join('\n') + '\nCOMMIT;\n', 'utf8');
      console.log('sql written ->', OUT_SQL, 'rows', rows.length);
    }
  }
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });