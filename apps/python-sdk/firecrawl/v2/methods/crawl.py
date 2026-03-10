"""
Crawling functionality for Firecrawl v2 API.
"""

import time
from typing import Optional, Dict, Any, List
from ..types import (
    CrawlRequest,
    CrawlJob,
    CrawlResponse, Document, CrawlParamsRequest, CrawlParamsResponse, CrawlParamsData,
    WebhookConfig, CrawlErrorsResponse, ActiveCrawlsResponse, ActiveCrawl, PaginationConfig
)
from ..utils import HttpClient, handle_response_error, validate_scrape_options, prepare_scrape_options
from ..utils.normalize import normalize_document_input


def _validate_crawl_request(request: CrawlRequest) -> None:
    """
    Validate crawl request parameters.
    
    Args:
        request: CrawlRequest to validate
        
    Raises:
        ValueError: If request is invalid
    """
    if not request.url or not request.url.strip():
        raise ValueError("URL cannot be empty")
    
    if request.limit is not None and request.limit <= 0:
        raise ValueError("Limit must be positive")
    
    # Validate scrape_options (if provided)
    if request.scrape_options is not None:
        validate_scrape_options(request.scrape_options)


def _prepare_crawl_request(request: CrawlRequest) -> dict:
    """
    Prepare crawl request for API submission.
    
    Args:
        request: CrawlRequest to prepare
        
    Returns:
        Dictionary ready for API submission
    """
    # Validate request
    _validate_crawl_request(request)
    
    # Start with basic data
    data = {"url": request.url}
    
    # Add prompt if present
    if request.prompt:
        data["prompt"] = request.prompt
    
    # Handle scrape_options conversion first (before model_dump)
    if request.scrape_options is not None:
        scrape_data = prepare_scrape_options(request.scrape_options)
        if scrape_data:
            data["scrapeOptions"] = scrape_data
    
    # Convert request to dict
    request_data = request.model_dump(exclude_none=True, exclude_unset=True)
    
    # Remove url, prompt, and scrape_options (already handled)
    request_data.pop("url", None)
    request_data.pop("prompt", None)
    request_data.pop("scrape_options", None)
    
    # Handle webhook conversion first (before model_dump)
    if request.webhook is not None:
        if isinstance(request.webhook, str):
            data["webhook"] = request.webhook
        else:
            # Convert WebhookConfig to dict
            data["webhook"] = request.webhook.model_dump(exclude_none=True)
    
    # Convert other snake_case fields to camelCase
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
        "zero_data_retention": "zeroDataRetention"
    }
    
    # Apply field mappings
    for snake_case, camel_case in field_mappings.items():
        if snake_case in request_data:
            data[camel_case] = request_data.pop(snake_case)
    
    # Add any remaining fields that don't need conversion (like limit)
    data.update(request_data)
    # Trim integration if present
    if "integration" in data and isinstance(data["integration"], str):
        data["integration"] = data["integration"].strip()
    
    return data


def _parse_crawl_documents(data_list: Optional[List[Any]]) -> List[Document]:
    documents: List[Document] = []
    for doc_data in data_list or []:
        if isinstance(doc_data, dict):
            documents.append(Document(**normalize_document_input(doc_data)))
    return documents


def _parse_crawl_status_response(response_data: Dict[str, Any]) -> Dict[str, Any]:
    if not response_data.get("success"):
        raise Exception(response_data.get("error", "Unknown error occurred"))

    return {
        "status": response_data.get("status"),
        "completed": response_data.get("completed", 0),
        "total": response_data.get("total", 0),
        "credits_used": response_data.get("creditsUsed", 0),
        "expires_at": response_data.get("expiresAt"),
        "next": response_data.get("next"),
        "data": _parse_crawl_documents(response_data.get("data", [])),
    }


