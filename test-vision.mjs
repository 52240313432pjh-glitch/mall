import fs from 'fs';
import path from 'path';
import http from 'http';

const MODEL = 'gemma4:31b-cloud';
const BASE = 'D:/dataset/fashioniq';
const SPLITS = path.join(BASE, 'image_splits');

function ollamaGenerate(payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = http.request({
      host: 'localhost', port: 11434, path: '/api/generate', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('bad json')); } });
    });
    req.setTimeout(0);
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

const prompt = (catZh) => `你是资深电商服装文案与命名专家。仔细观察图片中的服装，从颜色、图案纹理、领型、袖长、版型、面料质感、整体风格、适用场合等维度提炼最显著的特征，生成中文商品名和卖点描述。

命名规范：
1. name：6-14个汉字，只突出1-2个最显著特征（如颜色+款式、图案+风格），用词自然专业、不重复堆砌，禁止中英混杂。
2. sub_title：一句话卖点（12-24字），具体描述材质/版型/风格亮点，禁止套用"百搭""简约"等空泛词，每条都要有差异化。

参考示例：
1) 碎花吊带连衣裙 -> {"name":"法式碎花吊带连衣裙","sub_title":"轻盈雪纺飘逸显瘦，浪漫度假风"}
2) 纯色圆领T恤 -> {"name":"修身纯棉圆领T恤","sub_title":"高支精梳棉亲肤透气，通勤基础好搭"}
3) 蓝白条纹衬衫 -> {"name":"蓝白条纹休闲衬衫","sub_title":"挺括牛津纺垂感佳，通勤休闲两相宜"}

只输出 JSON，格式 {"name":"...","sub_title":"..."}，不要输出任何其他文字。这是${catZh}。`;

async function genOne(catKey, catZh, asin) {
  const imgPath = path.join(BASE, catKey, asin + '.jpg');
  const b64 = fs.readFileSync(imgPath, 'base64');
  const t0 = Date.now();
  const data = await ollamaGenerate({
    model: MODEL,
    prompt: prompt(catZh),
    images: [b64],
    stream: false,
    format: 'json',
    options: { temperature: 0.9 },
  });
  return { asin, catZh, ms: Date.now() - t0, response: data.response, error: data.error };
}

const cats = [
  { key: 'dress', zh: '连衣裙' },
  { key: 'shirt', zh: '衬衫' },
  { key: 'toptee', zh: 'T恤' },
];

for (const c of cats) {
  const val = JSON.parse(fs.readFileSync(path.join(SPLITS, `split.${c.key}.val.json`), 'utf8'));
  const asin = val[0];
  const r = await genOne(c.key, c.zh, asin);
  console.log(JSON.stringify(r, null, 2));
}