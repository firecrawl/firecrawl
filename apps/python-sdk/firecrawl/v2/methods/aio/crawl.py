from typing import Optional, Dict, Any, List
from ...types import (
    CrawlRequest,
    CrawlJob,
    CrawlResponse,
    Document,
    CrawlParamsRequest,
    CrawlParamsData,
    WebhookConfig,
    CrawlErrorsResponse,
    ActiveCrawlsResponse,
    ActiveCrawl,
    PaginationConfig,
)
from ...utils.error_handler import handle_response_error
from ...utils.validation import prepare_scrape_options
from ...utils.http_client_async import AsyncHttpClient
from ...utils.normalize import normalize_document_input
import time


def _prepare_crawl_request(request: CrawlRequest) -> dict:
    if not request.url or not request.url.strip():
        raise ValueError("URL cannot be empty")
    data = {"url": request.url}
    if request.prompt:
        data["prompt"] = request.prompt
    if request.scrape_options is not None:
        opts = prepare_scrape_options(request.scrape_options)
        if opts:
            data["scrapeOptions"] = opts
    # Webhook conversion
    if request.webhook is not None:
        if isinstance(request.webhook, str):
            data["webhook"] = request.webhook
        else:
            data["webhook"] = request.webhook.model_dump(exclude_none=True)
    request_data = request.model_dump(exclude_none=True, exclude_unset=True)
    request_data.pop("url", None)
    request_data.pop("prompt", None)
    request_data.pop("scrape_options", None)
    field_mappings = {
        "include_paths": "includePaths",
        "exclude_paths": "excludePaths",
        "max_discovery_depth": "maxDiscoveryDepth",
        "sitemap": "sitemap",
        "ignore_query_parameters": "ignoreQueryParameters",
        "deduplicate_similar_urls": "deduplicateSimilarURLs",
        "crawl_entire_domain": "crawlEntireDomain",
        "allow_external_links": "allowExternalLinks",
        "allow_subdomains": "allowSubdomains",
        "delay": "delay",
        "max_concurrency": "maxConcurrency",
        "regex_on_full_url": "regexOnFullURL",
        "zero_data_retention": "zeroDataRetention",
    }
    for snake, camel in field_mappings.items():
        if snake in request_data:
            data[camel] = request_data.pop(snake)
    data.update(request_data)
    if getattr(request, "integration", None) is not None:
        data["integration"] = str(getattr(request, "integration")).strip()
    return data


def _parse_crawl_documents(data_list: Optional[List[Any]]) -> List[Document]:
    documents: List[Document] = []
    for doc_data in data_list or []:
        if isinstance(doc_data, dict):
            normalized = normalize_document_input(doc_data)
            documents.append(Document(**normalized))
    return documents


def _parse_crawl_status_response(body: Dict[str, Any]) -> Dict[str, Any]:
    if not body.get("success"):
        raise Exception(body.get("error", "Unknown error occurred"))

    return {
        "status": body.get("status"),
        "completed": body.get("completed", 0),
        "total": body.get("total", 0),
        "credits_used": body.get("creditsUsed", 0),
        "expires_at": body.get("expiresAt"),
        "next": body.get("next"),
        "data": _parse_crawl_documents(body.get("data", [])),
    }


async def start_crawl(client: AsyncHttpClient, request: CrawlRequest) -> CrawlResponse:
    """
    Start a crawl job for a website.
    
    Args:
        client: Async HTTP client instance
        request: CrawlRequest containing URL and options
        
    Returns:
        CrawlResponse with job information
        
    Raises:
        ValueError: If request is invalid
        Exception: If the crawl operation fails to start
    """
    payload = _prepare_crawl_request(request)
    response = await client.post("/v2/crawl", payload)
    if response.status_code >= 400:
        handle_response_error(response, "start crawl")
    body = response.json()
    if body.get("success"):
        return CrawlResponse(id=body.get("id"), url=body.get("url"))
    raise Exception(body.get("error", "Unknown error occurred"))


