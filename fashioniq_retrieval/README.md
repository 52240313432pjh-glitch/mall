# FashionIQ 三路图文检索

商城接入参考 OSCIR 的目标描述任务，使用中文提示词和 LAION OpenCLIP ViT-G/14（laion2B-s34B-b88K）。
当前商城检索按三路独立召回：参考图片、修改文本、视觉模型生成的目标图片描述。
原 FashionIQ_demo.py 评测脚本使用目标描述单路；三路去重融合是本商城按需求增加的策略。

商品候选来自已导入 Mall MySQL 的 FashionIQ 图片，当前索引在
D:/mall/fashioniq_retrieval/index_vitg。模型权重和向量索引被 Git 忽略；旧 ViT-L 索引保留在 index 目录。

## 检索过程

1. CLIP 将每张已导入商品图编码为归一化向量；索引保存商品 ID、分类和图片向量。
2. 用户上传参考图，输入修改文本。Ollama 的 gemma3:12b 按中文提示词生成英文检索描述和中文展示描述。
3. 英文目标描述编码为 CLIP 向量用于目标描述召回；中文描述随检索结果返回给 Portal 并展示给用户。
4. 参考图向量、修改文本向量、英文目标描述向量分别与商品图库计算余弦相似度，各取前 100。
5. 按商品 ID 合并三路候选，去重后使用加权倒数名次融合（RRF，k=60）重新排序：
   综合分 = Σ 权重 × (61 / (60 + 该路名次))。
   默认权重：参考图 0.25、修改文本 0.15、目标描述 0.60。
   某商品未进入某一路的前 100，则该路贡献为 0。
5. 排除参考商品，按用户选择的 dress、shirt 或 toptee 类别筛选。
   Portal 再查询 MySQL，只返回当前上架且未删除的商品。

三路 CLIP 相似度的分布不同，因此融合使用名次而非直接相加余弦分数。
页面展示的是融合得分和各路名次，不把得分解释为匹配概率。

## 建立索引

需要 Docker MySQL 和本地 FashionIQ 图片。PowerShell 示例：

    cd D:/mall
    & 'D:/Anaconda3/envs/osrcir/python.exe' -m fashioniq_retrieval index

默认图片目录为 D:/dataset/fashioniq，ViT-G safetensors 权重默认读取
D:/hf_cache/hub/models--laion--CLIP-ViT-g-14-laion2B-s34B-b88K。可设置 OSRCIR_CLIP_WEIGHTS 指定其他权重。
商品或图片变化后应重新建索引并重启服务。ViT-G 建索引默认按 2 张一批计算，可用 --batch-size 调整。

## 启动服务

先启动本机 Ollama，确保 gemma3:12b 模型可用。另开 PowerShell：

    cd D:/mall
    & 'D:/Anaconda3/envs/osrcir/python.exe' -m fashioniq_retrieval.service --host 0.0.0.0 --port 8765

GET http://localhost:8765/health 返回 ready=true 表示检索服务已加载索引。
商城 Portal 通过 host.docker.internal:8765 访问 Python 服务。
商城搜索页上传服饰图片并输入修改文字后，会调用 Portal 的
POST /product/visualSearch。上传图片最大 5 MB、文字最多 500 字。

## 调整权重

服务启动前可设置 FASHIONIQ_WEIGHT_REFERENCE、FASHIONIQ_WEIGHT_MODIFICATION、
FASHIONIQ_WEIGHT_TARGET；服务会将三个非负权重归一化。可设置
FASHIONIQ_BRANCH_TOP_K（默认 100）和 FASHIONIQ_RRF_K（默认 60）。
修改这些配置后重启 Python 服务。健康接口返回实际生效的权重。

默认视觉模型为 gemma3:12b，可通过 OSRCIR_VISION_MODEL 更改。
也支持 FASHIONIQ_VISION_PROVIDER=openai，并配置
OSRCIR_VISION_URL、OSRCIR_VISION_MODEL 和 OSRCIR_VISION_API_KEY。
若设置 FASHIONIQ_SERVICE_TOKEN，Portal 需设置同名环境变量。

CLI 示例：

    & 'D:/Anaconda3/envs/osrcir/python.exe' -m fashioniq_retrieval search --reference-product-id 100000 --text 'make it shorter and black' --top-k 10

CLI 可用 --target-description 传入已生成的描述，跳过视觉模型调用；
仍执行完整三路召回和融合。可用 --weight-reference、--weight-modification、
--weight-target、--branch-top-k、--rrf-k 临时调整参数。

OSCIR 来源：D:/oscir/osrcir-master/src/FashionIQ_demo.py、prompts.py。
OpenAI CLIP 许可见 fashioniq_retrieval/clip/LICENSE。
