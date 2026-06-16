from typing import Optional, Dict, Any, Literal
from ...types import (
    ScrapeOptions,
    Document,
    BrowserExecuteResponse,
    BrowserDeleteResponse,
)
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


async def interact(
    client: AsyncHttpClient,
    job_id: str,
    code: Optional[str] = None,
    *,
    prompt: Optional[str] = None,
    language: Literal["python", "node", "bash"] = "node",
    timeout: Optional[int] = None,
    origin: Optional[str] = None,
) -> BrowserExecuteResponse:
    if not job_id or not job_id.strip():
        raise ValueError("Job ID cannot be empty")
    has_code = code and code.strip()
    has_prompt = prompt and prompt.strip()
    if not has_code and not has_prompt:
        raise ValueError("Either 'code' or 'prompt' must be provided")

    payload: Dict[str, Any] = {
        "language": language,
    }
    if has_code:
        payload["code"] = code
    if has_prompt:
        payload["prompt"] = prompt
    if timeout is not None:
        payload["timeout"] = timeout
    if origin is not None:
        payload["origin"] = origin

    response = await client.post(f"/v2/scrape/{job_id}/interact", payload)
    if response.status_code >= 400:
        handle_response_error(response, "interact with scrape browser")

    body = response.json()
    if not body.get("success"):
        raise Exception(body.get("error", "Unknown error occurred"))

    normalized = dict(body)
    if "exitCode" in normalized and "exit_code" not in normalized:
        normalized["exit_code"] = normalized["exitCode"]
    if "cdpUrl" in normalized and "cdp_url" not in normalized:
        normalized["cdp_url"] = normalized["cdpUrl"]
    if "liveViewUrl" in normalized and "live_view_url" not in normalized:
        normalized["live_view_url"] = normalized["liveViewUrl"]
    if "interactiveLiveViewUrl" in normalized and "interactive_live_view_url" not in normalized:
        normalized["interactive_live_view_url"] = normalized["interactiveLiveViewUrl"]
    return BrowserExecuteResponse(**normalized)


async def stop_interaction(
    client: AsyncHttpClient,
    job_id: str,
) -> BrowserDeleteResponse:
    if not job_id or not job_id.strip():
        raise ValueError("Job ID cannot be empty")

    response = await client.delete(f"/v2/scrape/{job_id}/interact")
    if response.status_code >= 400:
        handle_response_error(response, "stop interaction")

    body = response.json()
    normalized = dict(body)
    if "sessionDurationMs" in normalized and "session_duration_ms" not in normalized:
        normalized["session_duration_ms"] = normalized["sessionDurationMs"]
    if "creditsBilled" in normalized and "credits_billed" not in normalized:
        normalized["credits_billed"] = normalized["creditsBilled"]

    return BrowserDeleteResponse(**normalized)


async def stop_interactive_browser(
    client: AsyncHttpClient,
    job_id: str,
) -> BrowserDeleteResponse:
    """Deprecated alias for stop_interaction()."""
    return await stop_interaction(client, job_id)


async def scrape_execute(
    client: AsyncHttpClient,
    job_id: str,
    code: Optional[str] = None,
    *,
    prompt: Optional[str] = None,
    language: Literal["python", "node", "bash"] = "node",
    timeout: Optional[int] = None,
    origin: Optional[str] = None,
) -> BrowserExecuteResponse:
    """Deprecated alias for interact()."""
    return await interact(
        client,
        job_id,
        code,
        prompt=prompt,
        language=language,
        timeout=timeout,
        origin=origin,
    )


async def delete_scrape_browser(
    client: AsyncHttpClient,
    job_id: str,
) -> BrowserDeleteResponse:
    """Deprecated alias for stop_interaction()."""
    return await stop_interaction(client, job_id)

