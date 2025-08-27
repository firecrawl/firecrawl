"""
Async v2 client mirroring the regular client surface using true async HTTP transport.
"""

import os
import asyncio
from typing import Optional, List, Dict, Any, Union, Callable, Literal
from .types import (
    ScrapeOptions,
    CrawlRequest,
    WebhookConfig,
    SearchRequest,
    SearchData,
    SourceOption,
    CrawlResponse,
    CrawlJob,
    CrawlParamsRequest,
    CrawlParamsData,
    CrawlErrorsResponse,
    ActiveCrawlsResponse,
    MapOptions,
    MapData,
    FormatOption,
    WaitAction,
    ScreenshotAction,
    ClickAction,
    WriteAction,
    PressAction,
    ScrollAction,
    ScrapeAction,
    ExecuteJavascriptAction,
    PDFAction,
    Location,
)
from .utils.http_client import HttpClient
from .utils.http_client_async import AsyncHttpClient

from .methods.aio import scrape as async_scrape  # type: ignore[attr-defined]
from .methods.aio import batch as async_batch  # type: ignore[attr-defined]
from .methods.aio import crawl as async_crawl  # type: ignore[attr-defined]
from .methods.aio import search as async_search  # type: ignore[attr-defined]
from .methods.aio import map as async_map # type: ignore[attr-defined]
from .methods.aio import usage as async_usage # type: ignore[attr-defined]
from .methods.aio import extract as async_extract  # type: ignore[attr-defined]

from .watcher_async import AsyncWatcher

