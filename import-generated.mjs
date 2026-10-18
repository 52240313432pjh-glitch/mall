import fs from 'fs';
import path from 'path';

const SRC = 'D:/mall/fashioniq_best_1200_balanced_generated.json';
const BASE = 'D:/dataset/fashioniq';
const OUT = 'D:/mall/import-generated.sql';

const BRAND_ID = 60;
const BRAND_NAME = '自营';

// 分类映射
const CATS = {
  dress: { catId: 56, catName: '连衣裙' },
  shirt: { catId: 11, catName: '衬衫' },
  toptee: { catId: 8, catName: 'T恤' },
};

const PRICE = '99.00';
const PRODUCT_BASE = 100000;
const SKU_BASE = 2000000;

// 属性分类(新建16) 与 10个属性(74~83)
const ATTR_CAT_ID = 16;
const ATTR_CAT_NAME = '服装';
const ATTRS = [
  { id: 74, key: 'color', name: '颜色' },
  { id: 75, key: 'pattern', name: '图案纹理' },
  { id: 76, key: 'neckline', name: '领型' },
  { id: 77, key: 'sleeve', name: '袖型袖长' },
  { id: 78, key: 'length', name: '服装长度' },
  { id: 79, key: 'fit', name: '版型' },
  { id: 80, key: 'fabric', name: '材质面料' },
  { id: 81, key: 'style', name: '风格' },
  { id: 82, key: 'details', name: '细节装饰' },
  { id: 83, key: 'occasion', name: '适用场合' },
];

const esc = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/'/g, "''");
const clip = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n) : s; };
const arrJoin = (v) => (Array.isArray(v) ? v.join(',') : String(v ?? ''));

const src = JSON.parse(fs.readFileSync(SRC, 'utf8'));

// 收集唯一图片（reference + top10），仅保留有 name 的
const unique = new Map(); // key(category:image_name) -> { catKey, catName, catId, image_name, rec }
function collect(catKey, imageName, rec) {
  if (!imageName || !rec || typeof rec.name !== 'string') return;
  const key = catKey + ':' + imageName;
  if (unique.has(key)) return;
  const c = CATS[catKey];
  if (!c) return;
  unique.set(key, { catKey, catId: c.catId, catName: c.catName, image_name: imageName, rec });
}

for (const it of src.items) {
  const catKey = it.category;
  const c = CATS[catKey];
  if (!c) continue;
  if (it.reference && it.reference.name) collect(catKey, it.reference_name, it.reference);
  for (const t of it.top10 || []) {
    if (t.name) collect(catKey, t.image_name, t);
  }
}

// 校验图片文件存在性
const list = [...unique.values()].filter((u) => {
  const p = path.join(BASE, u.catKey, u.image_name + '.jpg');
  return fs.existsSync(p);
});

console.log(`unique_with_name=${unique.size} files_exist=${list.length}`);

const lines = [];
lines.push('SET NAMES utf8mb4;');

// 1) 删除旧数据
lines.push('-- 删除旧数据');
lines.push("DELETE FROM pms_sku_stock WHERE id >= 2000000;");
lines.push('DELETE FROM pms_product WHERE brand_id = 60;');

// 2) 属性分类 + 属性定义
lines.push('-- 属性分类与属性定义');
lines.push(`INSERT INTO pms_product_attribute_category (id,name,attribute_count,param_count) VALUES (${ATTR_CAT_ID},'${esc(ATTR_CAT_NAME)}',0,${ATTRS.length}) ON DUPLICATE KEY UPDATE name=VALUES(name),attribute_count=VALUES(attribute_count),param_count=VALUES(param_count);`);
for (const a of ATTRS) {
  // type=1商品参数（仅展示/检索，不参与SKU） select_type=1单选 input_type=0手动 filter/search=1
  lines.push(`INSERT INTO pms_product_attribute (id,product_attribute_category_id,name,select_type,input_type,input_list,sort,filter_type,search_type,related_status,hand_add_status,type) VALUES (${a.id},${ATTR_CAT_ID},'${esc(a.name)}',1,0,NULL,${a.id - 73},1,1,0,0,1) ON DUPLICATE KEY UPDATE name=VALUES(name),product_attribute_category_id=VALUES(product_attribute_category_id),type=VALUES(type);`);
}

