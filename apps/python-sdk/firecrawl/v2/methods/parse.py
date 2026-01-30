"""
Parse functionality for Firecrawl v2 API.
"""

import io
import json
import os
from typing import Optional, Dict, Any, Union, BinaryIO
from ..types import ParseOptions, Document
from ..utils.normalize import normalize_document_input
from ..utils import HttpClient, handle_response_error, prepare_parse_options, validate_parse_options


FileInput = Union[str, bytes, BinaryIO]


def _prepare_parse_payload(
    options: Optional[ParseOptions] = None,
    params: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    payload: Dict[str, Any] = {}

    if options is not None:
        validated = validate_parse_options(options)
        if validated is not None:
            opts = prepare_parse_options(validated)
            if opts:
                payload["options"] = json.dumps(opts)

    if params:
        if params.get("origin"):
            payload["origin"] = params["origin"]
        if params.get("integration"):
            payload["integration"] = params["integration"]
        if params.get("zeroDataRetention") is not None:
            payload["zeroDataRetention"] = str(params["zeroDataRetention"]).lower()

    return payload


def parse(
    client: HttpClient,
    file: FileInput,
    options: Optional[ParseOptions] = None,
    *,
    filename: Optional[str] = None,
    content_type: Optional[str] = None,
    origin: Optional[str] = None,
    integration: Optional[str] = None,
    zero_data_retention: Optional[bool] = None,
) -> Document:
    """
    Parse a local file and return the document.

    Args:
        client: HTTP client instance
        file: File path, bytes, or file-like object
        options: Parse options (snake_case)
        filename: Optional filename override
        content_type: Optional content type override
        origin: Optional origin
        integration: Optional integration
        zero_data_retention: Optional zeroDataRetention flag

    Returns:
        Document
    """
    if not file:
        raise ValueError("file is required")

    params = {
        "origin": origin,
        "integration": integration,
        "zeroDataRetention": zero_data_retention,
    }
    data = _prepare_parse_payload(options, params)

    should_close = False
    if isinstance(file, str):
        file_handle = open(file, "rb")
        should_close = True
        file_name = filename or os.path.basename(file)
    elif isinstance(file, (bytes, bytearray)):
        file_handle = io.BytesIO(file)
        should_close = True
        file_name = filename or "file"
    else:
        file_handle = file
        file_name = filename or getattr(file, "name", "file")

    try:
        if content_type:
            files = {"file": (file_name, file_handle, content_type)}
        else:
            files = {"file": (file_name, file_handle)}

        response = client.post_multipart("/v2/parse", data, files)
    finally:
        if should_close:
            file_handle.close()

    if not response.ok:
        handle_response_error(response, "parse")

    body = response.json()
    if not body.get("success"):
        raise Exception(body.get("error", "Unknown error occurred"))

    document_data = body.get("data", {})
    normalized = normalize_document_input(document_data)
    return Document(**normalized)
