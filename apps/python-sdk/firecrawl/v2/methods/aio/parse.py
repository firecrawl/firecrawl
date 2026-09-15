import asyncio
from functools import partial
import json
from typing import Optional, Dict, Any, Tuple

from ...types import Document, ParseOptions
from ...utils.agent_hints import agent_hint_metadata
from ...utils.normalize import normalize_document_input
from ...utils.error_handler import handle_response_error
from ...utils.http_client_async import AsyncHttpClient
from ..parse import (
    ParseFileInput,
    _prepare_file_payload,
    _prepare_parse_options_payload,
)

async def _prepare_parse_request(
    file: ParseFileInput,
    options: Optional[ParseOptions] = None,
    *,
    filename: Optional[str] = None,
    content_type: Optional[str] = None,
) -> Tuple[Dict[str, Any], Dict[str, Tuple[str, bytes, str]]]:
    request_data = _prepare_parse_options_payload(options)
    multipart_fields = {"options": json.dumps(request_data)}
    loop = asyncio.get_running_loop()
    multipart_files = await loop.run_in_executor(
        None,
        partial(
            _prepare_file_payload,
            file,
            filename=filename,
            content_type=content_type,
        ),
    )
    return multipart_fields, multipart_files


async def parse(
    client: AsyncHttpClient,
    file: ParseFileInput,
    options: Optional[ParseOptions] = None,
    *,
    filename: Optional[str] = None,
    content_type: Optional[str] = None,
) -> Document:
    fields, files = await _prepare_parse_request(
        file,
        options,
        filename=filename,
        content_type=content_type,
    )

    response = await client.post_multipart("/v2/parse", data=fields, files=files)
    if response.status_code >= 400:
        handle_response_error(response, "parse")

    body = response.json()
    if not body.get("success"):
        handle_response_error(response, "parse")

    document_data = body.get("data", {})
    normalized = {**normalize_document_input(document_data), **agent_hint_metadata(body)}
    return Document(**normalized)
