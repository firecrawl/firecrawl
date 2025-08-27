"""
Crawling functionality for Firecrawl v2 API.
"""

import time
from typing import Optional, Dict, Any
from ..types import (
    CrawlRequest,
    CrawlJob,
    CrawlResponse, Document, CrawlParamsRequest, CrawlParamsResponse, CrawlParamsData,
    WebhookConfig, CrawlErrorsResponse, ActiveCrawlsResponse, ActiveCrawl
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
        "crawl_entire_domain": "crawlEntireDomain",
        "allow_external_links": "allowExternalLinks",
        "allow_subdomains": "allowSubdomains",
        "delay": "delay",
        "max_concurrency": "maxConcurrency",
        "zero_data_retention": "zeroDataRetention"
    }
    
    # Apply field mappings
    for snake_case, camel_case in field_mappings.items():
        if snake_case in request_data:
            data[camel_case] = request_data.pop(snake_case)
    
    # Add any remaining fields that don't need conversion (like limit)
    data.update(request_data)
    
    return data


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


def get_crawl_status(client: HttpClient, job_id: str) -> CrawlJob:
    """
    Get the status of a crawl job.
    
    Args:
        client: HTTP client instance
        job_id: ID of the crawl job
        
    Returns:
        CrawlJob with current status and data
        
    Raises:
        Exception: If the status check fails
    """
    # Make the API request
    response = client.get(f"/v2/crawl/{job_id}")
    
    # Handle errors
    if not response.ok:
        handle_response_error(response, "get crawl status")
    
    # Parse response
    response_data = response.json()
    
    if response_data.get("success"):
        # The API returns status fields at the top level, not in a data field
        
        # Convert documents
        documents = []
        data_list = response_data.get("data", [])
        for doc_data in data_list:
            if isinstance(doc_data, str):
                # Handle case where API returns just URLs - this shouldn't happen for crawl
                # but we'll handle it gracefully
                continue
            else:
                documents.append(Document(**normalize_document_input(doc_data)))
        
        # Create CrawlJob with current status and data
        return CrawlJob(
            status=response_data.get("status"),
            completed=response_data.get("completed", 0),
            total=response_data.get("total", 0),
            credits_used=response_data.get("creditsUsed", 0),
            expires_at=response_data.get("expiresAt"),
            next=response_data.get("next", None),
            data=documents
        )
    else:
        raise Exception(response_data.get("error", "Unknown error occurred"))


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
    timeout: Optional[int] = None
) -> CrawlJob:
    """
    Wait for a crawl job to complete, polling for status updates.
    
    Args:
        client: HTTP client instance
        job_id: ID of the crawl job
        poll_interval: Seconds between status checks
        timeout: Maximum seconds to wait (None for no timeout)
        
    Returns:
        CrawlJob when job completes
        
    Raises:
        Exception: If the job fails
        TimeoutError: If timeout is reached
    """
    start_time = time.time()
    
    while True:
        crawl_job = get_crawl_status(client, job_id)
        
        # Check if job is complete
        if crawl_job.status in ["completed", "failed"]:
            return crawl_job
        
        # Check timeout
        if timeout and (time.time() - start_time) > timeout:
            raise TimeoutError(f"Crawl job {job_id} did not complete within {timeout} seconds")
        
        # Wait before next poll
        time.sleep(poll_interval)


def crawl(
    client: HttpClient,
    request: CrawlRequest,
    poll_interval: int = 2,
    timeout: Optional[int] = None
) -> CrawlJob:
    """
    Start a crawl job and wait for it to complete.
    
    Args:
        client: HTTP client instance
        request: CrawlRequest containing URL and options
        poll_interval: Seconds between status checks
        timeout: Maximum seconds to wait (None for no timeout)
        
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
    
    # Wait for completion
    return wait_for_crawl_completion(
        client, job_id, poll_interval, timeout
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
