"""
Batch scraping functionality for Firecrawl v2 API.
"""

import time
from typing import Optional, List, Callable, Dict, Any, Union
from ..types import (
    BatchScrapeRequest,
    BatchScrapeResponse,
    BatchScrapeJob,
    ScrapeOptions,
    Document,
    WebhookConfig,
    PaginationConfig,
)
from ..utils import HttpClient, handle_response_error, validate_scrape_options, prepare_scrape_options
from ..utils.normalize import normalize_document_input
from ..types import CrawlErrorsResponse


def start_batch_scrape(
    client: HttpClient,
    urls: List[str],
    *,
    options: Optional[ScrapeOptions] = None,
    webhook: Optional[Union[str, WebhookConfig]] = None,
    append_to_id: Optional[str] = None,
    ignore_invalid_urls: Optional[bool] = None,
    max_concurrency: Optional[int] = None,
    zero_data_retention: Optional[bool] = None,
    integration: Optional[str] = None,
    idempotency_key: Optional[str] = None,
) -> BatchScrapeResponse:
    """
    Start a batch scrape job for multiple URLs.
    
    Args:
        client: HTTP client instance
        urls: List of URLs to scrape
        options: Scraping options
        
    Returns:
        BatchScrapeResponse containing job information
        
    Raises:
        FirecrawlError: If the batch scrape operation fails to start
    """
    # Prepare request data
    request_data = prepare_batch_scrape_request(
        urls,
        options=options,
        webhook=webhook,
        append_to_id=append_to_id,
        ignore_invalid_urls=ignore_invalid_urls,
        max_concurrency=max_concurrency,
        zero_data_retention=zero_data_retention,
        integration=integration,
    )
    
    # Make the API request
    headers = client._prepare_headers(idempotency_key)  # type: ignore[attr-defined]
    response = client.post("/v2/batch/scrape", request_data, headers=headers)
    
    # Handle errors
    if not response.ok:
        handle_response_error(response, "start batch scrape")
    
    # Parse response
    body = response.json()
    if not body.get("success"):
        raise Exception(body.get("error", "Unknown error occurred"))
    return BatchScrapeResponse(
        id=body.get("id"),
        url=body.get("url"),
        invalid_urls=body.get("invalidURLs") or None,
    )


def get_batch_scrape_status(
    client: HttpClient,
    job_id: str,
    pagination_config: Optional[PaginationConfig] = None
) -> BatchScrapeJob:
    """
    Get the status of a batch scrape job.
    
    Args:
        client: HTTP client instance
        job_id: ID of the batch scrape job
        pagination_config: Optional configuration for pagination behavior
        
    Returns:
        BatchScrapeJob containing job status and data
        
    Raises:
        FirecrawlError: If the status check fails
    """
    # Make the API request
    response = client.get(f"/v2/batch/scrape/{job_id}")
    
    # Handle errors
    if not response.ok:
        handle_response_error(response, "get batch scrape status")
    
    # Parse response
    body = response.json()
    if not body.get("success"):
        raise Exception(body.get("error", "Unknown error occurred"))

    # Convert documents
    documents: List[Document] = []
    for doc in body.get("data", []) or []:
        if isinstance(doc, dict):
            normalized = normalize_document_input(doc)
            documents.append(Document(**normalized))

    # Handle pagination if requested
    auto_paginate = pagination_config.auto_paginate if pagination_config else True
    if auto_paginate and body.get("next"):
        documents = _fetch_all_batch_pages(
            client, 
            body.get("next"), 
            documents, 
            pagination_config
        )

    return BatchScrapeJob(
        status=body.get("status"),
        completed=body.get("completed", 0),
        total=body.get("total", 0),
        credits_used=body.get("creditsUsed"),
        expires_at=body.get("expiresAt"),
        next=body.get("next") if not auto_paginate else None,
        data=documents,
    )


