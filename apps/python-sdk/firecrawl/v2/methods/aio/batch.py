from typing import Optional, List, Dict, Any
from ...types import ScrapeOptions, WebhookConfig, Document, BatchScrapeResponse, BatchScrapeJob, PaginationConfig
from ...utils.http_client_async import AsyncHttpClient
from ...utils.validation import prepare_scrape_options
from ...utils.error_handler import handle_response_error
from ...utils.normalize import normalize_document_input
from ...methods.batch import validate_batch_urls
import time

def _prepare(urls: List[str], *, options: Optional[ScrapeOptions] = None, **kwargs) -> Dict[str, Any]:
    if not urls:
        raise ValueError("URLs list cannot be empty")

    validated_urls = validate_batch_urls([u.strip() if isinstance(u, str) else u for u in urls])
    payload: Dict[str, Any] = {"urls": validated_urls}
    if options:
        opts = prepare_scrape_options(options)
        if opts:
            payload.update(opts)
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
    if not body.get("success"):
        raise Exception(body.get("error", "Unknown error occurred"))
    docs: List[Document] = []
    for doc in body.get("data", []) or []:
        if isinstance(doc, dict):
            normalized = normalize_document_input(doc)
            docs.append(Document(**normalized))
    
    # Handle pagination if requested
    auto_paginate = pagination_config.auto_paginate if pagination_config else True
    if auto_paginate and body.get("next"):
        docs = await _fetch_all_batch_pages_async(
            client, 
            body.get("next"), 
            docs, 
            pagination_config
        )
    
    return BatchScrapeJob(
        status=body.get("status"),
        completed=body.get("completed", 0),
        total=body.get("total", 0),
        credits_used=body.get("creditsUsed"),
        expires_at=body.get("expiresAt"),
        next=body.get("next") if not auto_paginate else None,
        data=docs,
    )


async def _fetch_all_batch_pages_async(
    client: AsyncHttpClient,
    next_url: str,
    initial_documents: List[Document],
    pagination_config: Optional[PaginationConfig] = None
) -> List[Document]:
    """
    Fetch all pages of batch scrape results asynchronously.
    
    Args:
        client: Async HTTP client instance
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
        # Check pagination limits
        if (max_pages is not None) and (page_count >= max_pages):
            break
            
        if (max_wait_time is not None) and (time.monotonic() - start_time) > max_wait_time:
            break
        
        # Fetch next page
        response = await client.get(current_url)
        
        if response.status_code >= 400:
            # Log error but continue with what we have
            import logging
            logger = logging.getLogger("firecrawl")
            logger.warning(f"Failed to fetch next page: {response.status_code}")
            break
        
        page_data = response.json()
        
        if not page_data.get("success"):
            break
        
        # Add documents from this page
        for doc in page_data.get("data", []) or []:
            if isinstance(doc, dict):
                # Check max_results limit
                if (max_results is not None) and (len(documents) >= max_results):
                    break
                normalized = normalize_document_input(doc)
                documents.append(Document(**normalized))
        
        # Check if we hit max_results limit
        if (max_results is not None) and (len(documents) >= max_results):
            break
        
        # Get next URL
        current_url = page_data.get("next")
        page_count += 1
    
    return documents


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