async def get_crawl_status(
    client: AsyncHttpClient,
    job_id: str,
    pagination_config: Optional[PaginationConfig] = None,
    *,
    request_timeout: Optional[float] = None,
) -> CrawlJob:
    """
    Get the status of a crawl job.
    
    Args:
        client: Async HTTP client instance
        job_id: ID of the crawl job
        pagination_config: Optional configuration for pagination limits
        request_timeout: Timeout (in seconds) for each individual HTTP request. When auto-pagination 
            is enabled (default) and there are multiple pages of results, this timeout applies to 
            each page request separately, not to the entire operation
        
    Returns:
        CrawlJob with job information
        
    Raises:
        Exception: If the status check fails
    """
    response = await client.get(f"/v2/crawl/{job_id}", timeout=request_timeout)
    if response.status_code >= 400:
        handle_response_error(response, "get crawl status")
    body = response.json()
    payload = _parse_crawl_status_response(body)

    documents = payload["data"]

    # Handle pagination if requested
    auto_paginate = pagination_config.auto_paginate if pagination_config else True
    if auto_paginate and payload["next"]:
        documents = await _fetch_all_pages_async(
            client,
            payload["next"],
            documents,
            pagination_config,
            request_timeout=request_timeout,
        )

    return CrawlJob(
        status=payload["status"],
        completed=payload["completed"],
        total=payload["total"],
        credits_used=payload["credits_used"],
        expires_at=payload["expires_at"],
        next=payload["next"] if not auto_paginate else None,
        data=documents,
    )


async def get_crawl_status_page(
    client: AsyncHttpClient,
    next_url: str,
    *,
    request_timeout: Optional[float] = None,
) -> CrawlJob:
    """
    Fetch a single page of crawl results using the provided next URL.

    Args:
        client: Async HTTP client instance
        next_url: Opaque next URL from a prior crawl status response
        request_timeout: Timeout (in seconds) for the HTTP request

    Returns:
        CrawlJob with the page data and next URL (if any)

    Raises:
        Exception: If the request fails or returns an error response
    """
    response = await client.get(next_url, timeout=request_timeout)
    if response.status_code >= 400:
        handle_response_error(response, "get crawl status page")
    body = response.json()
    payload = _parse_crawl_status_response(body)
    return CrawlJob(
        status=payload["status"],
        completed=payload["completed"],
        total=payload["total"],
        credits_used=payload["credits_used"],
        expires_at=payload["expires_at"],
        next=payload["next"],
        data=payload["data"],
    )


async def _fetch_all_pages_async(
    client: AsyncHttpClient,
    next_url: str,
    initial_documents: List[Document],
    pagination_config: Optional[PaginationConfig] = None,
    *,
    request_timeout: Optional[float] = None,
) -> List[Document]:
    """
    Fetch all pages of crawl results asynchronously.
    
    Args:
        client: Async HTTP client instance
        next_url: URL for the next page
        initial_documents: Documents from the first page
        pagination_config: Optional configuration for pagination limits
        request_timeout: Optional timeout (in seconds) for the underlying HTTP request
        
    Returns:
        List of all documents from all pages
    """
    documents = initial_documents.copy()
    current_url = next_url
    page_count = 0
    
    # Apply pagination limits
    max_pages = pagination_config.max_pages if pagination_config else None
    max_results = pagination_config.max_results if pagination_config else None
    max_wait_time = pagination_config.max_wait_time if pagination_config else None
    
    start_time = time.monotonic()
    
    while current_url:
        # Check pagination limits (treat 0 as a valid limit)
        if (max_pages is not None) and page_count >= max_pages:
            break

        if (max_wait_time is not None) and (time.monotonic() - start_time) > max_wait_time:
            break
        
        # Fetch next page
        response = await client.get(current_url, timeout=request_timeout)
        
        if response.status_code >= 400:
            # Log error but continue with what we have
            import logging
            logger = logging.getLogger("firecrawl")
            logger.warning("Failed to fetch next page", extra={"status_code": response.status_code})
            break
        
        page_data = response.json()
        try:
            page_payload = _parse_crawl_status_response(page_data)
        except Exception:
            break
        
        # Add documents from this page
        for document in page_payload["data"]:
            # Check max_results limit
            if (max_results is not None) and (len(documents) >= max_results):
                break
            documents.append(document)
        
        # Check if we hit max_results limit
        if (max_results is not None) and (len(documents) >= max_results):
            break
        
        # Get next URL
        current_url = page_payload["next"]
        page_count += 1
    
    return documents


