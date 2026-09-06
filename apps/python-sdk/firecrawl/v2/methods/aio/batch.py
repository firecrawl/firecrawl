from typing import Optional, List, Dict, Any, Tuple
from ...types import ScrapeOptions, WebhookConfig, Document, BatchScrapeResponse, BatchScrapeJob, PaginationConfig
from ...utils.http_client_async import AsyncHttpClient
from ...utils.validation import prepare_scrape_options
from ...utils.error_handler import handle_response_error
from ...utils.normalize import normalize_document_input
from ...methods.batch import validate_batch_urls
import time

def _parse_batch_scrape_documents(data_list: Optional[List[Any]]) -> List[Document]:
    documents: List[Document] = []
    for doc in data_list or []:
        if isinstance(doc, dict):
            normalized = normalize_document_input(doc)
            documents.append(Document(**normalized))
    return documents


def _parse_batch_scrape_status_response(body: Dict[str, Any]) -> Dict[str, Any]:
    # A kickoff failure responds 200 with success:false and status:"failed"; parse it as a
    # normal terminal job instead of raising, so the waiter can raise JobFailedError.
    if not body.get("success") and body.get("status") != "failed":
        raise Exception(body.get("error", "Unknown error occurred"))

    return {
        "status": body.get("status"),
        "completed": body.get("completed", 0),
        "total": body.get("total", 0),
        "credits_used": body.get("creditsUsed"),
        "expires_at": body.get("expiresAt"),
        "next": body.get("next"),
        "data": _parse_batch_scrape_documents(body.get("data", []) or []),
        "error": body.get("error"),
    }

def _prepare(urls: List[str], *, options: Optional[ScrapeOptions] = None, **kwargs) -> Dict[str, Any]:
    if not urls:
        raise ValueError("URLs list cannot be empty")

    validated_urls = validate_batch_urls([u.strip() if isinstance(u, str) else u for u in urls])
    payload: Dict[str, Any] = {"urls": validated_urls}
    if options:
        opts = prepare_scrape_options(options)
        if opts:
            payload.update(opts)
    if (v := kwargs.get("audit_metadata")) is not None:
        payload["auditMetadata"] = v.model_dump()
    if (w := kwargs.get("webhook")) is not None:
        payload["webhook"] = w if isinstance(w, str) else w.model_dump(exclude_none=True)
    if (v := kwargs.get("append_to_id")) is not None:
        payload["appendToId"] = v
    if (v := kwargs.get("ignore_invalid_urls")) is not None:
        payload["ignoreInvalidURLs"] = v
    if (v := kwargs.get("max_concurrency")) is not None:
        payload["maxConcurrency"] = v
    if (v := kwargs.get("zero_data_retention")) is not None:
        payload["zeroDataRetention"] = v
    if (v := kwargs.get("integration")) is not None:
        trimmed_integration = str(v).strip()
        if trimmed_integration:
            payload["integration"] = trimmed_integration
    return payload


async def start_batch_scrape(client: AsyncHttpClient, urls: List[str], **kwargs) -> BatchScrapeResponse:
    payload = _prepare(urls, **kwargs)
    response = await client.post("/v2/batch/scrape", payload)
    if response.status_code >= 400:
        handle_response_error(response, "start batch scrape")
    body = response.json()
    if not body.get("success"):
        raise Exception(body.get("error", "Unknown error occurred"))
    return BatchScrapeResponse(id=body.get("id"), url=body.get("url"), invalid_urls=body.get("invalidURLs"))


