"""Command line interface for standalone FashionIQ retrieval."""

import argparse
import json
import os

from .core import DEFAULT_INDEX_DIR, DEFAULT_WEIGHTS, FashionIQRetriever, build_index


def parser():
    root = argparse.ArgumentParser(description="OSCIR FashionIQ retrieval on mall products")
    commands = root.add_subparsers(dest="command", required=True)

    index = commands.add_parser("index", help="Encode published mall FashionIQ product images")
    index.add_argument("--image-root", default=os.environ.get("FASHIONIQ_IMAGE_ROOT", "D:/dataset/fashioniq"))
    index.add_argument("--index-dir", default=str(DEFAULT_INDEX_DIR))
    index.add_argument("--weights", default=os.environ.get("OSRCIR_CLIP_WEIGHTS", str(DEFAULT_WEIGHTS)))
    index.add_argument("--device", choices=["auto", "cpu", "cuda"], default="auto")
    index.add_argument("--batch-size", type=int, default=2)
    index.add_argument("--catalog-file", help="Optional JSON array with id and pic fields")
    index.add_argument("--mysql-container", default="mall-mysql")

    search = commands.add_parser("search", help="Search by reference image and modification text")
    search.add_argument("--index-dir", default=str(DEFAULT_INDEX_DIR))
    search.add_argument("--weights", help="Override the weights path saved in the index")
    search.add_argument("--device", choices=["auto", "cpu", "cuda"], default="auto")
    reference = search.add_mutually_exclusive_group(required=True)
    reference.add_argument("--reference-image")
    reference.add_argument("--reference-product-id", type=int)
    search.add_argument("--text", default="", help="FashionIQ modification text")
    search.add_argument("--target-description", help="Prepared OSCIR description; skips vision API")
    search.add_argument("--category", choices=["dress", "shirt", "toptee"])
    search.add_argument("--top-k", type=int, default=10)
    search.add_argument("--exclude-reference", action="store_true")
    search.add_argument("--vision-provider", choices=["ollama", "openai"], default="ollama")
    search.add_argument("--vision-model")
    search.add_argument("--vision-endpoint")
    search.add_argument("--branch-top-k", type=int, default=100)
    search.add_argument("--rrf-k", type=int, default=60)
    search.add_argument("--weight-reference", type=float, default=0.25)
    search.add_argument("--weight-modification", type=float, default=0.15)
    search.add_argument("--weight-target", type=float, default=0.60)

    evaluate = commands.add_parser("evaluate", help="Evaluate saved OSCIR descriptions on indexed products")
    evaluate.add_argument("--index-dir", default=str(DEFAULT_INDEX_DIR))
    evaluate.add_argument("--weights")
    evaluate.add_argument("--device", choices=["auto", "cpu", "cuda"], default="auto")
    evaluate.add_argument("--progress-file", required=True)
    evaluate.add_argument("--category", choices=["dress", "shirt", "toptee"], required=True)
    evaluate.add_argument("--limit", type=int)
    return root


def main():
    args = parser().parse_args()
    if args.command == "index":
        result = build_index(
            args.image_root, args.index_dir, args.weights, args.batch_size,
            args.device, args.catalog_file, args.mysql_container
        )
    elif args.command == "search":
        if not args.text.strip():
            raise ValueError("--text is required for the modification retrieval route")
        retriever = FashionIQRetriever(args.index_dir, args.weights, args.device)
        result = retriever.search(
            args.text, args.reference_image, args.reference_product_id,
            args.target_description, args.category, args.top_k,
            (args.exclude_reference or args.reference_product_id is not None),
            args.vision_provider, args.vision_model,
            args.vision_endpoint,
            fusion_weights={
                "reference": args.weight_reference,
                "modification": args.weight_modification,
                "target": args.weight_target,
            },
            branch_top_k=args.branch_top_k,
            rrf_k=args.rrf_k,
        )
    elif args.command == "evaluate":
        retriever = FashionIQRetriever(args.index_dir, args.weights, args.device)
        result = retriever.evaluate_progress(args.progress_file, args.category, args.limit)
    else:
        raise AssertionError(args.command)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

