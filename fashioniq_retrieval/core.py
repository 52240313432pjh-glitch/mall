"""FashionIQ three-route retrieval with OSCIR target text and CLIP rankings."""

import json
from pathlib import Path

import numpy as np
from PIL import Image

from .catalog import load_catalog
from .vision import describe_target

DEFAULT_INDEX_DIR = Path(__file__).resolve().parent / "index"
DEFAULT_WEIGHTS = Path(__file__).resolve().parent / "models" / "ViT-L-14.pt"
DEFAULT_FUSION_WEIGHTS = {"reference": 0.25, "modification": 0.15, "target": 0.60}
DEFAULT_BRANCH_TOP_K = 100
DEFAULT_RRF_K = 60


def _device(requested):
    import torch

    if requested == "auto":
        return "cuda" if torch.cuda.is_available() else "cpu"
    if requested == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("CUDA was requested but is unavailable")
    return requested


def _load_clip(weights, device):
    from .clip import load

    if not Path(weights).is_file() and weights not in (
        "ViT-B/32", "ViT-B/16", "ViT-L/14", "ViT-L/14@336px"
    ):
        raise FileNotFoundError("CLIP weights not found: " + weights)
    model, preprocess = load(weights, device=device, jit=False)
    model.eval()
    return model, preprocess


def _encode_images(model, tensors, device):
    import torch

    with torch.no_grad():
        batch = torch.stack(tensors).to(device)
        features = model.encode_image(batch).float()
        features = torch.nn.functional.normalize(features, dim=-1)
    return features.cpu().numpy()


