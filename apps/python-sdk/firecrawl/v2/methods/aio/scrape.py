from typing import Optional, Dict, Any
from ...types import ScrapeOptions, Document
from ...utils.normalize import normalize_document_input
from ...utils.error_handler import handle_response_error
from ...utils.validation import prepare_scrape_options, validate_scrape_options
from ...utils.http_client_async import AsyncHttpClient


async def _prepare_scrape_request(url: str, options: Optional[ScrapeOptions] = None) -> Dict[str, Any]:
    if not url or not url.strip():
        raise ValueError("URL cannot be empty")
    payload: Dict[str, Any] = {"url": url.strip()}
    if options is not None:
        validated = validate_scrape_options(options)
        if validated is not None:
            opts = prepare_scrape_options(validated)
            if opts:
                payload.update(opts)
    return payload


async def scrape(client: AsyncHttpClient, url: str, options: Optional[ScrapeOptions] = None) -> Document:
    payload = await _prepare_scrape_request(url, options)
    response = await client.post("/v2/scrape", payload)
    if response.status_code >= 400:
        handle_response_error(response, "scrape")
    body = response.json()
    if not body.get("success"):
        raise Exception(body.get("error", "Unknown error occurred"))
    document_data = body.get("data", {})
    normalized = normalize_document_input(document_data)
    return Document(**normalized)

