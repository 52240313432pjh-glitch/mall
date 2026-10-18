"""Read the FashionIQ products already present in the running mall database."""

import json
import os
import re
import subprocess
from pathlib import Path
from urllib.parse import urlparse

_IMAGE_URL = re.compile(r"^/images/(dress|shirt|toptee)/([A-Za-z0-9_-]+)\.(jpg|jpeg|png)$", re.I)
_SQL = (
    "SELECT id,pic FROM pms_product "
    "WHERE brand_id=60 AND delete_status=0 AND publish_status=1 AND pic IS NOT NULL "
    "ORDER BY id"
)


def item_from_row(product_id, image_url, image_root):
    """Map pms_product.pic to a local FashionIQ image without trusting URL paths."""
    match = _IMAGE_URL.fullmatch(urlparse(image_url).path)
    if not match:
        return None
    category, image_name, extension = match.groups()
    category = category.lower()
    image_path = Path(image_root) / category / (image_name + "." + extension.lower())
    if not image_path.is_file():
        return None
    return {
        "product_id": int(product_id),
        "category": category,
        "image_name": image_name,
        "image_url": image_url,
        "image_path": str(image_path.resolve()),
    }


def load_catalog(image_root, catalog_file=None, mysql_container="mall-mysql"):
    """Return local images for published FashionIQ products.

    A JSON catalog can contain [{"id": 1, "pic": "..."}]. Without one, read
    the running MySQL container described in the mall startup guide.
    """
    if catalog_file:
        with open(catalog_file, encoding="utf-8") as handle:
            rows = json.load(handle)
        if not isinstance(rows, list):
            raise ValueError("Catalog JSON must be a list of objects")
        pairs = [(row["id"], row.get("pic") or row.get("image_url")) for row in rows]
    else:
        password = os.environ.get("MALL_DB_PASSWORD")
        if password is None:
            raise ValueError("Set MALL_DB_PASSWORD before reading the mall MySQL container")
        command = [
            "docker", "exec", "-e", "MYSQL_PWD=" + password, mysql_container,
            "mysql", "-uroot", "-D", "mall", "--batch", "--raw",
            "--skip-column-names", "-e", _SQL,
        ]
        completed = subprocess.run(
            command, capture_output=True, text=True, check=True, encoding="utf-8"
        )
        pairs = []
        for line in completed.stdout.splitlines():
            fields = line.split("\t", 1)
            if len(fields) == 2:
                pairs.append((fields[0], fields[1]))
    items = [item_from_row(pid, url, image_root) for pid, url in pairs if url]
    items = [item for item in items if item is not None]
    if not items:
        raise ValueError("No published FashionIQ products with local images were found")
    return items, len(pairs) - len(items)