def _fetch_all_batch_pages(
    client: HttpClient,
    next_url: str,
    initial_documents: List[Document],
    pagination_config: Optional[PaginationConfig] = None
) -> List[Document]:
    """
    Fetch all pages of batch scrape results.
    
    Args:
        client: HTTP client instance
        next_url: URL for the next page
        initial_documents: Documents from the first page
        pagination_config: Optional configuration for pagination limits
        
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
        response = client.get(current_url)
        
        if not response.ok:
            # Log error but continue with what we have
            import logging
            logger = logging.getLogger("firecrawl")
            logger.warning("Failed to fetch next page", extra={"status_code": response.status_code})
            break
        
        page_data = response.json()
        
        if not page_data.get("success"):
            break
        
        # Add documents from this page
        for doc in page_data.get("data", []) or []:
            if isinstance(doc, dict):
                # Check max_results limit
                if max_results is not None and len(documents) >= max_results:
                    break
                normalized = normalize_document_input(doc)
                documents.append(Document(**normalized))
        
        # Check if we hit max_results limit after adding all docs from this page
        if max_results is not None and len(documents) >= max_results:
            break
        
        # Get next URL
        current_url = page_data.get("next")
        page_count += 1
    
    return documents


def cancel_batch_scrape(
    client: HttpClient,
    job_id: str
) -> bool:
    """
    Cancel a running batch scrape job.
    
    Args:
        client: HTTP client instance
        job_id: ID of the batch scrape job to cancel
        
    Returns:
        BatchScrapeStatusResponse with updated status
        
    Raises:
        FirecrawlError: If the cancellation fails
    """
    # Make the API request
    response = client.delete(f"/v2/batch/scrape/{job_id}")
    
    # Handle errors
    if not response.ok:
        handle_response_error(response, "cancel batch scrape")
    
    # Parse response
    body = response.json()
    return body.get("status") == "cancelled"


def wait_for_batch_completion(
    client: HttpClient,
    job_id: str,
    poll_interval: int = 2,
    timeout: Optional[int] = None
) -> BatchScrapeJob:
    """
    Wait for a batch scrape job to complete, polling for status updates.
    
    Args:
        client: HTTP client instance
        job_id: ID of the batch scrape job
        poll_interval: Seconds between status checks
        timeout: Maximum seconds to wait (None for no timeout)
        
    Returns:
        BatchScrapeStatusResponse when job completes
        
    Raises:
        FirecrawlError: If the job fails or timeout is reached
        TimeoutError: If timeout is reached
    """
    start_time = time.monotonic()
    
    while True:
        status_job = get_batch_scrape_status(client, job_id)
        
        # Check if job is complete
        if status_job.status in ["completed", "failed", "cancelled"]:
            return status_job
        
        # Check timeout
        if timeout and (time.monotonic() - start_time) > timeout:
            raise TimeoutError(f"Batch scrape job {job_id} did not complete within {timeout} seconds")
        
        # Wait before next poll
        time.sleep(poll_interval)


def batch_scrape(
    client: HttpClient,
    urls: List[str],
    *,
    options: Optional[ScrapeOptions] = None,
    webhook: Optional[Union[str, WebhookConfig]] = None,
    append_to_id: Optional[str] = None,
    ignore_invalid_urls: Optional[bool] = None,
    max_concurrency: Optional[int] = None,
    zero_data_retention: Optional[bool] = None,
    integration: Optional[str] = None,
    idempotency_key: Optional[str] = None,
    poll_interval: int = 2,
    timeout: Optional[int] = None
) -> BatchScrapeJob:
    """
    Start a batch scrape job and wait for it to complete.
    
    Args:
        client: HTTP client instance
        urls: List of URLs to scrape
        options: Scraping options
        poll_interval: Seconds between status checks
        timeout: Maximum seconds to wait (None for no timeout)
        
    Returns:
        BatchScrapeStatusResponse when job completes
        
    Raises:
        FirecrawlError: If the batch scrape fails to start or complete
        TimeoutError: If timeout is reached
    """
    # Start the batch scrape
    start = start_batch_scrape(
        client,
        urls,
        options=options,
        webhook=webhook,
        append_to_id=append_to_id,
        ignore_invalid_urls=ignore_invalid_urls,
        max_concurrency=max_concurrency,
        zero_data_retention=zero_data_retention,
        integration=integration,
        idempotency_key=idempotency_key,
    )

    job_id = start.id

    # Wait for completion
    return wait_for_batch_completion(
        client, job_id, poll_interval, timeout
    )


def validate_batch_urls(urls: List[str]) -> List[str]:
    """
    Validate and normalize a list of URLs for batch scraping.
    
    Args:
        urls: List of URLs to validate
        
    Returns:
        Validated list of URLs
        
    Raises:
        ValueError: If URLs are invalid
    """
    if not urls:
        raise ValueError("URLs list cannot be empty")
    
    validated_urls = []
    for url in urls:
        if not url or not isinstance(url, str):
            raise ValueError(f"Invalid URL: {url}")
        
        # Basic URL validation
        if not (url.startswith("http://") or url.startswith("https://")):
            raise ValueError(f"URL must start with http:// or https://: {url}")
        
        validated_urls.append(url.strip())
    
    return validated_urls


def prepare_batch_scrape_request(
    urls: List[str],
    *,
    options: Optional[ScrapeOptions] = None,
    webhook: Optional[Union[str, WebhookConfig]] = None,
    append_to_id: Optional[str] = None,
    ignore_invalid_urls: Optional[bool] = None,
    max_concurrency: Optional[int] = None,
    zero_data_retention: Optional[bool] = None,
    integration: Optional[str] = None,
) -> dict:
    """
    Prepare a batch scrape request payload.
    
    Args:
        urls: List of URLs to scrape
        options: Scraping options
        
    Returns:
        Request payload dictionary
    """
    validated_urls = validate_batch_urls(urls)
    request_data: Dict[str, Any] = {"urls": validated_urls}

    # Flatten scrape options at the top level (v2 behavior)
    if options:
        scrape_data = prepare_scrape_options(options)
        if scrape_data:
            request_data.update(scrape_data)

    # Batch-specific fields
    if webhook is not None:
        if isinstance(webhook, str):
            request_data["webhook"] = webhook
        else:
            request_data["webhook"] = webhook.model_dump(exclude_none=True)
    if append_to_id is not None:
        request_data["appendToId"] = append_to_id
    if ignore_invalid_urls is not None:
        request_data["ignoreInvalidURLs"] = ignore_invalid_urls
    if max_concurrency is not None:
        request_data["maxConcurrency"] = max_concurrency
    if zero_data_retention is not None:
        request_data["zeroDataRetention"] = zero_data_retention
    if integration is not None:
        request_data["integration"] = str(integration).strip()

    return request_data


def chunk_urls(urls: List[str], chunk_size: int = 100) -> List[List[str]]:
    """
    Split a large list of URLs into smaller chunks for batch processing.
    
    Args:
        urls: List of URLs to chunk
        chunk_size: Maximum size of each chunk
        
    Returns:
        List of URL chunks
    """
    chunks = []
    for i in range(0, len(urls), chunk_size):
        chunks.append(urls[i:i + chunk_size])
    return chunks


def process_large_batch(
    client: HttpClient,
    urls: List[str],
    options: Optional[ScrapeOptions] = None,
    chunk_size: int = 100,
    poll_interval: int = 2,
    timeout: Optional[int] = None
) -> List[Document]:
    """
    Process a large batch of URLs by splitting into smaller chunks.
    
    Args:
        client: HTTP client instance
        urls: List of URLs to scrape
        options: Scraping options
        chunk_size: Size of each batch chunk
        poll_interval: Seconds between status checks
        timeout: Maximum seconds to wait per chunk
        
    Returns:
        List of all scraped documents
        
    Raises:
        FirecrawlError: If any chunk fails
    """
    url_chunks = chunk_urls(urls, chunk_size)
    all_documents = []
    completed_chunks = 0
    
    for chunk in url_chunks:
        # Process this chunk
        result = batch_scrape(
            client,
            chunk,
            options=options,
            poll_interval=poll_interval,
            timeout=timeout,
        )

        # Add documents from this chunk
        if result.data:
            all_documents.extend(result.data)
        
        completed_chunks += 1
    
    return all_documents


def get_batch_scrape_errors(client: HttpClient, job_id: str) -> CrawlErrorsResponse:
    """
    Get errors for a batch scrape job.

    Args:
        client: HTTP client instance
        job_id: ID of the batch scrape job

    Returns:
        CrawlErrorsResponse with errors and robots-blocked URLs
    """
    response = client.get(f"/v2/batch/scrape/{job_id}/errors")

    if not response.ok:
        handle_response_error(response, "get batch scrape errors")

    body = response.json()
    payload = body.get("data", body)
    normalized = {
        "errors": payload.get("errors", []),
        "robots_blocked": payload.get("robotsBlocked", payload.get("robots_blocked", [])),
    }
    return CrawlErrorsResponse(**normalized)