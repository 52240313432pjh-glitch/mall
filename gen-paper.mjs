import fs from 'fs';
import path from 'path';
import http from 'http';

const MODEL = 'gemma4:31b-cloud';
const SRC = 'C:/Users/zrway/Desktop/论文撰写/第二篇论文/fashioniq_best_1200_balanced.json';
const OUT = 'D:/mall/fashioniq_best_1200_balanced_generated.json';
const CKPT = 'D:/mall/vision-paper-checkpoint.jsonl';
const BASE = 'D:/dataset/fashioniq';

const CAT_ZH = { dress: '连衣裙', shirt: '衬衫', toptee: 'T恤' };
const CONCURRENCY = Number(process.env.CONCURRENCY || 5);
const LIMIT = Number(process.env.LIMIT || 0); // 0 = 全部 item

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
        try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('bad json: ' + data.slice(0, 200))); }
      });
    });
    req.setTimeout(0);
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

const prompt = (catZh) => `你是服装图像分析与电商商品信息生成专家。仔细观察图片中的服装，生成一个 JSON 对象（值为中文）：
{
  "name": "商品名称（必须以“${catZh}”结尾，6-12字）",
  "sub_title": "一句话卖点（12-24字）",
  "description": "商品详细描述（40-100字，涵盖颜色、图案、版型、面料、风格、适用场景）",
  "keywords": ["关键词1","关键词2","关键词3"] 等4-8个检索关键词（含品类、颜色、图案、版型、风格等），用数组表示,
  "color": "颜色",
  "pattern": "图案纹理（纯色/碎花/条纹/印花/刺绣/格纹等）",
  "neckline": "领型",
  "sleeve": "袖型袖长",
  "length": "服装长度",
  "fit": "版型",
  "fabric": "材质面料",
  "style": "风格",
  "details": ["细节装饰1","细节装饰2"] 用数组表示,
  "occasion": "适用场合"
}
只输出 JSON，不要输出任何其他文字。`;

function parseJson(text) {
  if (!text) return null;
  let s = String(text).trim();
  const m = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (m) s = m[1].trim();
  try { return JSON.parse(s); } catch {
    const a = s.indexOf('{'), b = s.lastIndexOf('}');
    if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; } }
    return null;
  }
}

function loadDone() {
  const done = new Map();
  if (fs.existsSync(CKPT)) {
    for (const line of fs.readFileSync(CKPT, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { const o = JSON.parse(line); if (o.key) done.set(o.key, o); } catch {}
    }
  }
  return done;
}

async function genImage(catKey, catZh, imageName) {
  const imgPath = path.join(BASE, catKey, imageName + '.jpg');
  if (!fs.existsSync(imgPath)) return { error: 'missing-image' };
  const b64 = fs.readFileSync(imgPath, 'base64');
  for (let i = 0; i < 3; i++) {
    try {
      const data = await ollamaGenerate({
        model: MODEL, prompt: prompt(catZh), images: [b64], stream: false, format: 'json',
        think: false, options: { temperature: 0.7 },
      });
      if (data.error) continue;
      const p = parseJson(data.response);
      if (p && typeof p.name === 'string') return p;
    } catch (e) {}
  }
  return { error: 'gen-failed' };
}

async function main() {
  const src = JSON.parse(fs.readFileSync(SRC, 'utf8'));
  const items = LIMIT > 0 ? src.items.slice(0, LIMIT) : src.items;

  // 收集唯一图片（reference + top10 去重）
  const unique = new Map(); // key -> {catKey, catZh, imageName}
  for (const it of items) {
    const catZh = CAT_ZH[it.category] || '服装';
    const names = [it.reference_name, ...it.top10.map((t) => t.image_name)];
    for (const n of names) {
      const key = it.category + ':' + n;
      if (!unique.has(key)) unique.set(key, { catKey: it.category, catZh, imageName: n });
    }
  }

  const done = loadDone();
  const pending = [...unique.entries()].filter(([k]) => !done.has(k));
  console.log(`items=${items.length} unique_images=${unique.size} pending=${pending.length}`);

  const stream = fs.createWriteStream(CKPT, { flags: 'a' });
  let idx = 0, ok = 0, fail = 0;
  const t0 = Date.now();
  const queue = pending.slice();

  async function worker() {
    while (queue.length) {
      const [key, info] = queue.shift();
      const res = await genImage(info.catKey, info.catZh, info.imageName);
      const rec = { key, catKey: info.catKey, image_name: info.imageName, ...res };
      stream.write(JSON.stringify(rec) + '\n');
      done.set(key, rec);
      idx++;
      if (res.error) fail++; else ok++;
      const el = Date.now() - t0;
      if (idx % 10 === 0 || idx === pending.length) {
        console.log(`[${idx}/${pending.length}] ok=${ok} fail=${fail} elapsed=${(el / 1000).toFixed(0)}s rate=${(idx / (el / 1000)).toFixed(2)}/s`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pending.length) }, () => worker()));
  stream.end();

  // 组装输出
  const generated = src;
  generated.generated_model = MODEL;
  for (const it of items) {
    const catZh = CAT_ZH[it.category] || '服装';
    const ref = done.get(it.category + ':' + it.reference_name);
    if (ref && !ref.error) {
      it.reference = { image_name: it.reference_name, ...ref };
    }
    for (const t of it.top10) {
      const g = done.get(it.category + ':' + t.image_name);
      if (g && !g.error) Object.assign(t, g);
    }
  }
  generated.items = items;
  fs.writeFileSync(OUT, JSON.stringify(generated, null, 2), 'utf8');
  console.log('written ->', OUT);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });