"""
Scraping functionality for Firecrawl v2 API.
"""

import time
import re
from uuid import uuid4
from typing import Optional, Dict, Any, List, Literal, Union
from ..types import (
    ScrapeOptions,
    Document,
    BrowserExecuteResponse,
    BrowserDeleteResponse,
    ExchangeCall,
    ExchangeScrapeData,
    ExchangeScrapeResult,
)
from ..utils.normalize import normalize_document_input
from ..utils import FirecrawlError, HttpClient, handle_response_error, prepare_scrape_options, validate_scrape_options
from ..utils.auto_resume import ResumeTracker


def _prepare_scrape_request(url: str, options: Optional[ScrapeOptions] = None) -> Dict[str, Any]:
    """
    Prepare a scrape request payload for v2 API.
    
    Args:
        url: URL to scrape
        options: ScrapeOptions (snake_case) to convert and include
        
    Returns:
        Request payload dictionary with camelCase fields
    """
    if not url or not url.strip():
        raise ValueError("URL cannot be empty")

    request_data: Dict[str, Any] = {"url": url.strip()}

    if options is not None:
        validated = validate_scrape_options(options)
        if validated is not None:
            opts = prepare_scrape_options(validated)
            if opts:
                request_data.update(opts)

    return request_data



def scrape(
    client: HttpClient,
    url: str,
    options: Optional[ScrapeOptions] = None,
    *,
    auto_resume: Optional[bool] = None,
) -> Document:
    """
    Scrape a single URL and return the document.
    
    The v2 API returns: { success: boolean, data: Document }
    We surface just the Document to callers.
    
    Args:
        client: HTTP client instance
        url: URL to scrape
        options: Scraping options (snake_case)
        
    Returns:
        Document
    """
    payload = _prepare_scrape_request(url, options)

    resume = ResumeTracker(enabled=auto_resume is not False)
    while True:
        response = client.post("/v2/scrape", payload)

        if not response.ok:
            delay_s = resume.delay_or_none(response)
            if delay_s is not None:
                # The document keeps processing server-side; the retry
                # attaches to the same in-flight job (content adoption)
                # and returns the finished result.
                time.sleep(delay_s)
                continue
            handle_response_error(response, "scrape")

        body = response.json()
        if not body.get("success"):
            raise Exception(body.get("error", "Unknown error occurred"))

        document_data = body.get("data", {})
        normalized = normalize_document_input(document_data)
        return Document(**normalized)


MAX_EXCHANGE_CALLS = 10


def _prepare_scrape_exchange_request(
    calls: List[Union[ExchangeCall, Dict[str, Any]]],
    *,
    timeout: Optional[int] = None,
    integration: Optional[str] = None,
) -> Dict[str, Any]:
    if isinstance(calls, (dict, ExchangeCall)):
        calls = [calls]
    if not calls:
        raise ValueError("At least one exchange call is required")
    if len(calls) > MAX_EXCHANGE_CALLS:
        raise ValueError(f"At most {MAX_EXCHANGE_CALLS} exchange calls are allowed per request")
    items: List[Dict[str, Any]] = []
    for call in calls:
        if isinstance(call, dict):
            call = ExchangeCall(**call)
        elif not isinstance(call, ExchangeCall):
            raise ValueError(f"Invalid exchange call: {call!r}")
        provider = (call.provider or "").strip()
        capability = (call.capability or "").strip()
        if not provider:
            raise ValueError("Exchange call provider cannot be empty")
        if not capability:
            raise ValueError("Exchange call capability cannot be empty")
        item: Dict[str, Any] = {"provider": provider, "capability": capability}
        if call.options is not None:
            item["options"] = call.options
        items.append(item)
    payload: Dict[str, Any] = {"exchange": items}
    if timeout is not None:
        if timeout <= 0:
            raise ValueError("Timeout must be positive")
        payload["timeout"] = timeout
    if integration is not None and str(integration).strip():
        payload["integration"] = str(integration).strip()
    return payload


def _parse_scrape_exchange_response(body: Dict[str, Any], request_id: str) -> ExchangeScrapeData:
    data = body["data"]
    results = [ExchangeScrapeResult(**item) for item in data["exchange"]]
    return ExchangeScrapeData(
        scrape_id=body.get("scrape_id"),
        exchange=results,
        credits_cost=data["creditsCost"],
        request_id=request_id,
    )


def _exchange_request_id(request_id: Optional[str]) -> str:
    value = str(uuid4()) if request_id is None else request_id
    if not re.fullmatch(r"[A-Za-z0-9._:-]{1,128}", value):
        raise ValueError("Invalid request_id")
    return value


