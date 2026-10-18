"""Small local HTTP adapter around the resident FashionIQ retriever."""

import argparse
import base64
import binascii
import json
import os
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from PIL import Image, UnidentifiedImageError

from .core import (DEFAULT_INDEX_DIR, DEFAULT_FUSION_WEIGHTS, FashionIQRetriever,
                   normalize_fusion_weights)

MAX_IMAGE_BYTES = 5 * 1024 * 1024
MAX_REQUEST_BYTES = 7 * 1024 * 1024


def serve(host="127.0.0.1", port=8765, index_dir=DEFAULT_INDEX_DIR,
          weights=None, device="auto"):
    retriever = FashionIQRetriever(index_dir, weights, device)
    inference_lock = threading.Lock()
    token = os.environ.get("FASHIONIQ_SERVICE_TOKEN", "")
    provider = os.environ.get("FASHIONIQ_VISION_PROVIDER", "ollama")
    fusion_weights = normalize_fusion_weights({
        "reference": os.environ.get("FASHIONIQ_WEIGHT_REFERENCE", DEFAULT_FUSION_WEIGHTS["reference"]),
        "modification": os.environ.get("FASHIONIQ_WEIGHT_MODIFICATION", DEFAULT_FUSION_WEIGHTS["modification"]),
        "target": os.environ.get("FASHIONIQ_WEIGHT_TARGET", DEFAULT_FUSION_WEIGHTS["target"]),
    })
    branch_top_k = int(os.environ.get("FASHIONIQ_BRANCH_TOP_K", "100"))
    rrf_k = int(os.environ.get("FASHIONIQ_RRF_K", "60"))
    if branch_top_k < 1 or rrf_k < 1:
        raise ValueError("FASHIONIQ_BRANCH_TOP_K and FASHIONIQ_RRF_K must be positive")

    class Handler(BaseHTTPRequestHandler):
        def send_json(self, status, data):
            body = json.dumps(data, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if self.path == "/live":
                self.send_json(200, {"alive": True})
            elif self.path == "/health":
                self.send_json(200, {"ready": True, "indexed": len(retriever.items),
                                     "mode": "fusion", "fusion_weights": fusion_weights,
                                     "branch_top_k": branch_top_k, "rrf_k": rrf_k})
            else:
                self.send_json(404, {"error": "Not found"})

        def read_body(self):
            if self.headers.get("Transfer-Encoding", "").lower() == "chunked":
                chunks = []
                total = 0
                while True:
                    line = self.rfile.readline(64)
                    try:
                        size = int(line.split(b";", 1)[0].strip(), 16)
                    except ValueError as exc:
                        raise ValueError("Invalid chunked request") from exc
                    if size == 0:
                        while self.rfile.readline(8192).strip():
                            pass
                        break
                    total += size
                    if total > MAX_REQUEST_BYTES:
                        raise ValueError("Request body exceeds 7 MB")
                    part = self.rfile.read(size)
                    if len(part) != size or self.rfile.read(2) != b"\r\n":
                        raise ValueError("Incomplete chunked request")
                    chunks.append(part)
                return b"".join(chunks)
            size = int(self.headers.get("Content-Length", "0"))
            if size <= 0 or size > MAX_REQUEST_BYTES:
                raise ValueError("Request body must be between 1 byte and 7 MB")
            return self.rfile.read(size)

        def do_POST(self):
            if self.path != "/search":
                self.send_json(404, {"error": "Not found"})
                return
            if token and self.headers.get("X-Service-Token") != token:
                self.send_json(401, {"error": "Unauthorized"})
                return
            try:
                request = json.loads(self.read_body().decode("utf-8"))
                if not isinstance(request, dict):
                    raise ValueError("Request body must be a JSON object")
                modification = request.get("modification", "")
                if not isinstance(modification, str) or not modification.strip() or len(modification) > 500:
                    raise ValueError("Modification must contain 1 to 500 characters")
                top_k = request.get("top_k", 10)
                if isinstance(top_k, bool) or not isinstance(top_k, int) or not 1 <= top_k <= 50:
                    raise ValueError("top_k must be between 1 and 50")
                mode = request.get("mode", "fusion")
                if mode != "fusion":
                    raise ValueError("mode must be fusion")
                category = request.get("category") or None
                if category not in (None, "dress", "shirt", "toptee"):
                    raise ValueError("Unknown FashionIQ category")
                image_data = request.get("image_base64")
                reference_id = request.get("reference_product_id")
                if bool(image_data) == (reference_id is not None):
                    raise ValueError("Provide exactly one reference image or product ID")
                image_path = None
                try:
                    if image_data:
                        if not isinstance(image_data, str):
                            raise ValueError("image_base64 must be a string")
                        try:
                            raw = base64.b64decode(image_data, validate=True)
                        except (binascii.Error, ValueError) as exc:
                            raise ValueError("Invalid base64 image") from exc
                        if not raw or len(raw) > MAX_IMAGE_BYTES:
                            raise ValueError("Image must be between 1 byte and 5 MB")
                        with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as tmp:
                            tmp.write(raw)
                            image_path = Path(tmp.name)
                        try:
                            with Image.open(image_path) as image:
                                if image.format not in ("JPEG", "PNG", "WEBP") or image.width * image.height > 20_000_000:
                                    raise ValueError("Image must be JPEG, PNG or WebP under 20 megapixels")
                                image.verify()
                        except (UnidentifiedImageError, OSError) as exc:
                            raise ValueError("Invalid image file") from exc
                    with inference_lock:
                        result = retriever.search(
                            modification, reference_image=str(image_path) if image_path else None,
                            reference_product_id=reference_id, category=category,
                            top_k=top_k, exclude_reference=reference_id is not None,
                            provider=provider, mode=mode,
                            fusion_weights=fusion_weights,
                            branch_top_k=branch_top_k, rrf_k=rrf_k)
                    result.pop("reference_image", None)
                    self.send_json(200, result)
                finally:
                    if image_path:
                        image_path.unlink(missing_ok=True)
            except ValueError as exc:
                self.send_json(400, {"error": str(exc)})
            except Exception as exc:
                self.log_error("Search failed: %s", exc)
                self.send_json(503, {"error": "Retrieval service or vision provider unavailable"})

    server = ThreadingHTTPServer((host, port), Handler)
    print("FashionIQ ready on {}:{} with {} products".format(host, port, len(retriever.items)), flush=True)
    server.serve_forever()


def main():
    parser = argparse.ArgumentParser(description="FashionIQ local retrieval service")
    parser.add_argument("--host", default=os.environ.get("FASHIONIQ_SERVICE_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("FASHIONIQ_SERVICE_PORT", "8765")))
    parser.add_argument("--index-dir", default=str(DEFAULT_INDEX_DIR))
    parser.add_argument("--weights")
    parser.add_argument("--device", choices=("auto", "cpu", "cuda"), default="auto")
    args = parser.parse_args()
    serve(args.host, args.port, args.index_dir, args.weights, args.device)


if __name__ == "__main__":
    main()
