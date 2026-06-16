"""
Scraping functionality for Firecrawl v2 API.
"""

from typing import Optional, Dict, Any, Literal
from ..types import (
    ScrapeOptions,
    Document,
    BrowserExecuteResponse,
    BrowserDeleteResponse,
)
from ..utils.normalize import normalize_document_input
from ..utils import HttpClient, handle_response_error, prepare_scrape_options, validate_scrape_options


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

def scrape(client: HttpClient, url: str, options: Optional[ScrapeOptions] = None) -> Document:
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

    response = client.post("/v2/scrape", payload)

    if not response.ok:
        handle_response_error(response, "scrape")

    body = response.json()
    if not body.get("success"):
        raise Exception(body.get("error", "Unknown error occurred"))

    document_data = body.get("data", {})
    normalized = normalize_document_input(document_data)
    return Document(**normalized)


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