def build_index(
    image_root, index_dir=DEFAULT_INDEX_DIR, weights=str(DEFAULT_WEIGHTS),
    batch_size=16, device="auto", catalog_file=None, mysql_container="mall-mysql"
):
    """Index only FashionIQ images whose products are published in mall MySQL."""
    if batch_size < 1:
        raise ValueError("batch_size must be positive")
    items, skipped = load_catalog(image_root, catalog_file, mysql_container)
    device = _device(device)
    model, preprocess = _load_clip(str(weights), device)
    index_dir = Path(index_dir)
    index_dir.mkdir(parents=True, exist_ok=True)
    vectors = []
    indexed_items = []
    tensors = []
    pending_items = []

    def flush():
        if tensors:
            vectors.append(_encode_images(model, tensors, device))
            indexed_items.extend(pending_items)
            tensors.clear()
            pending_items.clear()

    for item in items:
        try:
            with Image.open(item["image_path"]) as image:
                tensors.append(preprocess(image.convert("RGB")))
            pending_items.append(item)
        except (OSError, ValueError) as exc:
            skipped += 1
            print("Skipped unreadable image {}: {}".format(item["image_path"], exc))
            continue
        if len(tensors) >= batch_size:
            flush()
            print("Indexed {}/{} products".format(len(indexed_items), len(items)))
    flush()
    if not vectors:
        raise ValueError("No images could be encoded")
    matrix = np.concatenate(vectors, axis=0).astype(np.float32)
    np.save(index_dir / "vectors.npy", matrix, allow_pickle=False)
    manifest = {
        "schema_version": 1,
        "weights": str(weights),
        "dimension": int(matrix.shape[1]),
        "count": len(indexed_items),
        "skipped": skipped,
        "items": indexed_items,
    }
    (index_dir / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return {"indexed": len(indexed_items), "skipped": skipped, "index_dir": str(index_dir)}


def load_index(index_dir):
    index_dir = Path(index_dir)
    manifest = json.loads((index_dir / "manifest.json").read_text(encoding="utf-8"))
    if manifest.get("schema_version") != 1:
        raise ValueError("Unsupported index version")
    vectors = np.load(index_dir / "vectors.npy", allow_pickle=False)
    if vectors.ndim != 2 or vectors.shape[0] != len(manifest["items"]):
        raise ValueError("Index vectors and catalog manifest have different lengths")
    return manifest, vectors


def rank_products(vectors, items, query_vector, top_k=10, category=None, exclude_id=None):
    """Return ranked products using OSCIR's normalized CLIP cosine similarity."""
    if top_k < 1:
        raise ValueError("top_k must be positive")
    query = np.asarray(query_vector, dtype=np.float32).reshape(-1)
    if vectors.shape[1] != query.shape[0]:
        raise ValueError("Query and index embedding dimensions differ")
    norm = float(np.linalg.norm(query))
    if norm == 0 or not np.isfinite(norm):
        raise ValueError("Query embedding has zero or invalid length")
    scores = vectors @ (query / norm)
    eligible = np.asarray([
        (category is None or item["category"] == category)
        and (exclude_id is None or item["product_id"] != exclude_id)
        for item in items
    ], dtype=bool)
    positions = np.flatnonzero(eligible)
    order = positions[np.argsort(-scores[positions], kind="stable")[:top_k]]
    return [
        {
            "product_id": items[int(pos)]["product_id"],
            "category": items[int(pos)]["category"],
            "image_name": items[int(pos)]["image_name"],
            "image_url": items[int(pos)]["image_url"],
            "similarity": float(scores[pos]),
        }
        for pos in order
    ]


def normalize_fusion_weights(weights=None):
    """Validate and normalize the three retrieval-route weights."""
    supplied = DEFAULT_FUSION_WEIGHTS if weights is None else weights
    if set(supplied) != set(DEFAULT_FUSION_WEIGHTS):
        raise ValueError("Fusion weights must define reference, modification and target")
    values = {key: float(supplied[key]) for key in DEFAULT_FUSION_WEIGHTS}
    if any(not np.isfinite(value) or value < 0 for value in values.values()):
        raise ValueError("Fusion weights must be finite and non-negative")
    total = sum(values.values())
    if total <= 0:
        raise ValueError("At least one fusion weight must be positive")
    return {key: value / total for key, value in values.items()}


def fuse_ranked_products(branches, weights, top_k, rrf_k=DEFAULT_RRF_K):
    """Deduplicate three candidate lists by product ID and apply weighted RRF.

    Each branch uses its own CLIP similarity ranking. RRF combines ranks rather
    than incomparable image-image and text-image cosine score scales.
    """
    if rrf_k < 1:
        raise ValueError("rrf_k must be positive")
    weights = normalize_fusion_weights(weights)
    merged = {}
    for branch in ("reference", "modification", "target"):
        for rank, hit in enumerate(branches[branch], start=1):
            product_id = hit["product_id"]
            entry = merged.setdefault(product_id, {
                "product_id": product_id,
                "category": hit["category"],
                "image_name": hit["image_name"],
                "image_url": hit["image_url"],
                "fusion_score": 0.0,
                "branch_ranks": {},
                "branch_similarities": {},
            })
            if branch in entry["branch_ranks"]:
                continue
            entry["branch_ranks"][branch] = rank
            entry["branch_similarities"][branch] = hit["similarity"]
            entry["fusion_score"] += weights[branch] * (rrf_k + 1) / (rrf_k + rank)
    results = sorted(
        merged.values(),
        key=lambda hit: (
            -hit["fusion_score"],
            -hit["branch_similarities"].get("target", -1),
            hit["product_id"],
        ),
    )
    return results[:top_k]


class FashionIQRetriever:
    """Resident CLIP retrieval over imported FashionIQ products."""

    def __init__(self, index_dir=DEFAULT_INDEX_DIR, weights=None, device="auto"):
        self.manifest, self.vectors = load_index(index_dir)
        self.items = self.manifest["items"]
        self.device = _device(device)
        self.weights = str(weights or self.manifest["weights"])
        self.model, self.preprocess = _load_clip(self.weights, self.device)
        self.by_product_id = {item["product_id"]: item for item in self.items}

    def encode_texts(self, descriptions):
        import torch
        from .clip import tokenize

        if not descriptions:
            return np.empty((0, self.vectors.shape[1]), dtype=np.float32)
        vectors = []
        with torch.no_grad():
            for start in range(0, len(descriptions), 64):
                tokens = tokenize(descriptions[start:start + 64], truncate=True).to(self.device)
                embeddings = self.model.encode_text(tokens).float()
                embeddings = torch.nn.functional.normalize(embeddings, dim=-1)
                vectors.append(embeddings.cpu().numpy())
        return np.concatenate(vectors, axis=0)

    def encode_image(self, image_path):
        with Image.open(image_path) as image:
            tensor = self.preprocess(image.convert("RGB"))
        return _encode_images(self.model, [tensor], self.device)[0]

    def search(
        self, modification, reference_image=None, reference_product_id=None,
        target_description=None, category=None, top_k=10, exclude_reference=True,
        provider="ollama", vision_model=None, vision_endpoint=None,
        mode="fusion", fusion_weights=None, branch_top_k=DEFAULT_BRANCH_TOP_K,
        rrf_k=DEFAULT_RRF_K
    ):
        if reference_product_id is not None:
            reference = self.by_product_id.get(int(reference_product_id))
            if reference is None:
                raise ValueError("Reference product is not in the index")
            reference_image = reference["image_path"]
            if category is None:
                category = reference["category"]
        if not reference_image:
            raise ValueError("Provide a reference image or product ID")
        if not modification or not modification.strip():
            raise ValueError("Modification text must not be empty")
        if category is not None and category not in ("dress", "shirt", "toptee"):
            raise ValueError("Unknown FashionIQ category")
        if mode != "fusion":
            raise ValueError("mode must be fusion")
        if top_k < 1 or branch_top_k < 1 or rrf_k < 1:
            raise ValueError("Result counts and rrf_k must be positive")

        weights = normalize_fusion_weights(fusion_weights)
        reference_vector = self.encode_image(reference_image)
        text_vector = self.encode_texts([modification.strip()])[0]
        description = target_description or describe_target(
            reference_image, modification, provider, vision_model, vision_endpoint
        )
        target_vector = self.encode_texts([description])[0]

        # Exclude a known reference product, or an uploaded image that is an
        # exact match for an indexed product, from all three candidate lists.
        exclude_id = int(reference_product_id) if exclude_reference and reference_product_id else None
        if exclude_id is None:
            image_scores = self.vectors @ reference_vector
            closest = int(np.argmax(image_scores))
            if image_scores[closest] >= 0.995:
                exclude_id = self.items[closest]["product_id"]

        candidate_count = min(len(self.items), max(top_k, branch_top_k))
        branches = {
            "reference": rank_products(self.vectors, self.items, reference_vector,
                                       candidate_count, category, exclude_id),
            "modification": rank_products(self.vectors, self.items, text_vector,
                                          candidate_count, category, exclude_id),
            "target": rank_products(self.vectors, self.items, target_vector,
                                    candidate_count, category, exclude_id),
        }
        results = fuse_ranked_products(branches, weights, top_k, rrf_k)
        return {
            "reference_image": str(reference_image),
            "modification": modification,
            "target_description": description,
            "mode": "fusion",
            "category": category,
            "fusion_method": "weighted_rrf",
            "fusion_weights": weights,
            "branch_top_k": candidate_count,
            "rrf_k": rrf_k,
            "results": results,
        }

    def evaluate_progress(self, progress_file, category, limit=None):
        """Evaluate OSCIR's saved FashionIQ target descriptions on imported products.

        Coverage may be partial because mall contains a subset of FashionIQ.
        """
        progress = json.loads(Path(progress_file).read_text(encoding="utf-8"))
        descriptions = progress["all_captions"]
        targets = progress.get("target_names")
        if targets is None:
            pairids = progress.get("pairids")
            if pairids is None:
                pairids = [record.get("pairid", "") for record in progress.get("records", [])]
            targets = [str(pairid).rsplit(":", 1)[-1] for pairid in pairids]
        total = min(len(descriptions), len(targets))
        if limit is not None:
            total = min(total, limit)
        known = {
            item["image_name"] for item in self.items if item["category"] == category
        }
        selected = [
            (descriptions[i], Path(str(targets[i])).stem)
            for i in range(total)
            if Path(str(targets[i])).stem in known and descriptions[i]
        ]
        if not selected:
            raise ValueError("No saved queries have targets in this product index")
        queries = self.encode_texts([pair[0] for pair in selected])
        counts = {1: 0, 5: 0, 10: 0, 50: 0}
        for query, (_, target) in zip(queries, selected):
            ranked = rank_products(self.vectors, self.items, query, 50, category)
            names = [item["image_name"] for item in ranked]
            for k in counts:
                counts[k] += target in names[:k]
        return {
            "total_queries": total,
            "covered_queries": len(selected),
            "coverage": len(selected) / total if total else 0,
            "recall_on_covered_queries": {
                "R@{}".format(k): counts[k] / len(selected) for k in counts
            },
        }


