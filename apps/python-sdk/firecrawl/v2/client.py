"""
Main Firecrawl v2 API client.

This module provides the main client class that orchestrates all v2 functionality.
"""

import os
from typing import Optional, List, Dict, Any, Callable, Union, Literal, BinaryIO
from .types import (
    ClientConfig,
    ScrapeOptions,
    ParseOptions,
    Document,
    SearchRequest,
    SearchData,
    SourceOption,
    CategoryOption,
    CrawlRequest,
    CrawlResponse,
    CrawlJob,
    CrawlParamsRequest,
    PDFParser,
    CrawlParamsData,
    WebhookConfig,
    AgentWebhookConfig,
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
    AgentOptions,
)
from .utils.http_client import HttpClient
from .utils.error_handler import FirecrawlError
from .methods import scrape as scrape_module
from .methods import crawl as crawl_module  
from .methods import batch as batch_module
from .methods import search as search_module
from .methods import map as map_module
from .methods import batch as batch_methods
from .methods import usage as usage_methods
from .methods import extract as extract_module
from .methods import agent as agent_module
from .methods import parse as parse_module
from .watcher import Watcher

class FirecrawlClient:
    """
    Main Firecrawl v2 API client.

    This client provides a clean, modular interface to all Firecrawl functionality.
    """

    @staticmethod
    def _is_cloud_service(url: str) -> bool:
        return "api.firecrawl.dev" in url.lower()

    def __init__(
        self,
        api_key: Optional[str] = None,
        api_url: str = "https://api.firecrawl.dev",
        timeout: Optional[float] = None,
        max_retries: int = 3,
        backoff_factor: float = 0.5
    ):
        """
        Initialize the Firecrawl client.

        Args:
            api_key: Firecrawl API key (or set FIRECRAWL_API_KEY env var)
            api_url: Base URL for the Firecrawl API
            timeout: Request timeout in seconds
            max_retries: Maximum number of retries for failed requests
            backoff_factor: Exponential backoff factor for retries (e.g. 0.5 means wait 0.5s, then 1s, then 2s between retries)
        """
        if api_key is None:
            api_key = os.getenv("FIRECRAWL_API_KEY")

        if self._is_cloud_service(api_url) and not api_key:
            raise ValueError(
                "API key is required for the cloud API. Set FIRECRAWL_API_KEY environment variable "
                "or pass api_key parameter."
            )

        self.config = ClientConfig(
            api_key=api_key,
            api_url=api_url,
            timeout=timeout,
            max_retries=max_retries,
            backoff_factor=backoff_factor
        )

        self.http_client = HttpClient(api_key, api_url)
    
    def scrape(
        self,
        url: str,
        *,
        formats: Optional[List['FormatOption']] = None,
        headers: Optional[Dict[str, str]] = None,
        include_tags: Optional[List[str]] = None,
        exclude_tags: Optional[List[str]] = None,
        only_main_content: Optional[bool] = None,
        timeout: Optional[int] = None,
        wait_for: Optional[int] = None,
        mobile: Optional[bool] = None,
        parsers: Optional[Union[List[str], List[Union[str, PDFParser]]]] = None,
        actions: Optional[List[Union['WaitAction', 'ScreenshotAction', 'ClickAction', 'WriteAction', 'PressAction', 'ScrollAction', 'ScrapeAction', 'ExecuteJavascriptAction', 'PDFAction']]] = None,
        location: Optional['Location'] = None,
        skip_tls_verification: Optional[bool] = None,
        remove_base64_images: Optional[bool] = None,
        fast_mode: Optional[bool] = None,
        use_mock: Optional[str] = None,
        block_ads: Optional[bool] = None,
        proxy: Optional[str] = None,
        max_age: Optional[int] = None,
        store_in_cache: Optional[bool] = None,
        integration: Optional[str] = None,
    ) -> Document:
        """
        Scrape a single URL and return the document.
        Args:
            url: URL to scrape
            formats: List of formats to scrape
            headers: Dictionary of headers to use
            include_tags: List of tags to include
            exclude_tags: List of tags to exclude
            only_main_content: Whether to only scrape the main content
            timeout: Timeout in seconds
            wait_for: Wait for a specific element to be present
            mobile: Whether to use mobile mode
            parsers: List of parsers to use
            actions: List of actions to perform
            location: Location to scrape
            skip_tls_verification: Whether to skip TLS verification
            remove_base64_images: Whether to remove base64 images
            fast_mode: Whether to use fast mode
            use_mock: Whether to use mock mode
            block_ads: Whether to block ads
            proxy: Proxy to use
            max_age: Maximum age of the cache
            store_in_cache: Whether to store the result in the cache
        Returns:
            Document
        """
        options = ScrapeOptions(
            **{k: v for k, v in dict(
                formats=formats,
                headers=headers,
                include_tags=include_tags,
                exclude_tags=exclude_tags,
                only_main_content=only_main_content,
                timeout=timeout,
                wait_for=wait_for,
                mobile=mobile,
                parsers=parsers,
                actions=actions,
                location=location,
                skip_tls_verification=skip_tls_verification,
                remove_base64_images=remove_base64_images,
                fast_mode=fast_mode,
                use_mock=use_mock,
                block_ads=block_ads,
                proxy=proxy,
                max_age=max_age,
                store_in_cache=store_in_cache,
                integration=integration,
            ).items() if v is not None}
        ) if any(v is not None for v in [formats, headers, include_tags, exclude_tags, only_main_content, timeout, wait_for, mobile, parsers, actions, location, skip_tls_verification, remove_base64_images, fast_mode, use_mock, block_ads, proxy, max_age, store_in_cache, integration]) else None
        return scrape_module.scrape(self.http_client, url, options)

    def parse(
        self,
        file: Union[str, bytes, BinaryIO],
        *,
        formats: Optional[List['FormatOption']] = None,
        include_tags: Optional[List[str]] = None,
        exclude_tags: Optional[List[str]] = None,
        only_main_content: Optional[bool] = None,
        timeout: Optional[int] = None,
        parsers: Optional[Union[List[str], List[Union[str, PDFParser]]]] = None,
        remove_base64_images: Optional[bool] = None,
        filename: Optional[str] = None,
        content_type: Optional[str] = None,
        origin: Optional[str] = None,
        integration: Optional[str] = None,
        zero_data_retention: Optional[bool] = None,
    ) -> Document:
        """
        Parse a local file and return the document.
        Args:
            file: File path, bytes, or file-like object
            formats: List of formats to extract
            include_tags: List of tags to include
            exclude_tags: List of tags to exclude
            only_main_content: Whether to only extract the main content
            timeout: Timeout in seconds
            parsers: List of parsers to use (pdf only)
            remove_base64_images: Whether to remove base64 images
            filename: Optional filename override
            content_type: Optional content type override
            origin: Optional origin
            integration: Optional integration
            zero_data_retention: Optional zeroDataRetention flag
        Returns:
            Document
        """
        options = ParseOptions(
            **{k: v for k, v in dict(
                formats=formats,
                include_tags=include_tags,
                exclude_tags=exclude_tags,
                only_main_content=only_main_content,
                timeout=timeout,
                parsers=parsers,
                remove_base64_images=remove_base64_images,
            ).items() if v is not None}
        ) if any(v is not None for v in [formats, include_tags, exclude_tags, only_main_content, timeout, parsers, remove_base64_images]) else None

        return parse_module.parse(
            self.http_client,
            file,
            options,
            filename=filename,
            content_type=content_type,
            origin=origin,
            integration=integration,
            zero_data_retention=zero_data_retention,
        )

    def search(
        self,
        query: str,
        *,
        sources: Optional[List[SourceOption]] = None,
        categories: Optional[List[CategoryOption]] = None,
        limit: Optional[int] = None,
        tbs: Optional[str] = None,
        location: Optional[str] = None,
        ignore_invalid_urls: Optional[bool] = None,
        timeout: Optional[int] = None,
        scrape_options: Optional[ScrapeOptions] = None,
        integration: Optional[str] = None,
    ) -> SearchData:
        """
        Search for documents.
        
        Args:
            query: Search query string
            limit: Maximum number of results to return (default: 5)
            tbs: Time-based search filter
            location: Location string for search
            timeout: Request timeout in milliseconds (default: 300000)
            page_options: Options for scraping individual pages
            
        Returns:
            SearchData containing the search results
        """
        request = SearchRequest(
            query=query,
            sources=sources,
            categories=categories,
            limit=limit,
            tbs=tbs,
            location=location,
            ignore_invalid_urls=ignore_invalid_urls,
            timeout=timeout,
            scrape_options=scrape_options,
            integration=integration,
        )

        return search_module.search(self.http_client, request)
    
    def crawl(
        self,
        url: str,
        *,
        prompt: Optional[str] = None,
        exclude_paths: Optional[List[str]] = None,
        include_paths: Optional[List[str]] = None,
        max_discovery_depth: Optional[int] = None,
        sitemap: Optional[Literal["only", "include", "skip"]] = None,
        ignore_sitemap: Optional[bool] = None,
        ignore_query_parameters: bool = False,
        limit: Optional[int] = None,
        crawl_entire_domain: bool = False,
        allow_external_links: bool = False,
        allow_subdomains: bool = False,
        delay: Optional[int] = None,
        max_concurrency: Optional[int] = None,
        webhook: Optional[Union[str, WebhookConfig]] = None,
        scrape_options: Optional[ScrapeOptions] = None,
        zero_data_retention: bool = False,
        poll_interval: int = 2,
        timeout: Optional[int] = None,
        request_timeout: Optional[float] = None,
        integration: Optional[str] = None,
    ) -> CrawlJob:
        """
        Start a crawl job and wait for it to complete.
        
        Args:
            url: Target URL to start crawling from
            prompt: Optional prompt to guide the crawl
            exclude_paths: Patterns of URLs to exclude
            include_paths: Patterns of URLs to include
            max_discovery_depth: Maximum depth for finding new URLs
            sitemap: Sitemap usage mode ("only" | "include" | "skip")
            ignore_sitemap: Deprecated alias for sitemap ("skip" when true, "include" when false)
            ignore_query_parameters: Ignore URL parameters
            limit: Maximum pages to crawl
            crawl_entire_domain: Follow parent directory links
            allow_external_links: Follow external domain links
            allow_subdomains: Follow subdomains
            delay: Delay in seconds between scrapes
            max_concurrency: Maximum number of concurrent scrapes
            webhook: Webhook configuration for notifications
            scrape_options: Page scraping configuration
            zero_data_retention: Whether to delete data after 24 hours
            poll_interval: Seconds between status checks
            timeout: Maximum seconds to wait for the entire crawl job to complete (None for no timeout)
            request_timeout: Timeout (in seconds) for each individual HTTP request, including pagination requests when fetching results. If there are multiple pages, each page request gets this timeout
            
        Returns:
            CrawlJob when job completes
            
        Raises:
            ValueError: If request is invalid
            Exception: If the crawl fails to start or complete
            TimeoutError: If timeout is reached
        """
        resolved_sitemap = sitemap
        if resolved_sitemap is None and ignore_sitemap is not None:
            resolved_sitemap = "skip" if ignore_sitemap else "include"

        request_kwargs = {
            "url": url,
            "prompt": prompt,
            "exclude_paths": exclude_paths,
            "include_paths": include_paths,
            "max_discovery_depth": max_discovery_depth,
            "ignore_query_parameters": ignore_query_parameters,
            "limit": limit,
            "crawl_entire_domain": crawl_entire_domain,
            "allow_external_links": allow_external_links,
            "allow_subdomains": allow_subdomains,
            "delay": delay,
            "max_concurrency": max_concurrency,
            "webhook": webhook,
            "scrape_options": scrape_options,
            "zero_data_retention": zero_data_retention,
            "integration": integration,
        }
        if resolved_sitemap is not None:
            request_kwargs["sitemap"] = resolved_sitemap

        request = CrawlRequest(**request_kwargs)
        
        return crawl_module.crawl(
            self.http_client,
            request,
            poll_interval=poll_interval,
            timeout=timeout,
            request_timeout=request_timeout,
        )
    
    def start_crawl(
        self,
        url: str,
        *,
        prompt: Optional[str] = None,
        exclude_paths: Optional[List[str]] = None,
        include_paths: Optional[List[str]] = None,
        max_discovery_depth: Optional[int] = None,
        sitemap: Optional[Literal["only", "include", "skip"]] = None,
        ignore_sitemap: Optional[bool] = None,
        ignore_query_parameters: bool = False,
        limit: Optional[int] = None,
        crawl_entire_domain: bool = False,
        allow_external_links: bool = False,
        allow_subdomains: bool = False,
        delay: Optional[int] = None,
        max_concurrency: Optional[int] = None,
        webhook: Optional[Union[str, WebhookConfig]] = None,
        scrape_options: Optional[ScrapeOptions] = None,
        zero_data_retention: bool = False,
        integration: Optional[str] = None,
    ) -> CrawlResponse:
        """
        Start an asynchronous crawl job.
        
        Args:
            url: Target URL to start crawling from
            prompt: Optional prompt to guide the crawl
            exclude_paths: Patterns of URLs to exclude
            include_paths: Patterns of URLs to include
            max_discovery_depth: Maximum depth for finding new URLs
            sitemap: Sitemap usage mode ("only" | "include" | "skip")
            ignore_sitemap: Deprecated alias for sitemap ("skip" when true, "include" when false)
            ignore_query_parameters: Ignore URL parameters
            limit: Maximum pages to crawl
            crawl_entire_domain: Follow parent directory links
            allow_external_links: Follow external domain links
            allow_subdomains: Follow subdomains
            delay: Delay in seconds between scrapes
            max_concurrency: Maximum number of concurrent scrapes
            webhook: Webhook configuration for notifications
            scrape_options: Page scraping configuration
            zero_data_retention: Whether to delete data after 24 hours
            
        Returns:
            CrawlResponse with job information
            
        Raises:
            ValueError: If request is invalid
            Exception: If the crawl operation fails to start
        """
        resolved_sitemap = sitemap
        if resolved_sitemap is None and ignore_sitemap is not None:
            resolved_sitemap = "skip" if ignore_sitemap else "include"

        request_kwargs = {
            "url": url,
            "prompt": prompt,
            "exclude_paths": exclude_paths,
            "include_paths": include_paths,
            "max_discovery_depth": max_discovery_depth,
            "ignore_query_parameters": ignore_query_parameters,
            "limit": limit,
            "crawl_entire_domain": crawl_entire_domain,
            "allow_external_links": allow_external_links,
            "allow_subdomains": allow_subdomains,
            "delay": delay,
            "max_concurrency": max_concurrency,
            "webhook": webhook,
            "scrape_options": scrape_options,
            "zero_data_retention": zero_data_retention,
            "integration": integration,
        }
        if resolved_sitemap is not None:
            request_kwargs["sitemap"] = resolved_sitemap

        request = CrawlRequest(**request_kwargs)
        
        return crawl_module.start_crawl(self.http_client, request)
    
    def get_crawl_status(
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
        return crawl_module.get_crawl_status(
            self.http_client,
            job_id,
            pagination_config=pagination_config,
            request_timeout=request_timeout,
        )

    def get_crawl_status_page(
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
        return crawl_module.get_crawl_status_page(
            self.http_client,
            next_url,
            request_timeout=request_timeout,
        )
    
    def get_crawl_errors(self, crawl_id: str) -> CrawlErrorsResponse:
        """
        Retrieve error details and robots.txt blocks for a given crawl job.
        
        Args:
            crawl_id: The ID of the crawl job
        
        Returns:
            CrawlErrorsResponse containing per-URL errors and robots-blocked URLs
        """
        return crawl_module.get_crawl_errors(self.http_client, crawl_id)
    
    def get_active_crawls(self) -> ActiveCrawlsResponse:
        """
        Get a list of currently active crawl jobs.
        
        Returns:
            ActiveCrawlsResponse containing a list of active crawl jobs.
        """
        return crawl_module.get_active_crawls(self.http_client)
    
    def active_crawls(self) -> ActiveCrawlsResponse:
        """
        List currently active crawl jobs for the authenticated team.
        
        Returns:
            ActiveCrawlsResponse containing the list of active crawl jobs
        """
        return self.get_active_crawls()

    def map(
        self,
        url: str,
        *,
        search: Optional[str] = None,
        include_subdomains: Optional[bool] = None,
        ignore_query_parameters: Optional[bool] = None,
        limit: Optional[int] = None,
        sitemap: Optional[Literal["only", "include", "skip"]] = None,
        timeout: Optional[int] = None,
        integration: Optional[str] = None,
        location: Optional[Location] = None,
    ) -> MapData:
        """Map a URL and return discovered links.

        Args:
            url: Root URL to explore
            search: Optional substring filter for discovered links
            include_subdomains: Whether to include subdomains
            ignore_query_parameters: Whether to ignore query parameters when mapping
            limit: Maximum number of links to return
            sitemap: Sitemap usage mode ("only" | "include" | "skip")
            timeout: Request timeout in milliseconds

        Returns:
            MapData containing the discovered links
        """
        options = MapOptions(
            search=search,
            include_subdomains=include_subdomains,
            ignore_query_parameters=ignore_query_parameters,
            limit=limit,
            sitemap=sitemap if sitemap is not None else "include",
            timeout=timeout,
            integration=integration,
            location=location
        ) if any(v is not None for v in [search, include_subdomains, ignore_query_parameters, limit, sitemap, timeout, integration, location]) else None

        return map_module.map(self.http_client, url, options)
    
    def cancel_crawl(self, crawl_id: str) -> bool:
        """
        Cancel a crawl job.
        
        Args:
            crawl_id: The ID of the crawl job to cancel
            
        Returns:
            bool: True if the crawl was cancelled, False otherwise
        """
        return crawl_module.cancel_crawl(self.http_client, crawl_id)

    def crawl_params_preview(self, url: str, prompt: str) -> CrawlParamsData:
        """Derive crawl parameters from natural-language prompt.

        Args:
            url: Root URL
            prompt: Instruction describing how to crawl

        Returns:
            CrawlParamsData with normalized crawl configuration
        """
        request = CrawlParamsRequest(url=url, prompt=prompt)
        return crawl_module.crawl_params_preview(self.http_client, request)

    def start_extract(
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
        agent: Optional[AgentOptions] = None,
    ):
        """Start an extract job (non-blocking).

        Args:
            urls: URLs to extract from (optional)
            prompt: Natural-language instruction for extraction
            schema: Target JSON schema for the output
            system_prompt: Optional system instruction
            allow_external_links: Allow hyperlinks in output
            enable_web_search: Whether to augment with web search
            show_sources: Include per-field/source mapping when available
            scrape_options: Scrape options applied prior to extraction
            ignore_invalid_urls: Skip invalid URLs instead of failing
            integration: Integration tag/name
            agent: Agent configuration
        Returns:
            Response payload with job id/status (poll with get_extract_status)
        """
        return extract_module.start_extract(
            self.http_client,
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
            agent=agent,
        )

    def extract(
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
        agent: Optional[AgentOptions] = None,
    ):
        """Extract structured data and wait until completion.

        Args:
            urls: URLs to extract from (optional)
            prompt: Natural-language instruction for extraction
            schema: Target JSON schema for the output
            system_prompt: Optional system instruction
            allow_external_links: Allow hyperlinks in output
            enable_web_search: Whether to augment with web search
            show_sources: Include per-field/source mapping when available
            scrape_options: Scrape options applied prior to extraction
            ignore_invalid_urls: Skip invalid URLs instead of failing
            poll_interval: Seconds between status checks
            timeout: Maximum seconds to wait (None for no timeout)
            integration: Integration tag/name
            agent: Agent configuration
        Returns:
            Final extract response when completed
        """
        return extract_module.extract(
            self.http_client,
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
            agent=agent,
        )

    def start_batch_scrape(
        self,
        urls: List[str],
        *,
        formats: Optional[List['FormatOption']] = None,
        headers: Optional[Dict[str, str]] = None,
        include_tags: Optional[List[str]] = None,
        exclude_tags: Optional[List[str]] = None,
        only_main_content: Optional[bool] = None,
        timeout: Optional[int] = None,
        wait_for: Optional[int] = None,
        mobile: Optional[bool] = None,
        parsers: Optional[Union[List[str], List[Union[str, PDFParser]]]] = None,
        actions: Optional[List[Union['WaitAction', 'ScreenshotAction', 'ClickAction', 'WriteAction', 'PressAction', 'ScrollAction', 'ScrapeAction', 'ExecuteJavascriptAction', 'PDFAction']]] = None,
        location: Optional['Location'] = None,
        skip_tls_verification: Optional[bool] = None,
        remove_base64_images: Optional[bool] = None,
        fast_mode: Optional[bool] = None,
        use_mock: Optional[str] = None,
        block_ads: Optional[bool] = None,
        proxy: Optional[str] = None,
        max_age: Optional[int] = None,
        store_in_cache: Optional[bool] = None,
        webhook: Optional[Union[str, WebhookConfig]] = None,
        append_to_id: Optional[str] = None,
        ignore_invalid_urls: Optional[bool] = None,
        max_concurrency: Optional[int] = None,
        zero_data_retention: Optional[bool] = None,
        integration: Optional[str] = None,
        idempotency_key: Optional[str] = None,
    ):
        """Start a batch scrape job over multiple URLs (non-blocking).

        Args:
            urls: List of URLs to scrape
            formats: Output formats to collect per URL
            headers: HTTP headers
            include_tags: HTML tags to include
            exclude_tags: HTML tags to exclude
            only_main_content: Restrict scraping to main content
            timeout: Per-request timeout in milliseconds
            wait_for: Wait condition in milliseconds
            mobile: Emulate mobile viewport
            parsers: Parser list (e.g., ["pdf"]) 
            actions: Browser actions to perform
            location: Location settings
            skip_tls_verification: Skip TLS verification
            remove_base64_images: Remove base64 images from output
            fast_mode: Prefer faster scraping modes
            use_mock: Use a mock data source (internal/testing)
            block_ads: Block ads during scraping
            proxy: Proxy setting
            max_age: Cache max age
            store_in_cache: Whether to store results in cache
            webhook: Webhook configuration
            append_to_id: Append to an existing batch job
            ignore_invalid_urls: Skip invalid URLs without failing
            max_concurrency: Max concurrent scrapes
            zero_data_retention: Delete data after 24 hours
            integration: Integration tag/name
            idempotency_key: Header used to deduplicate starts

        Returns:
            Response payload with job id (poll with get_batch_scrape_status)
        """
        options = ScrapeOptions(
            **{k: v for k, v in dict(
                formats=formats,
                headers=headers,
                include_tags=include_tags,
                exclude_tags=exclude_tags,
                only_main_content=only_main_content,
                timeout=timeout,
                wait_for=wait_for,
                mobile=mobile,
                parsers=parsers,
                actions=actions,
                location=location,
                skip_tls_verification=skip_tls_verification,
                remove_base64_images=remove_base64_images,
                fast_mode=fast_mode,
                use_mock=use_mock,
                block_ads=block_ads,
                proxy=proxy,
                max_age=max_age,
                store_in_cache=store_in_cache,
            ).items() if v is not None}
        ) if any(v is not None for v in [formats, headers, include_tags, exclude_tags, only_main_content, timeout, wait_for, mobile, parsers, actions, location, skip_tls_verification, remove_base64_images, fast_mode, use_mock, block_ads, proxy, max_age, store_in_cache]) else None

        return batch_module.start_batch_scrape(
            self.http_client,
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

    def get_batch_scrape_status(
        self, 
        job_id: str,
        pagination_config: Optional[PaginationConfig] = None
    ):
        """Get current status and any scraped data for a batch job.

        Args:
            job_id: Batch job ID
            pagination_config: Optional configuration for pagination behavior

        Returns:
            Status payload including counts and partial data
        """
        return batch_module.get_batch_scrape_status(
            self.http_client, 
            job_id,
            pagination_config=pagination_config
        )

    def get_batch_scrape_status_page(
        self,
        next_url: str,
        *,
        request_timeout: Optional[float] = None,
    ):
        """Fetch a single page of batch scrape results using a next URL.

        Args:
            next_url: Opaque next URL from a prior batch scrape status response
            request_timeout: Timeout (in seconds) for the HTTP request

        Returns:
            BatchScrapeJob with the page data and next URL (if any)
        """
        return batch_module.get_batch_scrape_status_page(
            self.http_client,
            next_url,
            request_timeout=request_timeout,
        )

    def cancel_batch_scrape(self, job_id: str) -> bool:
        """Cancel a running batch scrape job.

        Args:
            job_id: Batch job ID

        Returns:
            True if the job was cancelled
        """
        return batch_module.cancel_batch_scrape(self.http_client, job_id)

    def get_batch_scrape_errors(self, job_id: str):
        """Retrieve error details for a batch scrape job.

        Args:
            job_id: Batch job ID

        Returns:
            Errors and robots-blocked URLs for the job
        """
        return batch_methods.get_batch_scrape_errors(self.http_client, job_id)

    def get_extract_status(self, job_id: str):
        """Get the current status (and data if completed) of an extract job.

        Args:
            job_id: Extract job ID

        Returns:
            Extract response payload with status and optional data
        """
        return extract_module.get_extract_status(self.http_client, job_id)

    def start_agent(
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
        """Start an agent job (non-blocking).

        Args:
            urls: URLs to process (optional)
            prompt: Natural-language instruction for the agent
            schema: Target JSON schema for the output (dict or Pydantic BaseModel)
            integration: Integration tag/name
            max_credits: Maximum credits to use (optional)
            model: Model to use for the agent ("spark-1-pro" or "spark-1-mini")
            webhook: Webhook URL or configuration for notifications
        Returns:
            Response payload with job id/status (poll with get_agent_status)
        """
        return agent_module.start_agent(
            self.http_client,
            urls,
            prompt=prompt,
            schema=schema,
            integration=integration,
            max_credits=max_credits,
            strict_constrain_to_urls=strict_constrain_to_urls,
            model=model,
            webhook=webhook,
        )

    def agent(
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
        """Run an agent and wait until completion.

        Args:
            urls: URLs to process (optional)
            prompt: Natural-language instruction for the agent
            schema: Target JSON schema for the output (dict or Pydantic BaseModel)
            integration: Integration tag/name
            poll_interval: Seconds between status checks
            timeout: Maximum seconds to wait (None for no timeout)
            max_credits: Maximum credits to use (optional)
            model: Model to use for the agent ("spark-1-pro" or "spark-1-mini")
            webhook: Webhook URL or configuration for notifications
        Returns:
            Final agent response when completed
        """
        return agent_module.agent(
            self.http_client,
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

    def get_agent_status(self, job_id: str):
        """Get the current status (and data if completed) of an agent job.

        Args:
            job_id: Agent job ID

        Returns:
            Agent response payload with status and optional data
        """
        return agent_module.get_agent_status(self.http_client, job_id)

    def cancel_agent(self, job_id: str) -> bool:
        """Cancel a running agent job.

        Args:
            job_id: Agent job ID

        Returns:
            True if the agent was cancelled
        """
        return agent_module.cancel_agent(self.http_client, job_id)

    def get_concurrency(self):
        """Get current concurrency and maximum allowed for this team/key (v2)."""
        return usage_methods.get_concurrency(self.http_client)

    def get_credit_usage(self):
        """Get remaining credits for this team/key (v2)."""
        return usage_methods.get_credit_usage(self.http_client)

    def get_token_usage(self):
        """Get recent token usage metrics (v2)."""
        return usage_methods.get_token_usage(self.http_client)

    def get_credit_usage_historical(self, by_api_key: bool = False):
        """Get historical credit usage (v2)."""
        return usage_methods.get_credit_usage_historical(self.http_client, by_api_key)

    def get_token_usage_historical(self, by_api_key: bool = False):
        """Get historical token usage (v2)."""
        return usage_methods.get_token_usage_historical(self.http_client, by_api_key)

    def get_queue_status(self):
        """Get metrics about the team's scrape queue."""
        return usage_methods.get_queue_status(self.http_client)

    def watcher(
        self,
        job_id: str,
        *,
        kind: Literal["crawl", "batch"] = "crawl",
        poll_interval: int = 2,
        timeout: Optional[int] = None,
    ) -> Watcher:
        """Create a watcher for crawl or batch jobs.

        Args:
            job_id: Job ID to watch
            kind: Job kind ("crawl" or "batch")
            poll_interval: Seconds between status checks
            timeout: Maximum seconds to watch (None for no timeout)

        Returns:
            Watcher instance
        """
        return Watcher(self, job_id, kind=kind, poll_interval=poll_interval, timeout=timeout)

    def batch_scrape(
        self,
        urls: List[str],
        *,
        formats: Optional[List['FormatOption']] = None,
        headers: Optional[Dict[str, str]] = None,
        include_tags: Optional[List[str]] = None,
        exclude_tags: Optional[List[str]] = None,
        only_main_content: Optional[bool] = None,
        timeout: Optional[int] = None,
        wait_for: Optional[int] = None,
        mobile: Optional[bool] = None,
        parsers: Optional[Union[List[str], List[Union[str, PDFParser]]]] = None,
        actions: Optional[List[Union['WaitAction', 'ScreenshotAction', 'ClickAction', 'WriteAction', 'PressAction', 'ScrollAction', 'ScrapeAction', 'ExecuteJavascriptAction', 'PDFAction']]] = None,
        location: Optional['Location'] = None,
        skip_tls_verification: Optional[bool] = None,
        remove_base64_images: Optional[bool] = None,
        fast_mode: Optional[bool] = None,
        use_mock: Optional[str] = None,
        block_ads: Optional[bool] = None,
        proxy: Optional[str] = None,
        max_age: Optional[int] = None,
        store_in_cache: Optional[bool] = None,
        webhook: Optional[Union[str, WebhookConfig]] = None,
        append_to_id: Optional[str] = None,
        ignore_invalid_urls: Optional[bool] = None,
        max_concurrency: Optional[int] = None,
        zero_data_retention: Optional[bool] = None,
        integration: Optional[str] = None,
        idempotency_key: Optional[str] = None,
        poll_interval: int = 2,
        wait_timeout: Optional[int] = None,
    ):
        """
        Start a batch scrape job and wait until completion.
        """
        options = ScrapeOptions(
            **{k: v for k, v in dict(
                formats=formats,
                headers=headers,
                include_tags=include_tags,
                exclude_tags=exclude_tags,
                only_main_content=only_main_content,
                timeout=timeout,
                wait_for=wait_for,
                mobile=mobile,
                parsers=parsers,
                actions=actions,
                location=location,
                skip_tls_verification=skip_tls_verification,
                remove_base64_images=remove_base64_images,
                fast_mode=fast_mode,
                use_mock=use_mock,
                block_ads=block_ads,
                proxy=proxy,
                max_age=max_age,
                store_in_cache=store_in_cache,
            ).items() if v is not None}
        ) if any(v is not None for v in [formats, headers, include_tags, exclude_tags, only_main_content, timeout, wait_for, mobile, parsers, actions, location, skip_tls_verification, remove_base64_images, fast_mode, use_mock, block_ads, proxy, max_age, store_in_cache]) else None

        return batch_module.batch_scrape(
            self.http_client,
            urls,
            options=options,
            webhook=webhook,
            append_to_id=append_to_id,
            ignore_invalid_urls=ignore_invalid_urls,
            max_concurrency=max_concurrency,
            zero_data_retention=zero_data_retention,
            integration=integration,
            idempotency_key=idempotency_key,
            poll_interval=poll_interval,
            timeout=wait_timeout,
        )
    
