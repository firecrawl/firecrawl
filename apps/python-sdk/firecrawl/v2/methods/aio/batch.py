from typing import Optional, List, Dict, Any
from ...types import ScrapeOptions, WebhookConfig, Document, BatchScrapeResponse, BatchScrapeJob
from ...utils.http_client_async import AsyncHttpClient
from ...utils.validation import prepare_scrape_options
from ...utils.error_handler import handle_response_error


def _prepare(urls: List[str], *, options: Optional[ScrapeOptions] = None, **kwargs) -> Dict[str, Any]:
    if not urls:
        raise ValueError("URLs list cannot be empty")
    payload: Dict[str, Any] = {"urls": [u.strip() for u in urls]}
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
        payload["integration"] = v
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


async def get_batch_scrape_status(client: AsyncHttpClient, job_id: str) -> BatchScrapeJob:
    response = await client.get(f"/v2/batch/scrape/{job_id}")
    if response.status_code >= 400:
        handle_response_error(response, "get batch scrape status")
    body = response.json()
    if not body.get("success"):
        raise Exception(body.get("error", "Unknown error occurred"))
    docs: List[Document] = []
    for doc in body.get("data", []) or []:
        if isinstance(doc, dict):
            normalized = dict(doc)
            if 'rawHtml' in normalized and 'raw_html' not in normalized:
                normalized['raw_html'] = normalized.pop('rawHtml')
            if 'changeTracking' in normalized and 'change_tracking' not in normalized:
                normalized['change_tracking'] = normalized.pop('changeTracking')
            docs.append(Document(**normalized))
    return BatchScrapeJob(
        status=body.get("status"),
        completed=body.get("completed", 0),
        total=body.get("total", 0),
        credits_used=body.get("creditsUsed"),
        expires_at=body.get("expiresAt"),
        next=body.get("next"),
        data=docs,
    )


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

