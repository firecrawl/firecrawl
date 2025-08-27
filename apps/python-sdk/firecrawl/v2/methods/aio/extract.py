from typing import Any, Dict, List, Optional
import asyncio

from ...types import ExtractResponse, ScrapeOptions
from ...utils.http_client_async import AsyncHttpClient
from ...utils.validation import prepare_scrape_options


def _prepare_extract_request(
    urls: Optional[List[str]],
    *,
    prompt: Optional[str] = None,
    schema: Optional[Dict[str, Any]] = None,
    system_prompt: Optional[str] = None,
    allow_external_links: Optional[bool] = None,
    enable_web_search: Optional[bool] = None,
    show_sources: Optional[bool] = None,
    scrape_options: Optional[ScrapeOptions] = None,
    ignore_invalid_urls: Optional[bool] = None,
) -> Dict[str, Any]:
    body: Dict[str, Any] = {}
    if urls is not None:
        body["urls"] = urls
    if prompt is not None:
        body["prompt"] = prompt
    if schema is not None:
        body["schema"] = schema
    if system_prompt is not None:
        body["systemPrompt"] = system_prompt
    if allow_external_links is not None:
        body["allowExternalLinks"] = allow_external_links
    if enable_web_search is not None:
        body["enableWebSearch"] = enable_web_search
    if show_sources is not None:
        body["showSources"] = show_sources
    if ignore_invalid_urls is not None:
        body["ignoreInvalidURLs"] = ignore_invalid_urls
    if scrape_options is not None:
        prepared = prepare_scrape_options(scrape_options)
        if prepared:
            body["scrapeOptions"] = prepared
    return body


async def start_extract(
    client: AsyncHttpClient,
    urls: Optional[List[str]],
    *,
    prompt: Optional[str] = None,
    schema: Optional[Dict[str, Any]] = None,
    system_prompt: Optional[str] = None,
    allow_external_links: Optional[bool] = None,
    enable_web_search: Optional[bool] = None,
    show_sources: Optional[bool] = None,
    scrape_options: Optional[ScrapeOptions] = None,
    ignore_invalid_urls: Optional[bool] = None,
) -> ExtractResponse:
    body = _prepare_extract_request(
        urls,
        prompt=prompt,
        schema=schema,
        system_prompt=system_prompt,
        allow_external_links=allow_external_links,
        enable_web_search=enable_web_search,
        show_sources=show_sources,
        scrape_options=scrape_options,
        ignore_invalid_urls=ignore_invalid_urls,
    )
    resp = await client.post("/v2/extract", body)
    return ExtractResponse(**resp.json())


async def get_extract_status(client: AsyncHttpClient, job_id: str) -> ExtractResponse:
    resp = await client.get(f"/v2/extract/{job_id}")
    return ExtractResponse(**resp.json())


async def wait_extract(
    client: AsyncHttpClient,
    job_id: str,
    *,
    poll_interval: int = 2,
    timeout: Optional[int] = None,
) -> ExtractResponse:
    start_ts = asyncio.get_event_loop().time()
    while True:
        status = await get_extract_status(client, job_id)
        if status.status in ("completed", "failed", "cancelled"):
            return status
        if timeout is not None and (asyncio.get_event_loop().time() - start_ts) > timeout:
            return status
        await asyncio.sleep(max(1, poll_interval))


async def extract(
    client: AsyncHttpClient,
    urls: Optional[List[str]],
    *,
    prompt: Optional[str] = None,
    schema: Optional[Dict[str, Any]] = None,
    system_prompt: Optional[str] = None,
    allow_external_links: Optional[bool] = None,
    enable_web_search: Optional[bool] = None,
    show_sources: Optional[bool] = None,
    scrape_options: Optional[ScrapeOptions] = None,
    ignore_invalid_urls: Optional[bool] = None,
    poll_interval: int = 2,
    timeout: Optional[int] = None,
) -> ExtractResponse:
    started = await start_extract(
        client,
        urls,
        prompt=prompt,
        schema=schema,
        system_prompt=system_prompt,
        allow_external_links=allow_external_links,
        enable_web_search=enable_web_search,
        show_sources=show_sources,
        scrape_options=scrape_options,
        ignore_invalid_urls=ignore_invalid_urls,
    )
    job_id = getattr(started, "id", None)
    if not job_id:
        return started
    return await wait_extract(client, job_id, poll_interval=poll_interval, timeout=timeout)

