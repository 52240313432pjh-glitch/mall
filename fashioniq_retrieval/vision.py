"""Generate a target-image description with a Chinese vision prompt."""

import base64
import json
import os
from pathlib import Path
from urllib import request

from PIL import Image

from .prompts import target_description_prompt_zh


def parse_target_description(content):
    """Read the target sentence from JSON, including JSON wrapped in prose or Markdown."""
    if not isinstance(content, str) or not content.strip():
        raise ValueError("Vision model returned an empty response")
    content = content.strip()
    decoder = json.JSONDecoder()
    candidates = []
    try:
        candidates.append(json.loads(content))
    except json.JSONDecodeError:
        # Some vision models add a Markdown fence, <Response> tag, or short
        # explanation even when the response contains a valid JSON object.
        for offset, char in enumerate(content):
            if char != "{":
                continue
            try:
                payload, _ = decoder.raw_decode(content[offset:])
            except json.JSONDecodeError:
                continue
            if isinstance(payload, dict):
                candidates.append(payload)

    for payload in candidates:
        if not isinstance(payload, dict):
            continue
        description = (payload.get("目标图片描述") or payload.get("目标图像描述")
                       or payload.get("Target Image Description") or payload.get("Final Query"))
        if isinstance(description, str) and description.strip():
            return description.strip()
    if not candidates:
        raise ValueError("Vision model did not return a parseable JSON object")
    raise ValueError("Vision model response has no target image description")


def _post_json(endpoint, payload, api_key=None, timeout=180):
    data = json.dumps(payload).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = "Bearer " + api_key
    outgoing = request.Request(endpoint, data=data, headers=headers, method="POST")
    with request.urlopen(outgoing, timeout=timeout) as response:
        return json.load(response)


def describe_target(reference_image, modification, provider="ollama", model=None, endpoint=None):
    """Turn a reference image and a FashionIQ modification into target text.

    The Chinese prompt follows OSCIR's reference-image plus modification
    task. Local Ollama and OpenAI-compatible transports are supported.
    """
    image_path = Path(reference_image)
    if not image_path.is_file():
        raise FileNotFoundError(str(image_path))
    if not modification.strip():
        raise ValueError("Modification text must not be empty")
    with Image.open(image_path) as image:
        mime = {"PNG": "image/png", "WEBP": "image/webp"}.get(image.format, "image/jpeg")
    image_base64 = base64.b64encode(image_path.read_bytes()).decode("ascii")
    user_text = (
        "参考图片：见随附图片。\n"
        "修改描述：" + modification.strip()
    )
    if provider == "ollama":
        endpoint = endpoint or os.environ.get("OLLAMA_API_URL", "http://localhost:11434/api/chat")
        model = model or os.environ.get("OSRCIR_VISION_MODEL", "gemma3:12b")
        payload = {
            "model": model,
            "stream": False,
            "format": "json",
            "messages": [
                {"role": "system", "content": target_description_prompt_zh},
                {"role": "user", "content": user_text, "images": [image_base64]},
            ],
            "options": {"temperature": 0},
        }
        response = _post_json(endpoint, payload)
        content = response.get("message", {}).get("content", "")
    elif provider == "openai":
        endpoint = endpoint or os.environ.get("OSRCIR_VISION_URL")
        model = model or os.environ.get("OSRCIR_VISION_MODEL")
        api_key = os.environ.get("OSRCIR_VISION_API_KEY")
        if not endpoint or not model:
            raise ValueError("Set OSRCIR_VISION_URL and OSRCIR_VISION_MODEL for the openai provider")
        payload = {
            "model": model,
            "temperature": 0,
            "messages": [
                {"role": "system", "content": target_description_prompt_zh},
                {"role": "user", "content": [
                    {"type": "text", "text": user_text},
                    {"type": "image_url", "image_url": {
                        "url": "data:" + mime + ";base64," + image_base64
                    }},
                ]},
            ],
        }
        response = _post_json(endpoint, payload, api_key=api_key)
        content = response["choices"][0]["message"]["content"]
    else:
        raise ValueError("provider must be ollama or openai")
    return parse_target_description(content)
