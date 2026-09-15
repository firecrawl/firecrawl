"""
Parse (multipart upload) functionality for Firecrawl v2 API.
"""

import json
import mimetypes
from pathlib import Path
from typing import Optional, Dict, Any, BinaryIO, Union, Tuple

from ..types import Document, ParseOptions
from ..utils.agent_hints import agent_hint_metadata
from ..utils.normalize import normalize_document_input
from ..utils import HttpClient, handle_response_error, prepare_scrape_options, validate_scrape_options
from ..utils.get_version import get_version

version = get_version()

ParseFileInput = Union[str, bytes, bytearray, Path, BinaryIO]
UNSUPPORTED_PARSE_FORMATS = {"changeTracking", "screenshot", "branding", "audio", "video"}


def _extract_format_type(format_item: Any) -> Optional[str]:
    if isinstance(format_item, str):
        return format_item
    if isinstance(format_item, dict):
        fmt_type = format_item.get("type")
        return fmt_type if isinstance(fmt_type, str) else None
    return None


def _validate_parse_options_payload(options_payload: Dict[str, Any]) -> None:
    actions = options_payload.get("actions")
    if isinstance(actions, list) and len(actions) > 0:
        raise ValueError("Parse uploads do not support actions.")

    wait_for = options_payload.get("waitFor")
    if isinstance(wait_for, (int, float)) and wait_for > 0:
        raise ValueError("Parse uploads do not support waitFor.")

    if options_payload.get("location") is not None:
        raise ValueError("Parse uploads do not support location overrides.")

    if options_payload.get("mobile"):
        raise ValueError("Parse uploads do not support mobile rendering.")

    proxy = options_payload.get("proxy")
    if proxy not in (None, "auto", "basic"):
        raise ValueError("Parse uploads only support proxy values of auto or basic.")

    for fmt in options_payload.get("formats") or []:
        fmt_type = _extract_format_type(fmt)
        if fmt_type in UNSUPPORTED_PARSE_FORMATS:
            if fmt_type == "changeTracking":
                raise ValueError("Parse uploads do not support change tracking.")
            if fmt_type == "screenshot":
                raise ValueError("Parse uploads do not support screenshot output.")
            if fmt_type in {"audio", "video"}:
                raise ValueError(f"Parse uploads do not support {fmt_type} output.")
            raise ValueError("Parse uploads do not support branding output.")


def _prepare_parse_options_payload(
    options: Optional[ParseOptions],
) -> Dict[str, Any]:
    request_data: Dict[str, Any] = {}

    if options is not None:
        validated = validate_scrape_options(options)
        if validated is not None:
            opts = prepare_scrape_options(validated) or {}
            _validate_parse_options_payload(opts)
            # Parse is always uncached server-side; avoid sending cache/index hints.
            opts.pop("maxAge", None)
            opts.pop("minAge", None)
            opts.pop("storeInCache", None)
            opts.pop("lockdown", None)
            request_data.update(opts)

    request_data["origin"] = request_data.get("origin") or f"python-sdk@{version}"
    return request_data


def _prepare_file_payload(
    file: ParseFileInput,
    filename: Optional[str] = None,
    content_type: Optional[str] = None,
) -> Dict[str, Tuple[str, bytes, str]]:
    if isinstance(file, (str, Path)):
        file_path = Path(file)
        if not file_path.exists() or not file_path.is_file():
            raise ValueError(f"File path does not exist: {file_path}")
        file_bytes = file_path.read_bytes()
        resolved_filename = filename or file_path.name
    elif isinstance(file, (bytes, bytearray)):
        file_bytes = bytes(file)
        resolved_filename = filename or "upload"
    elif hasattr(file, "read"):
        raw_bytes = file.read()
        if isinstance(raw_bytes, str):
            file_bytes = raw_bytes.encode("utf-8")
        else:
            file_bytes = bytes(raw_bytes)
        guessed_name = getattr(file, "name", None)
        resolved_filename = filename or (Path(guessed_name).name if guessed_name else "upload")
    else:
        raise ValueError("Unsupported file input type. Use a file path, bytes, bytearray, or binary file object.")

    if not resolved_filename or not resolved_filename.strip():
        raise ValueError("filename cannot be empty")

    resolved_filename = resolved_filename.strip()
    resolved_content_type = (
        content_type
        or mimetypes.guess_type(resolved_filename)[0]
        or "application/octet-stream"
    )

    return {
        "file": (resolved_filename, file_bytes, resolved_content_type),
    }


def _prepare_parse_request(
    file: ParseFileInput,
    options: Optional[ParseOptions] = None,
    *,
    filename: Optional[str] = None,
    content_type: Optional[str] = None,
) -> Tuple[Dict[str, Any], Dict[str, Tuple[str, bytes, str]]]:
    request_data = _prepare_parse_options_payload(options)
    multipart_fields = {"options": json.dumps(request_data)}
    multipart_files = _prepare_file_payload(
        file,
        filename=filename,
        content_type=content_type,
    )
    return multipart_fields, multipart_files


def parse(
    client: HttpClient,
    file: ParseFileInput,
    options: Optional[ParseOptions] = None,
    *,
    filename: Optional[str] = None,
    content_type: Optional[str] = None,
) -> Document:
    fields, files = _prepare_parse_request(
        file,
        options,
        filename=filename,
        content_type=content_type,
    )

    response = client.post_multipart("/v2/parse", data=fields, files=files)
    if not response.ok:
        handle_response_error(response, "parse")

    body = response.json()
    if not body.get("success"):
        handle_response_error(response, "parse")

    document_data = body.get("data", {})
    normalized = {**normalize_document_input(document_data), **agent_hint_metadata(body)}
    return Document(**normalized)
