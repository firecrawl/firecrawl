"""
Firecrawl Client

A Firecrawl client that enables you to scrape content from websites, crawl entire sites, search the web, and extract structured data using AI.

The client supports both v1 and v2 API versions, providing access to features like:
- Web scraping with advanced options (screenshots, markdown conversion, etc.)
- Site crawling with configurable depth and limits
- Web search with content extraction
- Structured data extraction using AI models
- Deep research capabilities

Usage:
    from firecrawl import Firecrawl
    firecrawl = Firecrawl(api_key="your-api-key")
    result = firecrawl.scrape("https://example.com")

Check example.py for other usage examples.
"""

from typing import Any, Dict, Optional, List, Union
import logging


from .v1 import V1FirecrawlApp, AsyncV1FirecrawlApp
from .v2 import FirecrawlClient as V2FirecrawlClient
from .v2.client_async import AsyncFirecrawlClient
from .v2.types import Document

logger = logging.getLogger("firecrawl")

class V1Proxy:
    """Type-annotated proxy for v1 client methods."""
    _client: Optional[V1FirecrawlApp]
    
    def __init__(self, client_instance: Optional[V1FirecrawlApp]):
        self._client = client_instance

        if client_instance:
            self.scrape_url = client_instance.scrape_url
            self.crawl_url = client_instance.crawl_url
            self.batch_scrape_urls = client_instance.batch_scrape_urls
            self.async_batch_scrape_urls = client_instance.async_batch_scrape_urls
            self.async_crawl_url = client_instance.async_crawl_url
            self.check_crawl_status = client_instance.check_crawl_status
            self.map_url = client_instance.map_url
            self.extract = client_instance.extract
            self.deep_research = client_instance.deep_research
            self.generate_llms_text = client_instance.generate_llms_text

class V2Proxy:
    """Proxy class that forwards method calls to the appropriate version client."""
    _client: Optional[V2FirecrawlClient]
    
    def __init__(self, client_instance: Optional[V2FirecrawlClient]):
        self._client = client_instance

        if client_instance:
            # self.scrape = client_instance.scrape
            self.search = client_instance.search
            self.crawl = client_instance.crawl
            self.get_crawl_status = client_instance.get_crawl_status
            self.cancel_crawl = client_instance.cancel_crawl
            self.start_crawl = client_instance.start_crawl
            self.crawl_params_preview = client_instance.crawl_params_preview
            self.extract = client_instance.extract
            self.start_batch_scrape = client_instance.start_batch_scrape
            self.get_batch_scrape_status = client_instance.get_batch_scrape_status
            self.cancel_batch_scrape = client_instance.cancel_batch_scrape
            self.batch_scrape = client_instance.batch_scrape
            self.get_batch_scrape_errors = client_instance.get_batch_scrape_errors
            self.get_extract_status = client_instance.get_extract_status
            self.map = client_instance.map
            self.get_concurrency = client_instance.get_concurrency
            self.get_credit_usage = client_instance.get_credit_usage
            self.get_token_usage = client_instance.get_token_usage
    
    def __getattr__(self, name):
        """Forward attribute access to the underlying client."""
        return getattr(self._client, name)

class AsyncV1Proxy:
    """Type-annotated proxy for v1 client methods."""
    _client: Optional[AsyncV1FirecrawlApp]
    
    def __init__(self, client_instance: Optional[AsyncV1FirecrawlApp]):
        self._client = client_instance

        if client_instance:
            self.scrape_url = client_instance.scrape_url
            self.crawl_url = client_instance.crawl_url
            self.batch_scrape_urls = client_instance.batch_scrape_urls
            self.async_batch_scrape_urls = client_instance.async_batch_scrape_urls
            self.async_crawl_url = client_instance.async_crawl_url
            self.check_crawl_status = client_instance.check_crawl_status
            self.map_url = client_instance.map_url
            self.extract = client_instance.extract
            self.deep_research = client_instance.deep_research
            self.generate_llms_text = client_instance.generate_llms_text

class AsyncV2Proxy:
    """Proxy class that forwards method calls to the appropriate version client."""
    _client: Optional[Any] = None

    def __init__(self, client_instance: Optional[Any] = None):
        self._client = client_instance

        if client_instance:
            self.scrape = client_instance.scrape
            self.search = client_instance.search
            self.crawl = client_instance.crawl
            self.start_crawl = client_instance.start_crawl
            self.wait_crawl = client_instance.wait_crawl
            self.get_crawl_status = client_instance.get_crawl_status
            self.cancel_crawl = client_instance.cancel_crawl
            self.get_crawl_errors = client_instance.get_crawl_errors
            self.get_active_crawls = client_instance.get_active_crawls
            self.active_crawls = client_instance.active_crawls
            self.crawl_params_preview = client_instance.crawl_params_preview

            self.extract = client_instance.extract
            self.start_extract = client_instance.start_extract
            self.get_extract_status = client_instance.get_extract_status

            self.start_batch_scrape = client_instance.start_batch_scrape
            self.get_batch_scrape_status = client_instance.get_batch_scrape_status
            self.cancel_batch_scrape = client_instance.cancel_batch_scrape
            self.wait_batch_scrape = client_instance.wait_batch_scrape
            self.batch_scrape = client_instance.batch_scrape
            self.get_batch_scrape_errors = client_instance.get_batch_scrape_errors

            self.map = client_instance.map
            self.get_concurrency = client_instance.get_concurrency
            self.get_credit_usage = client_instance.get_credit_usage
            self.get_token_usage = client_instance.get_token_usage
            self.watcher = client_instance.watcher

    def __getattr__(self, name):
        """Forward attribute access to the underlying client."""
        if self._client:
            return getattr(self._client, name)
        raise AttributeError(f"Async v2 client not implemented yet: {name}")