def start_crawl(client: HttpClient, request: CrawlRequest) -> CrawlResponse:
    """
    Start a crawl job for a website.
    
    Args:
        client: HTTP client instance
        request: CrawlRequest containing URL and options
        
    Returns:
        CrawlResponse with job information
        
    Raises:
        ValueError: If request is invalid
        Exception: If the crawl operation fails to start
    """
    request_data = _prepare_crawl_request(request)
    
    response = client.post("/v2/crawl", request_data)
    
    if not response.ok:
        handle_response_error(response, "start crawl")
    
    response_data = response.json()
    
    if response_data.get("success"):
        job_data = {
            "id": response_data.get("id"),
            "url": response_data.get("url")
        }

        return CrawlResponse(**job_data)
    else:
        raise Exception(response_data.get("error", "Unknown error occurred"))


def get_crawl_status(
    client: HttpClient,
    job_id: str,
    pagination_config: Optional[PaginationConfig] = None,
    *,
    request_timeout: Optional[float] = None,
) -> CrawlJob:
    """
    Get the status of a crawl job.

    Args:
        client: HTTP client instance
        job_id: ID of the crawl job
        pagination_config: Optional configuration for pagination behavior
        request_timeout: Timeout (in seconds) for each individual HTTP request. When auto-pagination 
            is enabled (default) and there are multiple pages of results, this timeout applies to 
            each page request separately, not to the entire operation

    Returns:
        CrawlJob with current status and data

    Raises:
        Exception: If the status check fails
    """
    # Make the API request
    response = client.get(f"/v2/crawl/{job_id}", timeout=request_timeout)

    # Handle errors
    if not response.ok:
        handle_response_error(response, "get crawl status")

    # Parse response
    response_data = response.json()

    payload = _parse_crawl_status_response(response_data)

    documents = payload["data"]

    # Handle pagination if requested
    auto_paginate = pagination_config.auto_paginate if pagination_config else True
    if auto_paginate and payload["next"] and not (
        pagination_config
        and pagination_config.max_results is not None
        and len(documents) >= pagination_config.max_results
    ):
        documents = _fetch_all_pages(
            client,
            payload["next"],
            documents,
            pagination_config,
            request_timeout=request_timeout,
        )

    # Create CrawlJob with current status and data
    return CrawlJob(
        status=payload["status"],
        completed=payload["completed"],
        total=payload["total"],
        credits_used=payload["credits_used"],
        expires_at=payload["expires_at"],
        next=payload["next"] if not auto_paginate else None,
        data=documents,
    )


def get_crawl_status_page(
    client: HttpClient,
    next_url: str,
    *,
    request_timeout: Optional[float] = None,
) -> CrawlJob:
    """
    Fetch a single page of crawl results using the provided next URL.

    Args:
        client: HTTP client instance
        next_url: Opaque next URL from a prior crawl status response
        request_timeout: Timeout (in seconds) for the HTTP request

    Returns:
        CrawlJob with the page data and next URL (if any)

    Raises:
        Exception: If the request fails or returns an error response
    """
    response = client.get(next_url, timeout=request_timeout)

    if not response.ok:
        handle_response_error(response, "get crawl status page")

    response_data = response.json()
    payload = _parse_crawl_status_response(response_data)

    return CrawlJob(
        status=payload["status"],
        completed=payload["completed"],
        total=payload["total"],
        credits_used=payload["credits_used"],
        expires_at=payload["expires_at"],
        next=payload["next"],
        data=payload["data"],
    )


