from typing import Optional, Dict, Any
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
)
from ...utils.error_handler import handle_response_error
from ...utils.validation import prepare_scrape_options
from ...utils.http_client_async import AsyncHttpClient
from ...utils.normalize import normalize_document_input


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
        "ignore_sitemap": "ignoreSitemap",
        "ignore_query_parameters": "ignoreQueryParameters",
        "crawl_entire_domain": "crawlEntireDomain",
        "allow_external_links": "allowExternalLinks",
        "allow_subdomains": "allowSubdomains",
        "delay": "delay",
        "max_concurrency": "maxConcurrency",
        "zero_data_retention": "zeroDataRetention",
    }
    for snake, camel in field_mappings.items():
        if snake in request_data:
            data[camel] = request_data.pop(snake)
    data.update(request_data)
    return data


async def start_crawl(client: AsyncHttpClient, request: CrawlRequest) -> CrawlResponse:
    payload = _prepare_crawl_request(request)
    response = await client.post("/v2/crawl", payload)
    if response.status_code >= 400:
        handle_response_error(response, "start crawl")
    body = response.json()
    if body.get("success"):
        return CrawlResponse(id=body.get("id"), url=body.get("url"))
    raise Exception(body.get("error", "Unknown error occurred"))


async def get_crawl_status(client: AsyncHttpClient, job_id: str) -> CrawlJob:
    response = await client.get(f"/v2/crawl/{job_id}")
    if response.status_code >= 400:
        handle_response_error(response, "get crawl status")
    body = response.json()
    if body.get("success"):
        documents = []
        for doc_data in body.get("data", []):
            if isinstance(doc_data, dict):
                normalized = normalize_document_input(doc_data)
                documents.append(Document(**normalized))
        return CrawlJob(
            status=body.get("status"),
            completed=body.get("completed", 0),
            total=body.get("total", 0),
            credits_used=body.get("creditsUsed", 0),
            expires_at=body.get("expiresAt"),
            next=body.get("next"),
            data=documents,
        )
    raise Exception(body.get("error", "Unknown error occurred"))


async def cancel_crawl(client: AsyncHttpClient, job_id: str) -> bool:
    response = await client.delete(f"/v2/crawl/{job_id}")
    if response.status_code >= 400:
        handle_response_error(response, "cancel crawl")
    body = response.json()
    return body.get("status") == "cancelled"


async def crawl_params_preview(client: AsyncHttpClient, request: CrawlParamsRequest) -> CrawlParamsData:
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
        "ignoreSitemap": "ignore_sitemap",
        "ignoreQueryParameters": "ignore_query_parameters",
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