async def get_batch_scrape_status(
    client: AsyncHttpClient, 
    job_id: str,
    pagination_config: Optional[PaginationConfig] = None
) -> BatchScrapeJob:
    """
    Get the status of a batch scrape job.
    
    Args:
        client: Async HTTP client instance
        job_id: ID of the batch scrape job
        pagination_config: Optional configuration for pagination behavior
        
    Returns:
        BatchScrapeJob containing job status and data
        
    Raises:
        Exception: If the status check fails
    """
    response = await client.get(f"/v2/batch/scrape/{job_id}")
    if response.status_code >= 400:
        handle_response_error(response, "get batch scrape status")
    body = response.json()
    payload = _parse_batch_scrape_status_response(body)
    docs = payload["data"]
    next_url = payload["next"]

    # Unset auto_paginate only paginates once the job is completed, so a failed/cancelled
    # job's result pages are never fetched before the waiter can raise JobFailedError.
    auto_paginate = (
        pagination_config.auto_paginate
        if (pagination_config is not None and pagination_config.auto_paginate is not None)
        else payload["status"] == "completed"
    )
    if auto_paginate and next_url:
        docs, next_url = await _fetch_all_batch_pages_async(
            client,
            next_url,
            docs,
            pagination_config
        )

    return BatchScrapeJob(
        status=payload["status"],
        completed=payload["completed"],
        total=payload["total"],
        credits_used=payload["credits_used"],
        expires_at=payload["expires_at"],
        next=next_url,
        data=docs,
        error=payload.get("error"),
    )


async def get_batch_scrape_status_page(
    client: AsyncHttpClient,
    next_url: str,
    *,
    request_timeout: Optional[float] = None,
) -> BatchScrapeJob:
    """
    Fetch a single page of batch scrape results using the provided next URL.

    Args:
        client: Async HTTP client instance
        next_url: Opaque next URL from a prior batch scrape status response
        request_timeout: Timeout (in seconds) for the HTTP request

    Returns:
        BatchScrapeJob with the page data and next URL (if any)

    Raises:
        Exception: If the request fails or returns an error response
    """
    response = await client.get(next_url, timeout=request_timeout)
    if response.status_code >= 400:
        handle_response_error(response, "get batch scrape status page")
    body = response.json()
    payload = _parse_batch_scrape_status_response(body)
    return BatchScrapeJob(
        status=payload["status"],
        completed=payload["completed"],
        total=payload["total"],
        credits_used=payload["credits_used"],
        expires_at=payload["expires_at"],
        next=payload["next"],
        data=payload["data"],
        error=payload.get("error"),
    )


async def _fetch_all_batch_pages_async(
    client: AsyncHttpClient,
    next_url: str,
    initial_documents: List[Document],
    pagination_config: Optional[PaginationConfig] = None
) -> Tuple[List[Document], Optional[str]]:
    """
    Fetch pages of batch scrape results until drained or a caller limit stops early.

    Returns:
        Tuple of (documents, unconsumed next URL or None)

    Raises:
        FirecrawlError: If a page fetch fails; partial data is never returned silently
    """
    documents = initial_documents.copy()
    current_url: Optional[str] = next_url
    page_count = 0

    max_pages = pagination_config.max_pages if pagination_config else None
    max_results = pagination_config.max_results if pagination_config else None
    max_wait_time = pagination_config.max_wait_time if pagination_config else None

    start_time = time.monotonic()

    while current_url:
        # Check pagination limits
        if (max_pages is not None) and (page_count >= max_pages):
            break

        if (max_wait_time is not None) and (time.monotonic() - start_time) > max_wait_time:
            break

        if (max_results is not None) and (len(documents) >= max_results):
            break

        response = await client.get(current_url)

        if response.status_code >= 400:
            handle_response_error(response, "get batch scrape status page")

        page_payload = _parse_batch_scrape_status_response(response.json())

        if max_results is not None and len(documents) + len(page_payload["data"]) > max_results:
            # A page that would overshoot max_results is skipped whole, so resume never drops or duplicates data.
            return documents, current_url

        documents.extend(page_payload["data"])
        if page_payload["next"] == current_url:
            # A next cursor identical to the page just fetched can never advance; treat as drained.
            return documents, None
        current_url = page_payload["next"]
        page_count += 1

    return documents, current_url


async def cancel_batch_scrape(client: AsyncHttpClient, job_id: str) -> bool:
    response = await client.delete(f"/v2/batch/scrape/{job_id}")
    if response.status_code >= 400:
        handle_response_error(response, "cancel batch scrape")
    body = response.json()
    return body.get("status") == "cancelled"


async def get_batch_scrape_errors(client: AsyncHttpClient, job_id: str) -> Dict[str, Any]:
    response = await client.get(f"/v2/batch/scrape/{job_id}/errors")
    if response.status_code >= 400:
        handle_response_error(response, "get batch scrape errors")
    body = response.json()
    if not body.get("success"):
        raise Exception(body.get("error", "Unknown error occurred"))
    return body