def _fetch_all_pages(
    client: HttpClient,
    next_url: str,
    initial_documents: List[Document],
    pagination_config: Optional[PaginationConfig] = None,
    *,
    request_timeout: Optional[float] = None,
) -> List[Document]:
    """
    Fetch all pages of crawl results.

    Args:
        client: HTTP client instance
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
        response = client.get(current_url, timeout=request_timeout)

        if not response.ok:
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
            # Check max_results limit BEFORE adding each document
            if max_results is not None and len(documents) >= max_results:
                break
            documents.append(document)

        # Check if we hit max_results limit
        if max_results is not None and len(documents) >= max_results:
            break

        # Get next URL
        current_url = page_payload["next"]
        page_count += 1

    return documents


def cancel_crawl(client: HttpClient, job_id: str) -> bool:
    """
    Cancel a running crawl job.
    
    Args:
        client: HTTP client instance
        job_id: ID of the crawl job to cancel
        
    Returns:
        bool: True if the crawl was cancelled, False otherwise
        
    Raises:
        Exception: If the cancellation fails
    """
    response = client.delete(f"/v2/crawl/{job_id}")
    
    if not response.ok:
        handle_response_error(response, "cancel crawl")
    
    response_data = response.json()
    
    return response_data.get("status") == "cancelled"

def wait_for_crawl_completion(
    client: HttpClient,
    job_id: str,
    poll_interval: int = 2,
    timeout: Optional[int] = None,
    *,
    request_timeout: Optional[float] = None,
) -> CrawlJob:
    """
    Wait for a crawl job to complete, polling for status updates.
    
    Args:
        client: HTTP client instance
        job_id: ID of the crawl job
        poll_interval: Seconds between status checks
        timeout: Maximum seconds to wait (None for no timeout)
        request_timeout: Optional timeout (in seconds) for each status request
        
    Returns:
        CrawlJob when job completes
        
    Raises:
        Exception: If the job fails
        TimeoutError: If timeout is reached
    """
    start_time = time.monotonic()
    
    while True:
        crawl_job = get_crawl_status(
            client,
            job_id,
            request_timeout=request_timeout,
        )
        
        # Check if job is complete
        if crawl_job.status in ["completed", "failed", "cancelled"]:
            return crawl_job
        
        # Check timeout
        if timeout is not None and (time.monotonic() - start_time) > timeout:
            raise TimeoutError(f"Crawl job {job_id} did not complete within {timeout} seconds")
        
        # Wait before next poll
        time.sleep(poll_interval)


def crawl(
    client: HttpClient,
    request: CrawlRequest,
    poll_interval: int = 2,
    timeout: Optional[int] = None,
    *,
    request_timeout: Optional[float] = None,
) -> CrawlJob:
    """
    Start a crawl job and wait for it to complete.
    
    Args:
        client: HTTP client instance
        request: CrawlRequest containing URL and options
        poll_interval: Seconds between status checks
        timeout: Maximum seconds to wait for the entire crawl job to complete (None for no timeout)
        request_timeout: Timeout (in seconds) for each individual HTTP request, including pagination 
            requests when fetching results. If there are multiple pages, each page request gets this timeout
        
    Returns:
        CrawlJob when job completes
        
    Raises:
        ValueError: If request is invalid
        Exception: If the crawl fails to start or complete
        TimeoutError: If timeout is reached
    """
    # Start the crawl
    crawl_job = start_crawl(client, request)
    job_id = crawl_job.id
    
    # Determine the per-request timeout. If not provided, reuse the overall timeout value.
    effective_request_timeout = request_timeout if request_timeout is not None else timeout

    # Wait for completion
    return wait_for_crawl_completion(
        client,
        job_id,
        poll_interval,
        timeout,
        request_timeout=effective_request_timeout,
    )


def crawl_params_preview(client: HttpClient, request: CrawlParamsRequest) -> CrawlParamsData:
    """
    Get crawl parameters from LLM based on URL and prompt.
    
    Args:
        client: HTTP client instance
        request: CrawlParamsRequest containing URL and prompt
        
    Returns:
        CrawlParamsData containing suggested crawl options
        
    Raises:
        ValueError: If request is invalid
        Exception: If the operation fails
    """
    # Validate request
    if not request.url or not request.url.strip():
        raise ValueError("URL cannot be empty")
    
    if not request.prompt or not request.prompt.strip():
        raise ValueError("Prompt cannot be empty")
    
    # Prepare request data
    request_data = {
        "url": request.url,
        "prompt": request.prompt
    }
    
    # Make the API request
    response = client.post("/v2/crawl/params-preview", request_data)
    
    # Handle errors
    if not response.ok:
        handle_response_error(response, "crawl params preview")
    
    # Parse response
    response_data = response.json()
    
    if response_data.get("success"):
        params_data = response_data.get("data", {})
        
        # Convert camelCase to snake_case for CrawlParamsData
        converted_params = {}
        field_mappings = {
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
            "zeroDataRetention": "zero_data_retention"
        }
        
        # Handle webhook conversion
        if "webhook" in params_data:
            webhook_data = params_data["webhook"]
            if isinstance(webhook_data, dict):
                converted_params["webhook"] = WebhookConfig(**webhook_data)
            else:
                converted_params["webhook"] = webhook_data
        
        for camel_case, snake_case in field_mappings.items():
            if camel_case in params_data:
                if camel_case == "scrapeOptions" and params_data[camel_case] is not None:
                    # Handle nested scrapeOptions conversion
                    scrape_opts_data = params_data[camel_case]
                    converted_scrape_opts = {}
                    scrape_field_mappings = {
                        "includeTags": "include_tags",
                        "excludeTags": "exclude_tags",
                        "onlyMainContent": "only_main_content",
                        "waitFor": "wait_for",
                        "skipTlsVerification": "skip_tls_verification",
                        "removeBase64Images": "remove_base64_images"
                    }
                    
                    for scrape_camel, scrape_snake in scrape_field_mappings.items():
                        if scrape_camel in scrape_opts_data:
                            converted_scrape_opts[scrape_snake] = scrape_opts_data[scrape_camel]
                    
                    # Handle formats field - if it's a list, convert to ScrapeFormats
                    if "formats" in scrape_opts_data:
                        formats_data = scrape_opts_data["formats"]
                        if isinstance(formats_data, list):
                            # Convert list to ScrapeFormats object
                            from ..types import ScrapeFormats
                            converted_scrape_opts["formats"] = ScrapeFormats(formats=formats_data)
                        else:
                            converted_scrape_opts["formats"] = formats_data
                    
                    # Add fields that don't need conversion
                    for key, value in scrape_opts_data.items():
                        if key not in scrape_field_mappings and key != "formats":
                            converted_scrape_opts[key] = value
                    
                    converted_params[snake_case] = converted_scrape_opts
                else:
                    converted_params[snake_case] = params_data[camel_case]
        
        # Add fields that don't need conversion
        for key, value in params_data.items():
            if key not in field_mappings:
                converted_params[key] = value
        
        # Add warning if present
        if "warning" in response_data:
            converted_params["warning"] = response_data["warning"]
        
        return CrawlParamsData(**converted_params)
    else:
        raise Exception(response_data.get("error", "Unknown error occurred"))


def get_crawl_errors(http_client: HttpClient, crawl_id: str) -> CrawlErrorsResponse:
    """
    Get errors from a crawl job.
    
    Args:
        http_client: HTTP client for making requests
        crawl_id: The ID of the crawl job
        
    Returns:
        CrawlErrorsResponse containing errors and robots blocked URLs
        
    Raises:
        Exception: If the request fails
    """
    response = http_client.get(f"/v2/crawl/{crawl_id}/errors")

    if not response.ok:
        handle_response_error(response, "check crawl errors")

    try:
        body = response.json()
        payload = body.get("data", body)
        # Manual key normalization since we avoid Pydantic aliases
        normalized = {
            "errors": payload.get("errors", []),
            "robots_blocked": payload.get("robotsBlocked", payload.get("robots_blocked", [])),
        }
        return CrawlErrorsResponse(**normalized)
    except Exception as e:
        raise Exception(f"Failed to parse crawl errors response: {e}")


def get_active_crawls(client: HttpClient) -> ActiveCrawlsResponse:
    """
    Get a list of currently active crawl jobs.
    
    Args:
        client: HTTP client instance
        
    Returns:
        ActiveCrawlsResponse containing a list of active crawl jobs
        
    Raises:
        Exception: If the request fails
    """
    response = client.get("/v2/crawl/active")

    if not response.ok:
        handle_response_error(response, "get active crawls")

    body = response.json()
    if not body.get("success"):
        raise Exception(body.get("error", "Unknown error occurred"))

    crawls_in = body.get("crawls", [])
    normalized_crawls = []
    for c in crawls_in:
        if isinstance(c, dict):
            normalized_crawls.append({
                "id": c.get("id"),
                "team_id": c.get("teamId", c.get("team_id")),
                "url": c.get("url"),
                "options": c.get("options"),
            })
    return ActiveCrawlsResponse(success=True, crawls=[ActiveCrawl(**nc) for nc in normalized_crawls])
