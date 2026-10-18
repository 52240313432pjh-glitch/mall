import fs from 'fs';
import path from 'path';

const BASE = 'D:/dataset/fashioniq';
const SPLITS = path.join(BASE, 'image_splits');
const IMAGES = path.join(BASE, 'images');
const OUT = 'D:/mall/import-440.sql';

const BRAND_ID = 60;
const BRAND_NAME = '自营';
const CATS = [
  { key: 'dress', catId: 56, catName: '连衣裙' },
  { key: 'shirt', catId: 11, catName: '衬衫' },
  { key: 'toptee', catId: 8, catName: 'T恤' },
];
const PRICE = '99.00';
const PRODUCT_START = 115096;
const SKU_START = 2015096;

const esc = (s) => String(s).replace(/'/g, "''");

// images/ 目录：小写基名 -> 真实文件名
const imgByLower = new Map();
for (const f of fs.readdirSync(IMAGES)) {
  const base = path.basename(f, path.extname(f));
  imgByLower.set(base.toLowerCase(), f);
}

const items = [];
// 1) 把缺失的图从 images/ 复制到对应分类文件夹，命名为 .jpg
for (const c of CATS) {
  const dir = path.join(BASE, c.key);
  const val = JSON.parse(fs.readFileSync(path.join(SPLITS, `split.${c.key}.val.json`), 'utf8'));
  for (const id of val) {
    const jpg = path.join(dir, id + '.jpg');
    if (fs.existsSync(jpg)) continue;
    const srcName = imgByLower.get(id.toLowerCase());
    if (!srcName) continue;
    fs.copyFileSync(path.join(IMAGES, srcName), jpg);
    items.push({ id, folder: c.key, catId: c.catId, catName: c.catName });
  }
}

// 2) 生成追加 SQL（沿用与 generate-import.mjs 相同的列定义与值顺序）
const PROD_COLS = `(id,brand_id,product_category_id,feight_template_id,product_attribute_category_id,name,pic,product_sn,delete_status,publish_status,new_status,recommand_status,verify_status,sort,sale,price,promotion_price,gift_growth,gift_point,use_point_limit,sub_title,description,original_price,stock,low_stock,unit,weight,preview_status,service_ids,keywords,note,album_pics,detail_title,detail_desc,detail_html,detail_mobile_html,promotion_start_time,promotion_end_time,promotion_per_limit,promotion_type,brand_name,product_category_name)`;
const SKU_COLS = `(id,product_id,sku_code,price,stock,low_stock,pic,sale,promotion_price,lock_stock,sp_data)`;

const lines = ['SET NAMES utf8mb4;'];

const prodRows = items.map((it, j) => {
  const pid = PRODUCT_START + j;
  const sn = 'FZ' + pid;
  const pic = `http://localhost:8092/images/${it.folder}/${it.id}.jpg`;
  const name = esc(it.id);
  return `(${pid},${BRAND_ID},${it.catId},NULL,1,'${name}','${pic}','${sn}',0,1,0,0,1,0,0,${PRICE},NULL,0,0,NULL,'${name}',NULL,${PRICE},100,10,'件',0.00,0,NULL,'${name}',NULL,NULL,'${name}',NULL,NULL,NULL,NULL,NULL,NULL,0,'${BRAND_NAME}','${esc(it.catName)}')`;
});
lines.push(`INSERT INTO pms_product ${PROD_COLS} VALUES\n${prodRows.join(',\n')};`);

const skuRows = items.map((it, j) => {
  const pid = PRODUCT_START + j;
  const skuId = SKU_START + j;
  const pic = `http://localhost:8092/images/${it.folder}/${it.id}.jpg`;
  return `(${skuId},${pid},'SKU${pid}',${PRICE},100,10,'${pic}',0,NULL,0,'[]')`;
});
lines.push(`INSERT INTO pms_sku_stock ${SKU_COLS} VALUES\n${skuRows.join(',\n')};`);

fs.writeFileSync(OUT, lines.join('\n'), 'utf8');

const by = {};
for (const it of items) by[it.folder] = (by[it.folder] || 0) + 1;
console.log('copied + appended:', items.length, JSON.stringify(by));
console.log('written ->', OUT);