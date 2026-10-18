import fs from 'fs';
import path from 'path';

const SPLITS = 'D:/dataset/fashioniq/image_splits';
const BASE = 'D:/dataset/fashioniq';
const OUT = 'D:/mall/import-products.sql';

const BRAND_ID = 60;
const BRAND_NAME = '自营';
const DRESS_CAT_ID = 56;

// 分类映射： dress -> 连衣裙(新建56)  shirt -> 衬衫(11)  toptee -> T恤(8)
const CATS = [
  { key: 'dress',  catId: DRESS_CAT_ID, catName: '连衣裙' },
  { key: 'shirt',  catId: 11,           catName: '衬衫' },
  { key: 'toptee', catId: 8,            catName: 'T恤' },
];

const PRICE = '99.00';
const PRODUCT_BASE = 100000;
const SKU_BASE = 2000000;

const esc = (s) => String(s).replace(/'/g, "''");

// 收集验证集图片（文件存在才收录）
const items = [];
for (const c of CATS) {
  const valFile = path.join(SPLITS, `split.${c.key}.val.json`);
  const ids = JSON.parse(fs.readFileSync(valFile, 'utf8'));
  const dir = path.join(BASE, c.key);
  for (const id of ids) {
    if (fs.existsSync(path.join(dir, id + '.jpg'))) {
      items.push({ id, folder: c.key, catId: c.catId, catName: c.catName });
    }
  }
}

const lines = [];
lines.push('SET NAMES utf8mb4;');

// 品牌 + 连衣裙分类
lines.push(`INSERT INTO pms_brand (id,name,first_letter,sort,factory_status,show_status) VALUES (${BRAND_ID},'${BRAND_NAME}','Z',0,0,1) ON DUPLICATE KEY UPDATE name=VALUES(name);`);
lines.push(`INSERT INTO pms_product_category (id,parent_id,name,level,product_count,product_unit,nav_status,show_status,sort) VALUES (${DRESS_CAT_ID},1,'连衣裙',1,0,'件',1,1,0) ON DUPLICATE KEY UPDATE name=VALUES(name);`);

const PROD_COLS = `(id,brand_id,product_category_id,feight_template_id,product_attribute_category_id,name,pic,product_sn,delete_status,publish_status,new_status,recommand_status,verify_status,sort,sale,price,promotion_price,gift_growth,gift_point,use_point_limit,sub_title,description,original_price,stock,low_stock,unit,weight,preview_status,service_ids,keywords,note,album_pics,detail_title,detail_desc,detail_html,detail_mobile_html,promotion_start_time,promotion_end_time,promotion_per_limit,promotion_type,brand_name,product_category_name)`;

const SKU_COLS = `(id,product_id,sku_code,price,stock,low_stock,pic,sale,promotion_price,lock_stock,sp_data)`;

const batch = 500;

// 商品
for (let i = 0; i < items.length; i += batch) {
  const rows = [];
  for (let j = i; j < Math.min(i + batch, items.length); j++) {
    const it = items[j];
    const pid = PRODUCT_BASE + j;
    const sn = 'FZ' + pid;
    const pic = `http://localhost:8092/images/${it.folder}/${it.id}.jpg`;
    const name = esc(it.id);
    rows.push(`(${pid},${BRAND_ID},${it.catId},NULL,1,'${name}','${pic}','${sn}',0,1,0,0,1,0,0,${PRICE},NULL,0,0,NULL,'${name}',NULL,${PRICE},100,10,'件',0.00,0,NULL,'${name}',NULL,NULL,'${name}',NULL,NULL,NULL,NULL,NULL,NULL,0,'${BRAND_NAME}','${esc(it.catName)}')`);
  }
  lines.push(`INSERT INTO pms_product ${PROD_COLS} VALUES\n${rows.join(',\n')};`);
}

// SKU
for (let i = 0; i < items.length; i += batch) {
  const rows = [];
  for (let j = i; j < Math.min(i + batch, items.length); j++) {
    const it = items[j];
    const pid = PRODUCT_BASE + j;
    const skuId = SKU_BASE + j;
    const pic = `http://localhost:8092/images/${it.folder}/${it.id}.jpg`;
    rows.push(`(${skuId},${pid},'SKU${pid}',${PRICE},100,10,'${pic}',0,NULL,0,'[]')`);
  }
  lines.push(`INSERT INTO pms_sku_stock ${SKU_COLS} VALUES\n${rows.join(',\n')};`);
}

lines.push(`ALTER TABLE pms_product AUTO_INCREMENT = ${PRODUCT_BASE + items.length + 10000};`);
lines.push(`ALTER TABLE pms_sku_stock AUTO_INCREMENT = ${SKU_BASE + items.length + 10000};`);

fs.writeFileSync(OUT, lines.join('\n'), 'utf8');

console.log(`total val = ${items.length}`);
const by = {};
for (const it of items) by[it.folder] = (by[it.folder] || 0) + 1;
console.log('by category:', JSON.stringify(by));
console.log('written ->', OUT);