async def cancel_crawl(client: AsyncHttpClient, job_id: str) -> bool:
    """
    Cancel a crawl job.
    
    Args:
        client: Async HTTP client instance
        job_id: ID of the crawl job
        
    Returns:
        True if cancellation was successful
        
    Raises:
        Exception: If the cancellation operation fails
    """
    response = await client.delete(f"/v2/crawl/{job_id}")
    if response.status_code >= 400:
        handle_response_error(response, "cancel crawl")
    body = response.json()
    return body.get("status") == "cancelled"


async def crawl_params_preview(client: AsyncHttpClient, request: CrawlParamsRequest) -> CrawlParamsData:
    """
    Preview crawl parameters before starting a crawl job.
    
    Args:
        client: Async HTTP client instance
        request: CrawlParamsRequest containing URL and prompt
        
    Returns:
        CrawlParamsData containing crawl configuration
        
    Raises:
        ValueError: If request is invalid
        Exception: If the parameter preview fails
    """
    if not request.url or not request.url.strip():
        raise ValueError("URL cannot be empty")
    if not request.prompt or not request.prompt.strip():
        raise ValueError("Prompt cannot be empty")
    payload = {"url": request.url, "prompt": request.prompt}
    response = await client.post("/v2/crawl/params-preview", payload)
    if response.status_code >= 400:
        handle_response_error(response, "crawl params preview")
    body = response.json()
    if not body.get("success"):
        raise Exception(body.get("error", "Unknown error occurred"))
    params_data = body.get("data", {})
    converted: Dict[str, Any] = {}
    mapping = {
        "includePaths": "include_paths",
        "excludePaths": "exclude_paths",
        "maxDiscoveryDepth": "max_discovery_depth",
        "sitemap": "sitemap",
        "ignoreQueryParameters": "ignore_query_parameters",
        "deduplicateSimilarURLs": "deduplicate_similar_urls",
        "crawlEntireDomain": "crawl_entire_domain",
        "allowExternalLinks": "allow_external_links",
        "allowSubdomains": "allow_subdomains",
        "maxConcurrency": "max_concurrency",
        "scrapeOptions": "scrape_options",
        "zeroDataRetention": "zero_data_retention",
    }
    for camel, snake in mapping.items():
        if camel in params_data:
            converted[snake] = params_data[camel]
    if "webhook" in params_data:
        wk = params_data["webhook"]
        converted["webhook"] = wk
    if "warning" in body:
        converted["warning"] = body["warning"]
    return CrawlParamsData(**converted)


async def get_crawl_errors(client: AsyncHttpClient, crawl_id: str) -> CrawlErrorsResponse:
    """
    Get errors from a crawl job.
    
    Args:
        client: Async HTTP client instance
        crawl_id: ID of the crawl job
        
    Returns:
        CrawlErrorsResponse with errors and robots blocked
        
    Raises:
        Exception: If the error check operation fails
    """
    response = await client.get(f"/v2/crawl/{crawl_id}/errors")
    if response.status_code >= 400:
        handle_response_error(response, "check crawl errors")
    body = response.json()
    payload = body.get("data", body)
    normalized = {
        "errors": payload.get("errors", []),
        "robots_blocked": payload.get("robotsBlocked", payload.get("robots_blocked", [])),
    }
    return CrawlErrorsResponse(**normalized)


async def get_active_crawls(client: AsyncHttpClient) -> ActiveCrawlsResponse:
    """
    Get active crawl jobs.
    
    Args:
        client: Async HTTP client instance
        
    Returns:
        ActiveCrawlsResponse with active crawl jobs
        
    Raises:
        Exception: If the active crawl jobs operation fails
    """
    response = await client.get("/v2/crawl/active")
    if response.status_code >= 400:
        handle_response_error(response, "get active crawls")
    body = response.json()
    if not body.get("success"):
        raise Exception(body.get("error", "Unknown error occurred"))
    crawls_in = body.get("crawls", [])
    normalized = []
    for c in crawls_in:
        if isinstance(c, dict):
            normalized.append({
                "id": c.get("id"),
                "team_id": c.get("teamId", c.get("team_id")),
                "url": c.get("url"),
                "options": c.get("options"),
            })
    return ActiveCrawlsResponse(success=True, crawls=[ActiveCrawl(**nc) for nc in normalized])