class AsyncFirecrawlClient:
    def __init__(self, api_key: Optional[str] = None, api_url: str = "https://api.firecrawl.dev"):
        if api_key is None:
            api_key = os.getenv("FIRECRAWL_API_KEY")
        if not api_key:
            raise ValueError("API key is required. Set FIRECRAWL_API_KEY or pass api_key.")
        self.http_client = HttpClient(api_key, api_url)
        self.async_http_client = AsyncHttpClient(api_key, api_url)

    # Scrape
    async def scrape(
        self,
        url: str,
        **kwargs,
    ):
        options = ScrapeOptions(**{k: v for k, v in kwargs.items() if v is not None}) if kwargs else None
        return await async_scrape.scrape(self.async_http_client, url, options)

    # Search
    async def search(
        self,
        query: str,
        **kwargs,
    ) -> SearchData:
        request = SearchRequest(query=query, **{k: v for k, v in kwargs.items() if v is not None})
        return await async_search.search(self.async_http_client, request)

    async def start_crawl(self, url: str, **kwargs) -> CrawlResponse:
        request = CrawlRequest(url=url, **kwargs)
        return await async_crawl.start_crawl(self.async_http_client, request)

    async def wait_crawl(self, job_id: str, poll_interval: int = 2, timeout: Optional[int] = None) -> CrawlJob:
        # simple polling loop using blocking get (ok for test-level async)
        start = asyncio.get_event_loop().time()
        while True:
            status = await async_crawl.get_crawl_status(self.async_http_client, job_id)
            if status.status in ["completed", "failed"]:
                return status
            if timeout and (asyncio.get_event_loop().time() - start) > timeout:
                raise TimeoutError("Crawl wait timed out")
            await asyncio.sleep(poll_interval)

    async def crawl(self, **kwargs) -> CrawlJob:
        # wrapper combining start and wait
        resp = await self.start_crawl(**{k: v for k, v in kwargs.items() if k not in ("poll_interval", "timeout")})
        poll_interval = kwargs.get("poll_interval", 2)
        timeout = kwargs.get("timeout")
        return await self.wait_crawl(resp.id, poll_interval=poll_interval, timeout=timeout)

    async def get_crawl_status(self, job_id: str) -> CrawlJob:
        return await async_crawl.get_crawl_status(self.async_http_client, job_id)

    async def cancel_crawl(self, job_id: str) -> bool:
        return await async_crawl.cancel_crawl(self.async_http_client, job_id)

    async def crawl_params_preview(self, url: str, prompt: str) -> CrawlParamsData:
        req = CrawlParamsRequest(url=url, prompt=prompt)
        return await async_crawl.crawl_params_preview(self.async_http_client, req)

    async def get_crawl_errors(self, crawl_id: str) -> CrawlErrorsResponse:
        return await async_crawl.get_crawl_errors(self.async_http_client, crawl_id)

    async def get_active_crawls(self) -> ActiveCrawlsResponse:
        return await async_crawl.get_active_crawls(self.async_http_client)

    async def active_crawls(self) -> ActiveCrawlsResponse:
        return await self.get_active_crawls()

    # Map
    async def map(
        self,
        url: str,
        *,
        search: Optional[str] = None,
        include_subdomains: Optional[bool] = None,
        limit: Optional[int] = None,
        sitemap: Optional[Literal["only", "include", "skip"]] = None,
        timeout: Optional[int] = None,
    ) -> MapData:
        options = MapOptions(
            search=search,
            include_subdomains=include_subdomains,
            limit=limit,
            sitemap=sitemap if sitemap is not None else "include",
            timeout=timeout,
        ) if any(v is not None for v in [search, include_subdomains, limit, sitemap, timeout]) else None
        return await async_map.map(self.async_http_client, url, options)

    async def start_batch_scrape(self, urls: List[str], **kwargs) -> Any:
        return await async_batch.start_batch_scrape(self.async_http_client, urls, **kwargs)

    async def wait_batch_scrape(self, job_id: str, poll_interval: int = 2, timeout: Optional[int] = None) -> Any:
        start = asyncio.get_event_loop().time()
        while True:
            status = await async_batch.get_batch_scrape_status(self.async_http_client, job_id)
            if status.status in ["completed", "failed", "cancelled"]:
                return status
            if timeout and (asyncio.get_event_loop().time() - start) > timeout:
                raise TimeoutError("Batch wait timed out")
            await asyncio.sleep(poll_interval)

    async def batch_scrape(self, urls: List[str], **kwargs) -> Any:
        # waiter wrapper
        start = await self.start_batch_scrape(urls, **{k: v for k, v in kwargs.items() if k not in ("poll_interval", "timeout")})
        job_id = start.id
        poll_interval = kwargs.get("poll_interval", 2)
        timeout = kwargs.get("timeout")
        return await self.wait_batch_scrape(job_id, poll_interval=poll_interval, timeout=timeout)

    async def get_batch_scrape_status(self, job_id: str):
        return await async_batch.get_batch_scrape_status(self.async_http_client, job_id)

    async def cancel_batch_scrape(self, job_id: str) -> bool:
        return await async_batch.cancel_batch_scrape(self.async_http_client, job_id)

    async def get_batch_scrape_errors(self, job_id: str) -> CrawlErrorsResponse:
        # Returns v2 errors structure; typed as CrawlErrorsResponse for parity
        return await async_batch.get_batch_scrape_errors(self.async_http_client, job_id)  # type: ignore[return-value]

    # Extract (proxy to v1 async)
    async def extract(
        self,
        urls: Optional[List[str]] = None,
        *,
        prompt: Optional[str] = None,
        schema: Optional[Dict[str, Any]] = None,
        system_prompt: Optional[str] = None,
        allow_external_links: Optional[bool] = None,
        enable_web_search: Optional[bool] = None,
        show_sources: Optional[bool] = None,
        scrape_options: Optional['ScrapeOptions'] = None,
        ignore_invalid_urls: Optional[bool] = None,
        poll_interval: int = 2,
        timeout: Optional[int] = None,
    ):
        return await async_extract.extract(
            self.async_http_client,
            urls,
            prompt=prompt,
            schema=schema,
            system_prompt=system_prompt,
            allow_external_links=allow_external_links,
            enable_web_search=enable_web_search,
            show_sources=show_sources,
            scrape_options=scrape_options,
            ignore_invalid_urls=ignore_invalid_urls,
            poll_interval=poll_interval,
            timeout=timeout,
        )

    async def get_extract_status(self, job_id: str):
        return await async_extract.get_extract_status(self.async_http_client, job_id)

    async def start_extract(
        self,
        urls: Optional[List[str]] = None,
        *,
        prompt: Optional[str] = None,
        schema: Optional[Dict[str, Any]] = None,
        system_prompt: Optional[str] = None,
        allow_external_links: Optional[bool] = None,
        enable_web_search: Optional[bool] = None,
        show_sources: Optional[bool] = None,
        scrape_options: Optional['ScrapeOptions'] = None,
        ignore_invalid_urls: Optional[bool] = None,
    ):
        return await async_extract.start_extract(
            self.async_http_client,
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

    # Usage endpoints
    async def get_concurrency(self):
        from .methods.aio import usage as async_usage  # type: ignore[attr-defined]
        return await async_usage.get_concurrency(self.async_http_client)

    async def get_credit_usage(self):
        from .methods.aio import usage as async_usage  # type: ignore[attr-defined]
        return await async_usage.get_credit_usage(self.async_http_client)

    async def get_token_usage(self):
        from .methods.aio import usage as async_usage  # type: ignore[attr-defined]
        return await async_usage.get_token_usage(self.async_http_client)

    # Watcher (sync object usable from async contexts)
    def watcher(
        self,
        job_id: str,
        *,
        kind: Literal["crawl", "batch"] = "crawl",
        poll_interval: int = 2,
        timeout: Optional[int] = None,
    ) -> AsyncWatcher:
        return AsyncWatcher(self, job_id, kind=kind, poll_interval=poll_interval, timeout=timeout)