class Firecrawl:
    """
    Unified Firecrawl client (v2 by default, v1 under ``.v1``).

    Provides a single entrypoint that exposes the latest API directly while
    keeping a feature-frozen v1 available for incremental migration.
    """
    
    def __init__(self, api_key: str = None, api_url: str = "https://api.firecrawl.dev"):
        """Initialize the unified client.

        Args:
            api_key: Firecrawl API key (or set ``FIRECRAWL_API_KEY``)
            api_url: Base API URL (defaults to production)
        """
        self.api_key = api_key
        self.api_url = api_url
        
        # Initialize version-specific clients
        self._v1_client = V1FirecrawlApp(api_key=api_key, api_url=api_url) if V1FirecrawlApp else None
        self._v2_client = V2FirecrawlClient(api_key=api_key, api_url=api_url) if V2FirecrawlClient else None
        
        # Create version-specific proxies
        self.v1 = V1Proxy(self._v1_client) if self._v1_client else None
        self.v2 = V2Proxy(self._v2_client)
        
        
        self.scrape = self._v2_client.scrape
        self.crawl = self._v2_client.crawl
        self.start_crawl = self._v2_client.start_crawl
        self.crawl_params_preview = self._v2_client.crawl_params_preview
        self.get_crawl_status = self._v2_client.get_crawl_status
        self.cancel_crawl = self._v2_client.cancel_crawl
        self.get_crawl_errors = self._v2_client.get_crawl_errors
        self.active_crawls = self._v2_client.active_crawls

        self.start_batch_scrape = self._v2_client.start_batch_scrape
        self.get_batch_scrape_status = self._v2_client.get_batch_scrape_status
        self.cancel_batch_scrape = self._v2_client.cancel_batch_scrape
        self.batch_scrape = self._v2_client.batch_scrape
        self.get_batch_scrape_errors = self._v2_client.get_batch_scrape_errors
        self.get_extract_status = self._v2_client.get_extract_status
        self.map = self._v2_client.map
        self.search = self._v2_client.search
        self.extract = self._v2_client.extract
        self.get_concurrency = self._v2_client.get_concurrency
        self.get_credit_usage = self._v2_client.get_credit_usage
        self.get_token_usage = self._v2_client.get_token_usage
        self.watcher = self._v2_client.watcher
        
class AsyncFirecrawl:
    """Async unified Firecrawl client (v2 by default, v1 under ``.v1``)."""

    def __init__(self, api_key: str = None, api_url: str = "https://api.firecrawl.dev"):
        self.api_key = api_key
        self.api_url = api_url
        
        # Initialize version-specific clients
        self._v1_client = AsyncV1FirecrawlApp(api_key=api_key, api_url=api_url) if AsyncV1FirecrawlApp else None
        self._v2_client = AsyncFirecrawlClient(api_key=api_key, api_url=api_url) if AsyncFirecrawlClient else None
        
        # Create version-specific proxies
        self.v1 = AsyncV1Proxy(self._v1_client) if self._v1_client else None
        self.v2 = AsyncV2Proxy(self._v2_client)

        # Expose v2 async surface directly on the top-level client for ergonomic access
        # Keep method names aligned with the sync client
        self.scrape = self._v2_client.scrape
        self.search = self._v2_client.search
        self.map = self._v2_client.map

        self.start_crawl = self._v2_client.start_crawl
        self.get_crawl_status = self._v2_client.get_crawl_status
        self.cancel_crawl = self._v2_client.cancel_crawl
        self.crawl = self._v2_client.crawl
        self.get_crawl_errors = self._v2_client.get_crawl_errors
        self.active_crawls = self._v2_client.active_crawls
        self.crawl_params_preview = self._v2_client.crawl_params_preview

        self.start_batch_scrape = self._v2_client.start_batch_scrape
        self.get_batch_scrape_status = self._v2_client.get_batch_scrape_status
        self.cancel_batch_scrape = self._v2_client.cancel_batch_scrape
        self.batch_scrape = self._v2_client.batch_scrape
        self.get_batch_scrape_errors = self._v2_client.get_batch_scrape_errors

        self.start_extract = self._v2_client.start_extract
        self.get_extract_status = self._v2_client.get_extract_status
        self.extract = self._v2_client.extract

        self.get_concurrency = self._v2_client.get_concurrency
        self.get_credit_usage = self._v2_client.get_credit_usage
        self.get_token_usage = self._v2_client.get_token_usage

        self.watcher = self._v2_client.watcher

# Export Firecrawl as an alias for FirecrawlApp
FirecrawlApp = Firecrawl
AsyncFirecrawlApp = AsyncFirecrawl