// 3) 商品
const PROD_COLS = `(id,brand_id,product_category_id,feight_template_id,product_attribute_category_id,name,pic,product_sn,delete_status,publish_status,new_status,recommand_status,verify_status,sort,sale,price,promotion_price,gift_growth,gift_point,use_point_limit,sub_title,description,original_price,stock,low_stock,unit,weight,preview_status,service_ids,keywords,note,album_pics,detail_title,detail_desc,detail_html,detail_mobile_html,promotion_start_time,promotion_end_time,promotion_per_limit,promotion_type,brand_name,product_category_name)`;
const SKU_COLS = `(id,product_id,sku_code,price,stock,low_stock,pic,sale,promotion_price,lock_stock,sp_data)`;
const ATTRVAL_COLS = `(product_id,product_attribute_id,value)`;

const N = list.length;
const batch = 500;

// 商品
for (let i = 0; i < N; i += batch) {
  const rows = [];
  for (let j = i; j < Math.min(i + batch, N); j++) {
    const u = list[j];
    const pid = PRODUCT_BASE + j;
    const rec = u.rec;
    const sn = 'FZ' + pid;
    const pic = `http://localhost:8092/images/${u.catKey}/${u.image_name}.jpg`;
    const name = clip(rec.name, 190);
    const subTitle = clip(rec.sub_title, 250);
    const desc = clip(rec.description, 5000);
    const keywords = clip(arrJoin(rec.keywords), 250);
    const detailDesc = desc;
    rows.push(`(${pid},${BRAND_ID},${u.catId},NULL,${ATTR_CAT_ID},'${esc(name)}','${pic}','${sn}',0,1,0,0,1,0,0,${PRICE},NULL,0,0,NULL,'${esc(subTitle)}','${esc(desc)}',${PRICE},100,10,'件',0.00,0,NULL,'${esc(keywords)}',NULL,NULL,'${esc(name)}','${esc(detailDesc)}',NULL,NULL,NULL,NULL,NULL,0,'${BRAND_NAME}','${esc(u.catName)}')`);
  }
  lines.push(`INSERT INTO pms_product ${PROD_COLS} VALUES\n${rows.join(',\n')};`);
}

// SKU
for (let i = 0; i < N; i += batch) {
  const rows = [];
  for (let j = i; j < Math.min(i + batch, N); j++) {
    const u = list[j];
    const pid = PRODUCT_BASE + j;
    const skuId = SKU_BASE + j;
    const pic = `http://localhost:8092/images/${u.catKey}/${u.image_name}.jpg`;
    rows.push(`(${skuId},${pid},'SKU${pid}',${PRICE},100,10,'${pic}',0,NULL,0,'[]')`);
  }
  lines.push(`INSERT INTO pms_sku_stock ${SKU_COLS} VALUES\n${rows.join(',\n')};`);
}

// 属性值
for (let i = 0; i < N; i += batch) {
  const rows = [];
  for (let j = i; j < Math.min(i + batch, N); j++) {
    const u = list[j];
    const pid = PRODUCT_BASE + j;
    const rec = u.rec;
    for (const a of ATTRS) {
      const v = clip(arrJoin(rec[a.key]), 60);
      if (!v) continue;
      rows.push(`(${pid},${a.id},'${esc(v)}')`);
    }
  }
  if (rows.length) lines.push(`INSERT INTO pms_product_attribute_value ${ATTRVAL_COLS} VALUES\n${rows.join(',\n')};`);
}

// 自增
lines.push(`ALTER TABLE pms_product AUTO_INCREMENT = ${PRODUCT_BASE + N + 10000};`);
lines.push(`ALTER TABLE pms_sku_stock AUTO_INCREMENT = ${SKU_BASE + N + 10000};`);

fs.writeFileSync(OUT, lines.join('\n'), 'utf8');

// 统计分类分布
const by = {};
for (const u of list) by[u.catName] = (by[u.catName] || 0) + 1;
console.log('products to import:', N, JSON.stringify(by));
console.log('written ->', OUT);