def scrape_exchange(client: HttpClient, calls, *, timeout: Optional[int] = None,
                    integration: Optional[str] = None, request_id: Optional[str] = None) -> ExchangeScrapeData:
    payload = _prepare_scrape_exchange_request(calls, timeout=timeout, integration=integration)
    request_id = _exchange_request_id(request_id)
    headers = {**client._prepare_headers(), "x-request-id": request_id}
    try:
        response = client.post("/v2/scrape", payload, headers=headers,
                                    timeout=(timeout + 5000) / 1000 if timeout else None)
        if response.status_code != 200 or not response.json().get("success"):
            handle_response_error(response, "scrape exchange")
        return _parse_scrape_exchange_response(response.json(), request_id)
    except FirecrawlError as error:
        error.request_id = request_id
        raise
    except Exception as error:
        raise FirecrawlError(str(error), request_id=request_id) from error


def interact(
    client: HttpClient,
    job_id: str,
    code: Optional[str] = None,
    *,
    prompt: Optional[str] = None,
    language: Literal["python", "node", "bash"] = "node",
    timeout: Optional[int] = None,
    origin: Optional[str] = None,
) -> BrowserExecuteResponse:
    """
    Interact with the scrape-bound browser session for a scrape job.

    Either ``code`` or ``prompt`` must be provided.  When ``prompt`` is given
    the server runs an AI agent that translates the natural-language instruction
    into browser actions.

    Args:
        client: HTTP client instance
        job_id: Scrape job ID
        code: Code to execute (optional if prompt is provided)
        prompt: Natural-language instruction for the browser agent (optional if code is provided)
        language: Programming language ("python", "node", or "bash")
        timeout: Execution timeout in seconds (1-300)
        origin: Optional request origin tag

    Returns:
        BrowserExecuteResponse with execution output
    """
    if not job_id or not job_id.strip():
        raise ValueError("Job ID cannot be empty")
    has_code = code and code.strip()
    has_prompt = prompt and prompt.strip()
    if not has_code and not has_prompt:
        raise ValueError("Either 'code' or 'prompt' must be provided")

    body: Dict[str, Any] = {
        "language": language,
    }
    if has_code:
        body["code"] = code
    if has_prompt:
        body["prompt"] = prompt
    if timeout is not None:
        body["timeout"] = timeout
    if origin is not None:
        body["origin"] = origin

    response = client.post(f"/v2/scrape/{job_id}/interact", body)
    if not response.ok:
        handle_response_error(response, "interact with scrape browser")

    payload = response.json()
    if not payload.get("success"):
        raise Exception(payload.get("error", "Unknown error occurred"))

    normalized = dict(payload)
    if "exitCode" in normalized and "exit_code" not in normalized:
        normalized["exit_code"] = normalized["exitCode"]
    if "cdpUrl" in normalized and "cdp_url" not in normalized:
        normalized["cdp_url"] = normalized["cdpUrl"]
    if "liveViewUrl" in normalized and "live_view_url" not in normalized:
        normalized["live_view_url"] = normalized["liveViewUrl"]
    if "interactiveLiveViewUrl" in normalized and "interactive_live_view_url" not in normalized:
        normalized["interactive_live_view_url"] = normalized["interactiveLiveViewUrl"]
    return BrowserExecuteResponse(**normalized)


def stop_interaction(
    client: HttpClient,
    job_id: str,
) -> BrowserDeleteResponse:
    """
    Stop the interaction session for a scrape job.

    Args:
        client: HTTP client instance
        job_id: Scrape job ID

    Returns:
        BrowserDeleteResponse
    """
    if not job_id or not job_id.strip():
        raise ValueError("Job ID cannot be empty")

    response = client.delete(f"/v2/scrape/{job_id}/interact")
    if not response.ok:
        handle_response_error(response, "stop interaction")

    payload = response.json()
    normalized = dict(payload)
    if "sessionDurationMs" in normalized and "session_duration_ms" not in normalized:
        normalized["session_duration_ms"] = normalized["sessionDurationMs"]
    if "creditsBilled" in normalized and "credits_billed" not in normalized:
        normalized["credits_billed"] = normalized["creditsBilled"]

    return BrowserDeleteResponse(**normalized)


def stop_interactive_browser(
    client: HttpClient,
    job_id: str,
) -> BrowserDeleteResponse:
    """Deprecated alias for stop_interaction()."""
    return stop_interaction(client, job_id)


def scrape_execute(
    client: HttpClient,
    job_id: str,
    code: Optional[str] = None,
    *,
    prompt: Optional[str] = None,
    language: Literal["python", "node", "bash"] = "node",
    timeout: Optional[int] = None,
    origin: Optional[str] = None,
) -> BrowserExecuteResponse:
    """Deprecated alias for interact()."""
    return interact(
        client,
        job_id,
        code,
        prompt=prompt,
        language=language,
        timeout=timeout,
        origin=origin,
    )


def delete_scrape_browser(
    client: HttpClient,
    job_id: str,
) -> BrowserDeleteResponse:
    """Deprecated alias for stop_interaction()."""
    return stop_interaction(client, job_id)
