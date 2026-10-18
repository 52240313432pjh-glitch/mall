import fs from 'fs';
import path from 'path';

const BASE = 'D:/dataset/fashioniq';
const SPLITS = path.join(BASE, 'image_splits');
const CAPS = path.join(BASE, 'captions');
const OUT = 'D:/mall/update-names-desc.sql';

const CATS = [
  { key: 'dress', zh: '连衣裙' },
  { key: 'shirt', zh: '衬衫' },
  { key: 'toptee', zh: 'T恤' },
];

// 颜色词典（按优先级，先长词后短词）
const COLORS = [
  ['burgundy', '酒红色'], ['lavender', '淡紫色'], ['maroon', '栗色'],
  ['beige', '米色'], ['khaki', '卡其色'], ['olive', '橄榄绿'],
  ['coral', '珊瑚色'], ['ivory', '米白色'], ['silver', '银色'],
  ['golden', '金色'], ['gold', '金色'], ['navy', '藏蓝色'],
  ['orange', '橙色'], ['purple', '紫色'], ['yellow', '黄色'],
  ['brown', '棕色'], ['green', '绿色'], ['grey', '灰色'],
  ['gray', '灰色'], ['pink', '粉色'], ['blue', '蓝色'],
  ['teal', '蓝绿色'], ['tan', '棕褐色'], ['cream', '奶油色'],
  ['red', '红色'], ['white', '白色'], ['black', '黑色'],
];

// 图案/款式词典（无颜色时兜底命名用）
const PATTERNS = [
  ['striped', '条纹'], ['stripes', '条纹'], ['floral', '碎花'],
  ['flowery', '碎花'], ['printed', '印花'], ['print', '印花'],
  ['plaid', '格纹'], ['checkered', '格纹'], ['polka', '波点'],
  ['lace', '蕾丝'], ['denim', '牛仔'], ['solid', '纯色'],
  ['plain', '纯色'],
];

const FALLBACK_SUB = '时尚百搭，舒适亲肤';
const esc = (s) => String(s)
  .replace(/\\/g, '\\\\')
  .replace(/'/g, "''")
  .replace(/\r?\n/g, ' ');

// 清洗一句 caption
const TRASH = new Set(['the same', 'same', 'none', 'n/a', 'na', 'photo', 'image', 'is', 'this', 'that', 'item', 'clothes', 'clothing', 'clothe']);
const FILLERS = ['it is ', 'this is ', 'that is ', "it's ", 'it’s ', 'is a ', 'is an ', 'is ', 'a ', 'an ', 'the ', 'has ', 'have ', 'having '];
function cleanCaption(raw) {
  let s = String(raw || '').trim();
  if (!s) return null;
  s = s.replace(/[.\s\\]+$/, '').trim();
  let changed = true;
  while (changed && s) {
    changed = false;
    for (const f of FILLERS) {
      if (s.toLowerCase().startsWith(f)) { s = s.slice(f.length); changed = true; break; }
    }
  }
  if (!s || s.length < 2) return null;
  const low = s.toLowerCase();
  if (TRASH.has(low)) return null;
  s = s.charAt(0).toUpperCase() + s.slice(1);
  return s;
}

// 从集合中按优先级提取首个匹配项及其中文
function pick(dict, text) {
  const t = ' ' + text.toLowerCase() + ' ';
  for (const [word, zh] of dict) {
    if (t.includes(' ' + word + ' ') || t.includes(' ' + word + ',') || t.includes(' ' + word + '.')) {
      return zh;
    }
  }
  return null;
}

// 读取 val 的 caption，构造 asin -> [清洗后的描述]
function loadCaptions(catKey) {
  const caps = JSON.parse(fs.readFileSync(path.join(CAPS, `cap.${catKey}.val.json`), 'utf8'));
  const map = new Map();
  for (const e of caps) {
    if (!map.has(e.target)) {
      const first = Array.isArray(e.captions) ? e.captions[0] : e.captions;
      const cleaned = cleanCaption(first);
      if (cleaned) map.set(e.target, cleaned);
    }
  }
  return map;
}

const lines = ['SET NAMES utf8mb4;', 'SET autocommit=0;'];
const stats = {};

for (const c of CATS) {
  const capMap = loadCaptions(c.key);
  const val = JSON.parse(fs.readFileSync(path.join(SPLITS, `split.${c.key}.val.json`), 'utf8'));

  let withCaption = 0, withColor = 0, withPattern = 0, fallbackName = 0;
  const upd = [];

  for (const asin of val) {
    const sub = capMap.get(asin) || FALLBACK_SUB;
    if (capMap.has(asin)) withCaption++;

    // 命名
    const lang = capMap.get(asin) || '';
    let name;
    const color = pick(COLORS, lang);
    if (color) { name = color + c.zh; withColor++; }
    else {
      const pattern = pick(PATTERNS, lang);
      if (pattern) { name = pattern + c.zh; withPattern++; }
      else { name = c.zh + '时尚款'; fallbackName++; }
    }

    const pic = `http://localhost:8092/images/${c.key}/${asin}.jpg`;
    upd.push(`UPDATE pms_product SET name='${esc(name)}', sub_title='${esc(sub)}' WHERE pic='${pic}';`);
  }
  lines.push(...upd);
  stats[c.key] = { total: val.length, withCaption, withColor, withPattern, fallbackName };
}

lines.push('COMMIT;');

fs.writeFileSync(OUT, lines.join('\n'), 'utf8');
console.log('stats:', JSON.stringify(stats, null, 2));
console.log('written ->', OUT);