"""
Async v2 client mirroring the regular client surface using true async HTTP transport.
"""

import os
import asyncio
import time
from typing import Optional, List, Dict, Any, Union, Callable, Literal, BinaryIO
from .types import (
    ScrapeOptions,
    ParseOptions,
    CrawlRequest,
    WebhookConfig,
    AgentWebhookConfig,
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
    PaginationConfig,
)
from .utils.http_client import HttpClient
from .utils.http_client_async import AsyncHttpClient
from .methods.aio import parse as async_parse

from .methods.aio import scrape as async_scrape  # type: ignore[attr-defined]
from .methods.aio import batch as async_batch  # type: ignore[attr-defined]
from .methods.aio import crawl as async_crawl  # type: ignore[attr-defined]
from .methods.aio import search as async_search  # type: ignore[attr-defined]
from .methods.aio import map as async_map # type: ignore[attr-defined]
from .methods.aio import usage as async_usage # type: ignore[attr-defined]
from .methods.aio import extract as async_extract  # type: ignore[attr-defined]
from .methods.aio import agent as async_agent  # type: ignore[attr-defined]

from .watcher_async import AsyncWatcher

class AsyncFirecrawlClient:
    @staticmethod
    def _is_cloud_service(url: str) -> bool:
        return "api.firecrawl.dev" in url.lower()

    def __init__(self, api_key: Optional[str] = None, api_url: str = "https://api.firecrawl.dev"):
        if api_key is None:
            api_key = os.getenv("FIRECRAWL_API_KEY")
        if self._is_cloud_service(api_url) and not api_key:
            raise ValueError("API key is required for the cloud API. Set FIRECRAWL_API_KEY or pass api_key.")
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

    async def parse(
        self,
        file: Union[str, bytes, BinaryIO],
        **kwargs,
    ):
        filename = kwargs.pop("filename", None)
        content_type = kwargs.pop("content_type", None)
        origin = kwargs.pop("origin", None)
        integration = kwargs.pop("integration", None)
        zero_data_retention = kwargs.pop("zero_data_retention", None)

        options_fields = {
            "formats": kwargs.pop("formats", None),
            "include_tags": kwargs.pop("include_tags", None),
            "exclude_tags": kwargs.pop("exclude_tags", None),
            "only_main_content": kwargs.pop("only_main_content", None),
            "timeout": kwargs.pop("timeout", None),
            "parsers": kwargs.pop("parsers", None),
            "remove_base64_images": kwargs.pop("remove_base64_images", None),
        }

        options = (
            ParseOptions(**{k: v for k, v in options_fields.items() if v is not None})
            if any(v is not None for v in options_fields.values())
            else None
        )

        return await async_parse.parse(
            self.async_http_client,
            file,
            options,
            filename=filename,
            content_type=content_type,
            origin=origin,
            integration=integration,
            zero_data_retention=zero_data_retention,
        )

    # Search
    async def search(
        self,
        query: str,
        **kwargs,
    ) -> SearchData:
        request = SearchRequest(query=query, **{k: v for k, v in kwargs.items() if v is not None})
        return await async_search.search(self.async_http_client, request)

    async def start_crawl(self, url: str, **kwargs) -> CrawlResponse:
        sitemap = kwargs.pop("sitemap", None)
        ignore_sitemap = kwargs.pop("ignore_sitemap", None)
        if sitemap is None and ignore_sitemap is not None:
            sitemap = "skip" if ignore_sitemap else "include"
        if sitemap is not None:
            kwargs["sitemap"] = sitemap

        request = CrawlRequest(url=url, **kwargs)
        return await async_crawl.start_crawl(self.async_http_client, request)

    async def wait_crawl(
        self,
        job_id: str,
        poll_interval: int = 2,
        timeout: Optional[int] = None,
        *,
        request_timeout: Optional[float] = None,
    ) -> CrawlJob:
        """
        Polls the status of a crawl job until it reaches a terminal state.

        Args:
            job_id (str): The ID of the crawl job to poll.
            poll_interval (int, optional): Number of seconds to wait between polling attempts. Defaults to 2.
            timeout (Optional[int], optional): Maximum number of seconds to wait for the entire crawl job to complete before timing out. If None, waits indefinitely. Defaults to None.
            request_timeout (Optional[float], optional): Timeout (in seconds) for each individual HTTP request, including pagination requests when fetching results. If there are multiple pages, each page request gets this timeout. If None, no per-request timeout is set. Defaults to None.

        Returns:
            CrawlJob: The final status of the crawl job when it reaches a terminal state.

        Raises:
            TimeoutError: If the crawl does not reach a terminal state within the specified timeout.

        Terminal states:
            - "completed": The crawl finished successfully.
            - "failed": The crawl finished with an error.
            - "cancelled": The crawl was cancelled.
        """
        start = time.monotonic()
        while True:
            status = await async_crawl.get_crawl_status(
                self.async_http_client,
                job_id,
                request_timeout=request_timeout,
            )
            if status.status in ["completed", "failed", "cancelled"]:
                return status
            if timeout and (time.monotonic() - start) > timeout:
                raise TimeoutError("Crawl wait timed out")
            await asyncio.sleep(poll_interval)

    async def crawl(self, **kwargs) -> CrawlJob:
        # wrapper combining start and wait
        resp = await self.start_crawl(
            **{k: v for k, v in kwargs.items() if k not in ("poll_interval", "timeout", "request_timeout")}
        )
        poll_interval = kwargs.get("poll_interval", 2)
        timeout = kwargs.get("timeout")
        request_timeout = kwargs.get("request_timeout")
        effective_request_timeout = request_timeout if request_timeout is not None else timeout
        return await self.wait_crawl(
            resp.id,
            poll_interval=poll_interval,
            timeout=timeout,
            request_timeout=effective_request_timeout,
        )

    async def get_crawl_status(
        self,
        job_id: str,
        pagination_config: Optional[PaginationConfig] = None,
        *,
        request_timeout: Optional[float] = None,
    ) -> CrawlJob:
        """
        Get the status of a crawl job.
        
        Args:
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
        return await async_crawl.get_crawl_status(
            self.async_http_client,
            job_id,
            pagination_config=pagination_config,
            request_timeout=request_timeout,
        )

    async def get_crawl_status_page(
        self,
        next_url: str,
        *,
        request_timeout: Optional[float] = None,
    ) -> CrawlJob:
        """
        Fetch a single page of crawl results using a next URL.

        Args:
            next_url: Opaque next URL from a prior crawl status response
            request_timeout: Timeout (in seconds) for the HTTP request

        Returns:
            CrawlJob with the page data and next URL (if any)
        """
        return await async_crawl.get_crawl_status_page(
            self.async_http_client,
            next_url,
            request_timeout=request_timeout,
        )

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
        integration: Optional[str] = None,
    ) -> MapData:
        options = MapOptions(
            search=search,
            include_subdomains=include_subdomains,
            limit=limit,
            sitemap=sitemap if sitemap is not None else "include",
            timeout=timeout,
            integration=integration,
        ) if any(v is not None for v in [search, include_subdomains, limit, sitemap, integration, timeout]) else None
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

    async def get_batch_scrape_status(
        self, 
        job_id: str,
        pagination_config: Optional[PaginationConfig] = None
    ):
        return await async_batch.get_batch_scrape_status(
            self.async_http_client, 
            job_id,
            pagination_config=pagination_config
        )

    async def get_batch_scrape_status_page(
        self,
        next_url: str,
        *,
        request_timeout: Optional[float] = None,
    ):
        return await async_batch.get_batch_scrape_status_page(
            self.async_http_client,
            next_url,
            request_timeout=request_timeout,
        )

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
        integration: Optional[str] = None,
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
            integration=integration,
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
        integration: Optional[str] = None,
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
            integration=integration,
        )

    # Agent
    async def agent(
        self,
        urls: Optional[List[str]] = None,
        *,
        prompt: str,
        schema: Optional[Any] = None,
        integration: Optional[str] = None,
        poll_interval: int = 2,
        timeout: Optional[int] = None,
        max_credits: Optional[int] = None,
        strict_constrain_to_urls: Optional[bool] = None,
        model: Optional[Literal["spark-1-pro", "spark-1-mini"]] = None,
        webhook: Optional[Union[str, AgentWebhookConfig]] = None,
    ):
        return await async_agent.agent(
            self.async_http_client,
            urls,
            prompt=prompt,
            schema=schema,
            integration=integration,
            poll_interval=poll_interval,
            timeout=timeout,
            max_credits=max_credits,
            strict_constrain_to_urls=strict_constrain_to_urls,
            model=model,
            webhook=webhook,
        )

    async def get_agent_status(self, job_id: str):
        return await async_agent.get_agent_status(self.async_http_client, job_id)

    async def start_agent(
        self,
        urls: Optional[List[str]] = None,
        *,
        prompt: str,
        schema: Optional[Any] = None,
        integration: Optional[str] = None,
        max_credits: Optional[int] = None,
        strict_constrain_to_urls: Optional[bool] = None,
        model: Optional[Literal["spark-1-pro", "spark-1-mini"]] = None,
        webhook: Optional[Union[str, AgentWebhookConfig]] = None,
    ):
        return await async_agent.start_agent(
            self.async_http_client,
            urls,
            prompt=prompt,
            schema=schema,
            integration=integration,
            max_credits=max_credits,
            strict_constrain_to_urls=strict_constrain_to_urls,
            model=model,
            webhook=webhook,
        )

    async def cancel_agent(self, job_id: str) -> bool:
        """Cancel a running agent job.

        Args:
            job_id: Agent job ID

        Returns:
            True if the agent was cancelled
        """
        return await async_agent.cancel_agent(self.async_http_client, job_id)

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
    
    async def get_credit_usage_historical(self, by_api_key: bool = False):
        from .methods.aio import usage as async_usage  # type: ignore[attr-defined]
        return await async_usage.get_credit_usage_historical(self.async_http_client, by_api_key)
    
    async def get_token_usage_historical(self, by_api_key: bool = False):
        from .methods.aio import usage as async_usage  # type: ignore[attr-defined]
        return await async_usage.get_token_usage_historical(self.async_http_client, by_api_key)

    async def get_queue_status(self):
        from .methods.aio import usage as async_usage  # type: ignore[attr-defined]
        return await async_usage.get_queue_status(self.async_http_client)

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
