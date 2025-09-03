"""
Firecrawl v1 API Client - Legacy Implementation

This module provides the legacy v1 implementation of the Firecrawl SDK.
It contains the complete `V1FirecrawlApp` class with all v1 API methods and types
for backward compatibility. This is used by the unified client to provide
version-specific access patterns like app.v1.scrape_url().

Classes:
    - V1FirecrawlApp: Legacy v1 client for interacting with the Firecrawl API.
    - AsyncV1FirecrawlApp: Async version of the v1 client.
    - CrawlWatcher: WebSocket-based crawl monitoring for v1.
"""
import logging
import os
import time
from typing import Any, Dict, Optional, List, Union, Callable, Literal, TypeVar, Generic
import json
from datetime import datetime
import re
import requests
import pydantic
import websockets
import aiohttp
import asyncio

logger : logging.Logger = logging.getLogger("firecrawl")

def get_version():
  try:
      from pathlib import Path
      package_path = os.path.dirname(__file__)
      version_file = Path(os.path.join(package_path, '__init__.py')).read_text()
      version_match = re.search(r"^__version__ = ['\"]([^'\"]*)['\"]", version_file, re.M)
      if version_match:
          return version_match.group(1).strip()
  except Exception:
      print("Failed to get version from __init__.py")
      return None

version = get_version()

T = TypeVar('T')

# class V1FirecrawlDocumentMetadata(pydantic.BaseModel):
#     """Metadata for a Firecrawl document."""
#     title: Optional[str] = None
#     description: Optional[str] = None
#     language: Optional[str] = None
#     keywords: Optional[str] = None
#     robots: Optional[str] = None
#     ogTitle: Optional[str] = None
#     ogDescription: Optional[str] = None
#     ogUrl: Optional[str] = None
#     ogImage: Optional[str] = None
#     ogAudio: Optional[str] = None
#     ogDeterminer: Optional[str] = None
#     ogLocale: Optional[str] = None
#     ogLocaleAlternate: Optional[List[str]] = None
#     ogSiteName: Optional[str] = None
#     ogVideo: Optional[str] = None
#     dctermsCreated: Optional[str] = None
#     dcDateCreated: Optional[str] = None
#     dcDate: Optional[str] = None
#     dctermsType: Optional[str] = None
#     dcType: Optional[str] = None
#     dctermsAudience: Optional[str] = None
#     dctermsSubject: Optional[str] = None
#     dcSubject: Optional[str] = None
#     dcDescription: Optional[str] = None
#     dctermsKeywords: Optional[str] = None
#     modifiedTime: Optional[str] = None
#     publishedTime: Optional[str] = None
#     articleTag: Optional[str] = None
#     articleSection: Optional[str] = None
#     sourceURL: Optional[str] = None
#     statusCode: Optional[int] = None
#     error: Optional[str] = None

class V1AgentOptions(pydantic.BaseModel):
    """Configuration for the agent."""
    model: Literal["FIRE-1"] = "FIRE-1"
    prompt: Optional[str] = None

class V1AgentOptionsExtract(pydantic.BaseModel):
    """Configuration for the agent in extract operations."""
    model: Literal["FIRE-1"] = "FIRE-1"

class V1ActionsResult(pydantic.BaseModel):
    """Result of actions performed during scraping."""
    screenshots: List[str]
    pdfs: List[str]

class V1ChangeTrackingData(pydantic.BaseModel):
    """
    Data for the change tracking format.
    """
    previousScrapeAt: Optional[str] = None
    changeStatus: str  # "new" | "same" | "changed" | "removed"
    visibility: str  # "visible" | "hidden"
    diff: Optional[Dict[str, Any]] = None
    json_field: Optional[Any] = pydantic.Field(None, alias='json')

class V1FirecrawlDocument(pydantic.BaseModel, Generic[T]):
    """Document retrieved or processed by Firecrawl."""
    url: Optional[str] = None
    markdown: Optional[str] = None
    html: Optional[str] = None
    rawHtml: Optional[str] = None
    links: Optional[List[str]] = None
    extract: Optional[T] = None
    json_field: Optional[T] = pydantic.Field(None, alias='json')
    screenshot: Optional[str] = None
    metadata: Optional[Any] = None
    actions: Optional[V1ActionsResult] = None
    title: Optional[str] = None  # v1 search only
    description: Optional[str] = None  # v1 search only
    changeTracking: Optional[V1ChangeTrackingData] = None

class V1LocationConfig(pydantic.BaseModel):
    """Location configuration for scraping."""
    country: Optional[str] = None
    languages: Optional[List[str]] = None

class V1WebhookConfig(pydantic.BaseModel):
    """Configuration for webhooks."""
    url: str
    headers: Optional[Dict[str, str]] = None
    metadata: Optional[Dict[str, str]] = None
    events: Optional[List[Literal["completed", "failed", "page", "started"]]] = None

class V1ChangeTrackingOptions(pydantic.BaseModel):
    """Configuration for change tracking."""
    modes: Optional[List[Literal["git-diff", "json"]]] = None
    schema_field: Optional[Any] = pydantic.Field(None, alias='schema')
    prompt: Optional[str] = None
    tag: Optional[str] = None

class V1ScrapeOptions(pydantic.BaseModel):
    """Parameters for scraping operations."""
    formats: Optional[List[Literal["markdown", "html", "rawHtml", "content", "links", "screenshot", "screenshot@fullPage", "extract", "json", "changeTracking"]]] = None
    headers: Optional[Dict[str, str]] = None
    includeTags: Optional[List[str]] = None
    excludeTags: Optional[List[str]] = None
    onlyMainContent: Optional[bool] = None
    waitFor: Optional[int] = None
    timeout: Optional[int] = 30000
    location: Optional[V1LocationConfig] = None
    mobile: Optional[bool] = None
    skipTlsVerification: Optional[bool] = None
    removeBase64Images: Optional[bool] = None
    blockAds: Optional[bool] = None
    proxy: Optional[Literal["basic", "stealth", "auto"]] = None
    changeTrackingOptions: Optional[V1ChangeTrackingOptions] = None
    maxAge: Optional[int] = None
    storeInCache: Optional[bool] = None
    parsePDF: Optional[bool] = None

class V1WaitAction(pydantic.BaseModel):
    """Wait action to perform during scraping."""
    type: Literal["wait"]
    milliseconds: Optional[int] = None
    selector: Optional[str] = None

class V1ScreenshotAction(pydantic.BaseModel):
    """Screenshot action to perform during scraping."""
    type: Literal["screenshot"]
    fullPage: Optional[bool] = None
    quality: Optional[int] = None

class V1ClickAction(pydantic.BaseModel):
    """Click action to perform during scraping."""
    type: Literal["click"]
    selector: str

class V1WriteAction(pydantic.BaseModel):
    """Write action to perform during scraping."""
    type: Literal["write"]
    text: str

class V1PressAction(pydantic.BaseModel):
    """Press action to perform during scraping."""
    type: Literal["press"]
    key: str

class V1ScrollAction(pydantic.BaseModel):
    """Scroll action to perform during scraping."""
    type: Literal["scroll"]
    direction: Literal["up", "down"]
    selector: Optional[str] = None

class V1ScrapeAction(pydantic.BaseModel):
    """Scrape action to perform during scraping."""
    type: Literal["scrape"]

class V1ExecuteJavascriptAction(pydantic.BaseModel):
    """Execute javascript action to perform during scraping."""
    type: Literal["executeJavascript"]
    script: str

class V1PDFAction(pydantic.BaseModel):
    """PDF action to perform during scraping."""
    type: Literal["pdf"]
    format: Optional[Literal["A0", "A1", "A2", "A3", "A4", "A5", "A6", "Letter", "Legal", "Tabloid", "Ledger"]] = None
    landscape: Optional[bool] = None
    scale: Optional[float] = None

class V1ExtractAgent(pydantic.BaseModel):
    """Configuration for the agent in extract operations."""
    model: Literal["FIRE-1"] = "FIRE-1"

class V1JsonConfig(pydantic.BaseModel):
    """Configuration for extraction."""
    prompt: Optional[str] = None
    schema_field: Optional[Any] = pydantic.Field(None, alias='schema')
    systemPrompt: Optional[str] = None
    agent: Optional[V1ExtractAgent] = None

class V1ScrapeParams(V1ScrapeOptions):
    """Parameters for scraping operations."""
    extract: Optional[V1JsonConfig] = None
    jsonOptions: Optional[V1JsonConfig] = None
    actions: Optional[List[Union[V1WaitAction, V1ScreenshotAction, V1ClickAction, V1WriteAction, V1PressAction, V1ScrollAction, V1ScrapeAction, V1ExecuteJavascriptAction, V1PDFAction]]] = None
    agent: Optional[V1AgentOptions] = None
    webhook: Optional[V1WebhookConfig] = None

class V1ScrapeResponse(V1FirecrawlDocument[T], Generic[T]):
    """Response from scraping operations."""
    success: bool = True
    warning: Optional[str] = None
    error: Optional[str] = None

class V1BatchScrapeResponse(pydantic.BaseModel):
    """Response from batch scrape operations."""
    id: Optional[str] = None
    url: Optional[str] = None
    success: bool = True
    error: Optional[str] = None
    invalidURLs: Optional[List[str]] = None

class V1BatchScrapeStatusResponse(pydantic.BaseModel):
    """Response from batch scrape status checks."""
    success: bool = True
    status: Literal["scraping", "completed", "failed", "cancelled"]
    completed: int
    total: int
    creditsUsed: int
    expiresAt: datetime
    next: Optional[str] = None
    data: List[V1FirecrawlDocument]

class V1CrawlParams(pydantic.BaseModel):
    """Parameters for crawling operations."""
    includePaths: Optional[List[str]] = None
    excludePaths: Optional[List[str]] = None
    maxDepth: Optional[int] = None
    maxDiscoveryDepth: Optional[int] = None
    limit: Optional[int] = None
    allowBackwardLinks: Optional[bool] = None
    crawlEntireDomain: Optional[bool] = None
    allowExternalLinks: Optional[bool] = None
    ignoreSitemap: Optional[bool] = None
    scrapeOptions: Optional[V1ScrapeOptions] = None
    webhook: Optional[Union[str, V1WebhookConfig]] = None
    deduplicateSimilarURLs: Optional[bool] = None
    ignoreQueryParameters: Optional[bool] = None
    regexOnFullURL: Optional[bool] = None
    delay: Optional[int] = None  # Delay in seconds between scrapes
    maxConcurrency: Optional[int] = None
    allowSubdomains: Optional[bool] = None

class V1CrawlResponse(pydantic.BaseModel):
    """Response from crawling operations."""
    id: Optional[str] = None
    url: Optional[str] = None
    success: bool = True
    error: Optional[str] = None

class V1CrawlStatusResponse(pydantic.BaseModel):
    """Response from crawl status checks."""
    success: bool = True
    status: Literal["scraping", "completed", "failed", "cancelled"]
    completed: int
    total: int
    creditsUsed: int
    expiresAt: datetime
    next: Optional[str] = None
    data: List[V1FirecrawlDocument]

class V1CrawlError(pydantic.BaseModel):
    """A crawl error."""
    id: str
    timestamp: Optional[datetime] = None
    url: str
    code: Optional[str] = None
    error: str

class V1CrawlErrorsResponse(pydantic.BaseModel):
    """Response from crawl/batch scrape error monitoring."""
    errors: List[V1CrawlError]
    robotsBlocked: List[str]

class V1MapParams(pydantic.BaseModel):
    """Parameters for mapping operations."""
    search: Optional[str] = None
    ignoreSitemap: Optional[bool] = None
    includeSubdomains: Optional[bool] = None
    sitemapOnly: Optional[bool] = None
    limit: Optional[int] = None
    timeout: Optional[int] = 30000
    useIndex: Optional[bool] = None
    location: Optional[V1LocationConfig] = None

class V1MapResponse(pydantic.BaseModel):
    """Response from mapping operations."""
    success: bool = True
    links: Optional[List[str]] = None
    error: Optional[str] = None

class V1ExtractParams(pydantic.BaseModel):
    """Parameters for extracting information from URLs."""
    prompt: Optional[str] = None
    schema_field: Optional[Any] = pydantic.Field(None, alias='schema')
    systemPrompt: Optional[str] = None
    allowExternalLinks: Optional[bool] = None
    enableWebSearch: Optional[bool] = None
    includeSubdomains: Optional[bool] = None
    origin: Optional[str] = None
    showSources: Optional[bool] = None
    scrapeOptions: Optional[V1ScrapeOptions] = None

class V1ExtractResponse(pydantic.BaseModel, Generic[T]):
    """Response from extract operations."""
    id: Optional[str] = None
    status: Optional[Literal["processing", "completed", "failed"]] = None
    expiresAt: Optional[datetime] = None
    success: bool = True
    data: Optional[T] = None
    error: Optional[str] = None
    warning: Optional[str] = None
    sources: Optional[Dict[Any, Any]] = None

class V1SearchParams(pydantic.BaseModel):
    query: str
    limit: Optional[int] = 5
    tbs: Optional[str] = None
    filter: Optional[str] = None
    lang: Optional[str] = "en"
    country: Optional[str] = "us"
    location: Optional[str] = None
    origin: Optional[str] = "api"
    timeout: Optional[int] = 60000
    scrapeOptions: Optional[V1ScrapeOptions] = None

class V1SearchResponse(pydantic.BaseModel):
    """Response from search operations."""
    success: bool = True
    data: List[V1FirecrawlDocument]
    warning: Optional[str] = None
    error: Optional[str] = None

class V1CreditUsageData(pydantic.BaseModel):
    remaining_credits: int
    plan_credits: Optional[int] = None
    billing_period_start: Optional[str] = None
    billing_period_end: Optional[str] = None

class V1CreditUsageResponse(pydantic.BaseModel):
    success: bool
    data: V1CreditUsageData

class V1TokenUsageData(pydantic.BaseModel):
    remaining_tokens: int
    plan_tokens: Optional[int] = None
    billing_period_start: Optional[str] = None
    billing_period_end: Optional[str] = None

class V1TokenUsageResponse(pydantic.BaseModel):
    success: bool
    data: V1TokenUsageData

class V1CreditUsageHistoricalPeriod(pydantic.BaseModel):
    startDate: Optional[str] = None
    endDate: Optional[str] = None
    apiKey: Optional[str] = None
    creditsUsed: int

class V1CreditUsageHistoricalResponse(pydantic.BaseModel):
    success: bool
    periods: List[V1CreditUsageHistoricalPeriod]

class V1TokenUsageHistoricalPeriod(pydantic.BaseModel):
    startDate: Optional[str] = None
    endDate: Optional[str] = None
    apiKey: Optional[str] = None
    tokensUsed: int

class V1TokenUsageHistoricalResponse(pydantic.BaseModel):
    success: bool
    periods: List[V1TokenUsageHistoricalPeriod]

class V1GenerateLLMsTextParams(pydantic.BaseModel):
    """
    Parameters for the LLMs.txt generation operation.
    """
    maxUrls: Optional[int] = 10
    showFullText: Optional[bool] = False
    cache: Optional[bool] = True
    __experimental_stream: Optional[bool] = None

class V1DeepResearchParams(pydantic.BaseModel):
    """
    Parameters for the deep research operation.
    """
    maxDepth: Optional[int] = 7
    timeLimit: Optional[int] = 270
    maxUrls: Optional[int] = 20
    analysisPrompt: Optional[str] = None
    systemPrompt: Optional[str] = None
    __experimental_streamSteps: Optional[bool] = None

class V1DeepResearchResponse(pydantic.BaseModel):
    """
    Response from the deep research operation.
    """
    success: bool
    id: str
    error: Optional[str] = None

class V1DeepResearchStatusResponse(pydantic.BaseModel):
    """
    Status response from the deep research operation.
    """
    success: bool
    data: Optional[Dict[str, Any]] = None
    status: str
    error: Optional[str] = None
    expiresAt: str
    currentDepth: int
    maxDepth: int
    activities: List[Dict[str, Any]]
    sources: List[Dict[str, Any]]
    summaries: List[str]

class V1GenerateLLMsTextResponse(pydantic.BaseModel):
    """Response from LLMs.txt generation operations."""
    success: bool = True
    id: str
    error: Optional[str] = None

class V1GenerateLLMsTextStatusResponseData(pydantic.BaseModel):
    llmstxt: str
    llmsfulltxt: Optional[str] = None

class V1GenerateLLMsTextStatusResponse(pydantic.BaseModel):
    """Status response from LLMs.txt generation operations."""
    success: bool = True
    data: Optional[V1GenerateLLMsTextStatusResponseData] = None
    status: Literal["processing", "completed", "failed"]
    error: Optional[str] = None
    expiresAt: str
    
class V1SearchResponse(pydantic.BaseModel):
    """
    Response from the search operation.
    """
    success: bool
    data: List[Dict[str, Any]]
    warning: Optional[str] = None
    error: Optional[str] = None

class V1ExtractParams(pydantic.BaseModel):
    """
    Parameters for the extract operation.
    """
    prompt: Optional[str] = None
    schema_field: Optional[Any] = pydantic.Field(None, alias='schema')
    system_prompt: Optional[str] = None
    allow_external_links: Optional[bool] = False
    enable_web_search: Optional[bool] = False
    # Just for backwards compatibility
    enableWebSearch: Optional[bool] = False
    show_sources: Optional[bool] = False
    agent: Optional[Dict[str, Any]] = None

class V1FirecrawlApp:
    """
    Legacy v1 Firecrawl client for backward compatibility.
    
    This class provides the complete v1 API implementation including:
    - URL scraping with various formats and options
    - Website crawling with monitoring capabilities
    - Batch scraping operations
    - Search functionality
    - Data extraction with LLM integration
    - Deep research capabilities
    - LLMs.txt generation
    
    This is used by the unified client to provide version-specific access
    through app.v1.method_name() patterns.
    """
    def __init__(self, api_key: Optional[str] = None, api_url: Optional[str] = None) -> None:
        """
        Initialize the V1FirecrawlApp instance with API key, API URL.

        Args:
            api_key (Optional[str]): API key for authenticating with the Firecrawl API.
            api_url (Optional[str]): Base URL for the Firecrawl API.
        """
        self.api_key = api_key or os.getenv('FIRECRAWL_API_KEY')
        self.api_url = api_url or os.getenv('FIRECRAWL_API_URL', 'https://api.firecrawl.dev')
        
        # Only require API key when using cloud service
        if 'api.firecrawl.dev' in self.api_url and self.api_key is None:
            logger.warning("No API key provided for cloud service")
            raise ValueError('No API key provided')
            
        logger.debug(f"Initialized V1FirecrawlApp with API URL: {self.api_url}")

    def scrape_url(
            self,
            url: str,
            *,
            formats: Optional[List[Literal["markdown", "html", "rawHtml", "content", "links", "screenshot", "screenshot@fullPage", "extract", "json", "changeTracking"]]] = None,
            headers: Optional[Dict[str, str]] = None,
            include_tags: Optional[List[str]] = None,
            exclude_tags: Optional[List[str]] = None,
            only_main_content: Optional[bool] = None,
            wait_for: Optional[int] = None,
            timeout: Optional[int] = 30000,
            location: Optional[V1LocationConfig] = None,
            mobile: Optional[bool] = None,
            skip_tls_verification: Optional[bool] = None,
            remove_base64_images: Optional[bool] = None,
            block_ads: Optional[bool] = None,
            proxy: Optional[Literal["basic", "stealth", "auto"]] = None,
            parse_pdf: Optional[bool] = None,
            extract: Optional[V1JsonConfig] = None,
            json_options: Optional[V1JsonConfig] = None,
            actions: Optional[List[Union[V1WaitAction, V1ScreenshotAction, V1ClickAction, V1WriteAction, V1PressAction, V1ScrollAction, V1ScrapeAction, V1ExecuteJavascriptAction, V1PDFAction]]] = None,
            change_tracking_options: Optional[V1ChangeTrackingOptions] = None,
            max_age: Optional[int] = None,
            store_in_cache: Optional[bool] = None,
            zero_data_retention: Optional[bool] = None,
            **kwargs) -> V1ScrapeResponse[Any]:
        """
        Scrape and extract content from a URL.

        Args:
          url (str): Target URL to scrape
          formats (Optional[List[Literal["markdown", "html", "rawHtml", "content", "links", "screenshot", "screenshot@fullPage", "extract", "json"]]]): Content types to retrieve (markdown/html/etc)
          headers (Optional[Dict[str, str]]): Custom HTTP headers
          include_tags (Optional[List[str]]): HTML tags to include
          exclude_tags (Optional[List[str]]): HTML tags to exclude
          only_main_content (Optional[bool]): Extract main content only
          wait_for (Optional[int]): Wait for a specific element to appear
          timeout (Optional[int]): Request timeout (ms)
          location (Optional[LocationConfig]): Location configuration
          mobile (Optional[bool]): Use mobile user agent
          skip_tls_verification (Optional[bool]): Skip TLS verification
          remove_base64_images (Optional[bool]): Remove base64 images
          block_ads (Optional[bool]): Block ads
          proxy (Optional[Literal["basic", "stealth", "auto"]]): Proxy type (basic/stealth)
          extract (Optional[JsonConfig]): Content extraction settings
          json_options (Optional[JsonConfig]): JSON extraction settings
          actions (Optional[List[Union[WaitAction, ScreenshotAction, ClickAction, WriteAction, PressAction, ScrollAction, ScrapeAction, ExecuteJavascriptAction, PDFAction]]]): Actions to perform
          change_tracking_options (Optional[ChangeTrackingOptions]): Change tracking settings
          zero_data_retention (Optional[bool]): Whether to delete data after scrape is done


        Returns:
          ScrapeResponse with:
          * Requested content formats
          * Page metadata
          * Extraction results
          * Success/error status

        Raises:
          Exception: If scraping fails
        """
        # Validate any additional kwargs
        self._validate_kwargs(kwargs, "scrape_url")
        
        _headers = self._prepare_headers()

        # Build scrape parameters
        scrape_params = {
            'url': url,
            'origin': f"python-sdk@{version}"
        }

        # Add optional parameters if provided
        if formats:
            scrape_params['formats'] = formats
        if headers:
            scrape_params['headers'] = headers
        if include_tags:
            scrape_params['includeTags'] = include_tags
        if exclude_tags:
            scrape_params['excludeTags'] = exclude_tags
        if only_main_content is not None:
            scrape_params['onlyMainContent'] = only_main_content
        if wait_for:
            scrape_params['waitFor'] = wait_for
        if timeout:
            scrape_params['timeout'] = timeout
        if location:
            scrape_params['location'] = location.dict(by_alias=True, exclude_none=True)
        if mobile is not None:
            scrape_params['mobile'] = mobile
        if skip_tls_verification is not None:
            scrape_params['skipTlsVerification'] = skip_tls_verification
        if remove_base64_images is not None:
            scrape_params['removeBase64Images'] = remove_base64_images
        if block_ads is not None:
            scrape_params['blockAds'] = block_ads
        if proxy:
            scrape_params['proxy'] = proxy
        if parse_pdf is not None:
            scrape_params['parsePDF'] = parse_pdf
        if extract is not None:
            extract = self._ensure_schema_dict(extract)
            if isinstance(extract, dict) and "schema" in extract:
                extract["schema"] = self._ensure_schema_dict(extract["schema"])
            scrape_params['extract'] = extract if isinstance(extract, dict) else extract.dict(by_alias=True, exclude_none=True)
        if json_options is not None:
            json_options = self._ensure_schema_dict(json_options)
            if isinstance(json_options, dict) and "schema" in json_options:
                json_options["schema"] = self._ensure_schema_dict(json_options["schema"])
            scrape_params['jsonOptions'] = json_options if isinstance(json_options, dict) else json_options.dict(by_alias=True, exclude_none=True)
        if actions:
            scrape_params['actions'] = [action if isinstance(action, dict) else action.dict(by_alias=True, exclude_none=True) for action in actions]
        if change_tracking_options:
            scrape_params['changeTrackingOptions'] = change_tracking_options if isinstance(change_tracking_options, dict) else change_tracking_options.dict(by_alias=True, exclude_none=True)
        if max_age is not None:
            scrape_params['maxAge'] = max_age
        if store_in_cache is not None:
            scrape_params['storeInCache'] = store_in_cache
        if zero_data_retention is not None:
            scrape_params['zeroDataRetention'] = zero_data_retention
        
        scrape_params.update(kwargs)

        if 'extract' in scrape_params and scrape_params['extract'] and 'schema' in scrape_params['extract']:
            scrape_params['extract']['schema'] = self._ensure_schema_dict(scrape_params['extract']['schema'])
        if 'jsonOptions' in scrape_params and scrape_params['jsonOptions'] and 'schema' in scrape_params['jsonOptions']:
            scrape_params['jsonOptions']['schema'] = self._ensure_schema_dict(scrape_params['jsonOptions']['schema'])

        # Make request
        response = requests.post(
            f'{self.api_url}/v1/scrape',
            headers=_headers,
            json=scrape_params,
            timeout=(timeout / 1000.0 + 5 if timeout is not None else None)
        )

        if response.status_code == 200:
            try:
                response_json = response.json()
                if response_json.get('success') and 'data' in response_json:
                    return V1ScrapeResponse(**response_json['data'])
                elif "error" in response_json:
                    raise Exception(f'Failed to scrape URL. Error: {response_json["error"]}')
                else:
                    raise Exception(f'Failed to scrape URL. Error: {response_json}')
            except ValueError:
                raise Exception('Failed to parse Firecrawl response as JSON.')
        else:
            self._handle_error(response, 'scrape URL')

    def search(
            self,
            query: str,
            *,
            limit: Optional[int] = None,
            tbs: Optional[str] = None,
            filter: Optional[str] = None,
            lang: Optional[str] = None,
            country: Optional[str] = None,
            location: Optional[str] = None,
            timeout: Optional[int] = 30000,
            scrape_options: Optional[V1ScrapeOptions] = None,
            **kwargs) -> V1SearchResponse:
        """
        Search for content using Firecrawl.

        Args:
            query (str): Search query string
            limit (Optional[int]): Max results (default: 5)
            tbs (Optional[str]): Time filter (e.g. "qdr:d")
            filter (Optional[str]): Custom result filter
            lang (Optional[str]): Language code (default: "en")
            country (Optional[str]): Country code (default: "us") 
            location (Optional[str]): Geo-targeting
            timeout (Optional[int]): Request timeout in milliseconds
            scrape_options (Optional[ScrapeOptions]): Result scraping configuration
            **kwargs: Additional keyword arguments for future compatibility

        Returns:
            SearchResponse: Response containing:
                * success (bool): Whether request succeeded
                * data (List[FirecrawlDocument]): Search results
                * warning (Optional[str]): Warning message if any
                * error (Optional[str]): Error message if any

        Raises:
            Exception: If search fails or response cannot be parsed
        """
        # Validate any additional kwargs
        self._validate_kwargs(kwargs, "search")

        # Build search parameters
        search_params = {}

        # Add individual parameters
        if limit is not None:
            search_params['limit'] = limit
        if tbs is not None:
            search_params['tbs'] = tbs
        if filter is not None:
            search_params['filter'] = filter
        if lang is not None:
            search_params['lang'] = lang
        if country is not None:
            search_params['country'] = country
        if location is not None:
            search_params['location'] = location
        if timeout is not None:
            search_params['timeout'] = timeout
        if scrape_options is not None:
            search_params['scrapeOptions'] = scrape_options.dict(by_alias=True, exclude_none=True)
        
        # Add any additional kwargs
        search_params.update(kwargs)
        _integration = search_params.get('integration')

        # Create final params object
        final_params = V1SearchParams(query=query, **search_params)
        params_dict = final_params.dict(by_alias=True, exclude_none=True)
        params_dict['origin'] = f"python-sdk@{version}"

        if _integration:
            params_dict['integration'] = _integration

        # Make request
        response = requests.post(
            f"{self.api_url}/v1/search",
            headers={"Authorization": f"Bearer {self.api_key}"},
            json=params_dict
        )

        if response.status_code == 200:
            try:
                response_json = response.json()
                if response_json.get('success') and 'data' in response_json:
                    return V1SearchResponse(**response_json)
                elif "error" in response_json:
                    raise Exception(f'Search failed. Error: {response_json["error"]}')
                else:
                    raise Exception(f'Search failed. Error: {response_json}')
            except ValueError:
                raise Exception('Failed to parse Firecrawl response as JSON.')
        else:
            self._handle_error(response, 'search')

    def get_credit_usage(self) -> V1CreditUsageResponse:
        """Get current credit usage and billing period (v1)."""
        _headers = self._prepare_headers()
        response = self._get_request(
            f"{self.api_url}/v1/team/credit-usage",
            _headers
        )

        if response.status_code == 200:
            try:
                response_json = response.json()
                if response_json.get('success') and 'data' in response_json:
                    return V1CreditUsageResponse(**response_json)
                elif "error" in response_json:
                    raise Exception(f"Failed to get credit usage. Error: {response_json['error']}")
                else:
                    raise Exception(f"Failed to get credit usage. Error: {response_json}")
            except ValueError:
                raise Exception('Failed to parse Firecrawl response as JSON.')
        else:
            self._handle_error(response, 'get credit usage')

    def get_token_usage(self) -> V1TokenUsageResponse:
        """Get current token usage and billing period (v1)."""
        _headers = self._prepare_headers()
        response = self._get_request(
            f"{self.api_url}/v1/team/token-usage",
            _headers
        )

        if response.status_code == 200:
            try:
                response_json = response.json()
                if response_json.get('success') and 'data' in response_json:
                    return V1TokenUsageResponse(**response_json)
                elif "error" in response_json:
                    raise Exception(f"Failed to get token usage. Error: {response_json['error']}")
                else:
                    raise Exception(f"Failed to get token usage. Error: {response_json}")
            except ValueError:
                raise Exception('Failed to parse Firecrawl response as JSON.')
        else:
            self._handle_error(response, 'get token usage')

    def get_credit_usage_historical(self, by_api_key: bool = False) -> V1CreditUsageHistoricalResponse:
        """Get historical credit usage (v1)."""
        _headers = self._prepare_headers()
        url = f"{self.api_url}/v1/team/credit-usage/historical" + ("?byApiKey=true" if by_api_key else "")
        response = self._get_request(url, _headers)

        if response.status_code == 200:
            try:
                response_json = response.json()
                if response_json.get('success') and 'periods' in response_json:
                    return V1CreditUsageHistoricalResponse(**response_json)
                elif "error" in response_json:
                    raise Exception(f"Failed to get historical credit usage. Error: {response_json['error']}")
                else:
                    raise Exception(f"Failed to get historical credit usage. Error: {response_json}")
            except ValueError:
                raise Exception('Failed to parse Firecrawl response as JSON.')
        else:
            self._handle_error(response, 'get credit usage historical')

    def get_token_usage_historical(self, by_api_key: bool = False) -> V1TokenUsageHistoricalResponse:
        """Get historical token usage (v1)."""
        _headers = self._prepare_headers()
        url = f"{self.api_url}/v1/team/token-usage/historical" + ("?byApiKey=true" if by_api_key else "")
        response = self._get_request(url, _headers)

        if response.status_code == 200:
            try:
                response_json = response.json()
                if response_json.get('success') and 'periods' in response_json:
                    return V1TokenUsageHistoricalResponse(**response_json)
                elif "error" in response_json:
                    raise Exception(f"Failed to get historical token usage. Error: {response_json['error']}")
                else:
                    raise Exception(f"Failed to get historical token usage. Error: {response_json}")
            except ValueError:
                raise Exception('Failed to parse Firecrawl response as JSON.')
        else:
            self._handle_error(response, 'get token usage historical')

    def crawl_url(
        self,
        url: str,
        *,
        include_paths: Optional[List[str]] = None,
        exclude_paths: Optional[List[str]] = None,
        max_depth: Optional[int] = None,
        max_discovery_depth: Optional[int] = None,
        limit: Optional[int] = None,
        allow_backward_links: Optional[bool] = None,
        crawl_entire_domain: Optional[bool] = None,
        allow_external_links: Optional[bool] = None,
        ignore_sitemap: Optional[bool] = None,
        scrape_options: Optional[V1ScrapeOptions] = None,
        webhook: Optional[Union[str, V1WebhookConfig]] = None,
        deduplicate_similar_urls: Optional[bool] = None,
        ignore_query_parameters: Optional[bool] = None,
        regex_on_full_url: Optional[bool] = None,
        delay: Optional[int] = None,
        allow_subdomains: Optional[bool] = None,
        max_concurrency: Optional[int] = None,
        zero_data_retention: Optional[bool] = None,
        poll_interval: Optional[int] = 2,
        idempotency_key: Optional[str] = None,
        **kwargs
    ) -> V1CrawlStatusResponse:
        """
        Crawl a website starting from a URL.

        Args:
            url (str): Target URL to start crawling from
            include_paths (Optional[List[str]]): Patterns of URLs to include
            exclude_paths (Optional[List[str]]): Patterns of URLs to exclude
            max_depth (Optional[int]): Maximum crawl depth
            max_discovery_depth (Optional[int]): Maximum depth for finding new URLs
            limit (Optional[int]): Maximum pages to crawl
            allow_backward_links (Optional[bool]): DEPRECATED: Use crawl_entire_domain instead
            crawl_entire_domain (Optional[bool]): Follow parent directory links
            allow_external_links (Optional[bool]): Follow external domain links
            ignore_sitemap (Optional[bool]): Skip sitemap.xml processing
            scrape_options (Optional[ScrapeOptions]): Page scraping configuration
            webhook (Optional[Union[str, WebhookConfig]]): Notification webhook settings
            deduplicate_similar_urls (Optional[bool]): Remove similar URLs
            ignore_query_parameters (Optional[bool]): Ignore URL parameters
            regex_on_full_url (Optional[bool]): Apply regex to full URLs
            delay (Optional[int]): Delay in seconds between scrapes
            allow_subdomains (Optional[bool]): Follow subdomains
            max_concurrency (Optional[int]): Maximum number of concurrent scrapes
            zero_data_retention (Optional[bool]): Whether to delete data after 24 hours
            poll_interval (Optional[int]): Seconds between status checks (default: 2)
            idempotency_key (Optional[str]): Unique key to prevent duplicate requests
            **kwargs: Additional parameters to pass to the API

        Returns:
            CrawlStatusResponse with:
            * Crawling status and progress
            * Crawled page contents
            * Success/error information

        Raises:
            Exception: If crawl fails
        """
        # Validate any additional kwargs
        self._validate_kwargs(kwargs, "crawl_url")

        crawl_params = {}

        # Add individual parameters
        if include_paths is not None:
            crawl_params['includePaths'] = include_paths
        if exclude_paths is not None:
            crawl_params['excludePaths'] = exclude_paths
        if max_depth is not None:
            crawl_params['maxDepth'] = max_depth
        if max_discovery_depth is not None:
            crawl_params['maxDiscoveryDepth'] = max_discovery_depth
        if limit is not None:
            crawl_params['limit'] = limit
        if crawl_entire_domain is not None:
            crawl_params['crawlEntireDomain'] = crawl_entire_domain
        elif allow_backward_links is not None:
            crawl_params['allowBackwardLinks'] = allow_backward_links
        if allow_external_links is not None:
            crawl_params['allowExternalLinks'] = allow_external_links
        if ignore_sitemap is not None:
            crawl_params['ignoreSitemap'] = ignore_sitemap
        if scrape_options is not None:
            crawl_params['scrapeOptions'] = scrape_options.dict(by_alias=True, exclude_none=True)
        if webhook is not None:
            crawl_params['webhook'] = webhook
        if deduplicate_similar_urls is not None:
            crawl_params['deduplicateSimilarURLs'] = deduplicate_similar_urls
        if ignore_query_parameters is not None:
            crawl_params['ignoreQueryParameters'] = ignore_query_parameters
        if regex_on_full_url is not None:
            crawl_params['regexOnFullURL'] = regex_on_full_url
        if delay is not None:
            crawl_params['delay'] = delay
        if allow_subdomains is not None:
            crawl_params['allowSubdomains'] = allow_subdomains
        if max_concurrency is not None:
            crawl_params['maxConcurrency'] = max_concurrency
        if zero_data_retention is not None:
            crawl_params['zeroDataRetention'] = zero_data_retention
        # Add any additional kwargs
        crawl_params.update(kwargs)
        _integration = crawl_params.get('integration')

        # Create final params object
        final_params = V1CrawlParams(**crawl_params)
        params_dict = final_params.dict(by_alias=True, exclude_none=True)
        params_dict['url'] = url
        params_dict['origin'] = f"python-sdk@{version}"

        if _integration:
            params_dict['integration'] = _integration

        # Make request
        headers = self._prepare_headers(idempotency_key)
        response = self._post_request(f'{self.api_url}/v1/crawl', params_dict, headers)

        if response.status_code == 200:
            try:
                id = response.json().get('id')
            except:
                raise Exception(f'Failed to parse Firecrawl response as JSON.')
            return self._monitor_job_status(id, headers, poll_interval)
        else:
            self._handle_error(response, 'start crawl job')

    def async_crawl_url(
        self,
        url: str,
        *,
        include_paths: Optional[List[str]] = None,
        exclude_paths: Optional[List[str]] = None,
        max_depth: Optional[int] = None,
        max_discovery_depth: Optional[int] = None,
        limit: Optional[int] = None,
        allow_backward_links: Optional[bool] = None,
        crawl_entire_domain: Optional[bool] = None,
        allow_external_links: Optional[bool] = None,
        ignore_sitemap: Optional[bool] = None,
        scrape_options: Optional[V1ScrapeOptions] = None,
        webhook: Optional[Union[str, V1WebhookConfig]] = None,
        deduplicate_similar_urls: Optional[bool] = None,
        ignore_query_parameters: Optional[bool] = None,
        regex_on_full_url: Optional[bool] = None,
        delay: Optional[int] = None,
        allow_subdomains: Optional[bool] = None,
        max_concurrency: Optional[int] = None,
        zero_data_retention: Optional[bool] = None,
        idempotency_key: Optional[str] = None,
        **kwargs
    ) -> V1CrawlResponse:
        """
        Start an asynchronous crawl job.

        Args:
            url (str): Target URL to start crawling from
            include_paths (Optional[List[str]]): Patterns of URLs to include
            exclude_paths (Optional[List[str]]): Patterns of URLs to exclude
            max_depth (Optional[int]): Maximum crawl depth
            max_discovery_depth (Optional[int]): Maximum depth for finding new URLs
            limit (Optional[int]): Maximum pages to crawl
            allow_backward_links (Optional[bool]): DEPRECATED: Use crawl_entire_domain instead
            crawl_entire_domain (Optional[bool]): Follow parent directory links
            allow_external_links (Optional[bool]): Follow external domain links
            ignore_sitemap (Optional[bool]): Skip sitemap.xml processing
            scrape_options (Optional[V1ScrapeOptions]): Page scraping configuration
            webhook (Optional[Union[str, V1WebhookConfig]]): Notification webhook settings
            deduplicate_similar_urls (Optional[bool]): Remove similar URLs
            ignore_query_parameters (Optional[bool]): Ignore URL parameters
            regex_on_full_url (Optional[bool]): Apply regex to full URLs
            delay (Optional[int]): Delay in seconds between scrapes
            allow_subdomains (Optional[bool]): Follow subdomains
            max_concurrency (Optional[int]): Maximum number of concurrent scrapes
            zero_data_retention (Optional[bool]): Whether to delete data after 24 hours
            idempotency_key (Optional[str]): Unique key to prevent duplicate requests
            **kwargs: Additional parameters to pass to the API

        Returns:
            V1CrawlResponse with:
            * success - Whether crawl started successfully
            * id - Unique identifier for the crawl job
            * url - Status check URL for the crawl
            * error - Error message if start failed

        Raises:
            Exception: If crawl initiation fails
        """
        # Validate any additional kwargs
        self._validate_kwargs(kwargs, "async_crawl_url")

        crawl_params = {}

        # Add individual parameters
        if include_paths is not None:
            crawl_params['includePaths'] = include_paths
        if exclude_paths is not None:
            crawl_params['excludePaths'] = exclude_paths
        if max_depth is not None:
            crawl_params['maxDepth'] = max_depth
        if max_discovery_depth is not None:
            crawl_params['maxDiscoveryDepth'] = max_discovery_depth
        if limit is not None:
            crawl_params['limit'] = limit
        if crawl_entire_domain is not None:
            crawl_params['crawlEntireDomain'] = crawl_entire_domain
        elif allow_backward_links is not None:
            crawl_params['allowBackwardLinks'] = allow_backward_links
        if allow_external_links is not None:
            crawl_params['allowExternalLinks'] = allow_external_links
        if ignore_sitemap is not None:
            crawl_params['ignoreSitemap'] = ignore_sitemap
        if scrape_options is not None:
            crawl_params['scrapeOptions'] = scrape_options.dict(by_alias=True, exclude_none=True)
        if webhook is not None:
            crawl_params['webhook'] = webhook
        if deduplicate_similar_urls is not None:
            crawl_params['deduplicateSimilarURLs'] = deduplicate_similar_urls
        if ignore_query_parameters is not None:
            crawl_params['ignoreQueryParameters'] = ignore_query_parameters
        if regex_on_full_url is not None:
            crawl_params['regexOnFullURL'] = regex_on_full_url
        if delay is not None:
            crawl_params['delay'] = delay
        if allow_subdomains is not None:
            crawl_params['allowSubdomains'] = allow_subdomains
        if max_concurrency is not None:
            crawl_params['maxConcurrency'] = max_concurrency
        if zero_data_retention is not None:
            crawl_params['zeroDataRetention'] = zero_data_retention
        # Add any additional kwargs
        crawl_params.update(kwargs)

        # Create final params object
        final_params = V1CrawlParams(**crawl_params)
        params_dict = final_params.dict(by_alias=True, exclude_none=True)
        params_dict['url'] = url
        params_dict['origin'] = f"python-sdk@{version}"

        # Make request
        headers = self._prepare_headers(idempotency_key)
        response = self._post_request(f'{self.api_url}/v1/crawl', params_dict, headers)

        if response.status_code == 200:
            try:
                return V1CrawlResponse(**response.json())
            except:
                raise Exception(f'Failed to parse Firecrawl response as JSON.')
        else:
            self._handle_error(response, 'start crawl job')

    def check_crawl_status(self, id: str) -> V1CrawlStatusResponse:
        """
        Check the status and results of a crawl job.

        Args:
            id: Unique identifier for the crawl job

        Returns:
            V1CrawlStatusResponse containing:

            Status Information:
            * status - Current state (scraping/completed/failed/cancelled)
            * completed - Number of pages crawled
            * total - Total pages to crawl
            * creditsUsed - API credits consumed
            * expiresAt - Data expiration timestamp
            
            Results:
            * data - List of crawled documents
            * next - URL for next page of results (if paginated)
            * success - Whether status check succeeded
            * error - Error message if failed

        Raises:
            Exception: If status check fails
        """
        endpoint = f'/v1/crawl/{id}'

        headers = self._prepare_headers()
        response = self._get_request(f'{self.api_url}{endpoint}', headers)
        if response.status_code == 200:
            try:
                status_data = response.json()
            except:
                raise Exception(f'Failed to parse Firecrawl response as JSON.')
            if status_data['status'] == 'completed':
                if 'data' in status_data:
                    data = status_data['data']
                    while 'next' in status_data:
                        if len(status_data['data']) == 0:
                            break
                        next_url = status_data.get('next')
                        if not next_url:
                            logger.warning("Expected 'next' URL is missing.")
                            break
                        try:
                            status_response = self._get_request(next_url, headers)
                            if status_response.status_code != 200:
                                logger.error(f"Failed to fetch next page: {status_response.status_code}")
                                break
                            try:
                                next_data = status_response.json()
                            except:
                                raise Exception(f'Failed to parse Firecrawl response as JSON.')
                            data.extend(next_data.get('data', []))
                            status_data = next_data
                        except Exception as e:
                            logger.error(f"Error during pagination request: {e}")
                            break
                    status_data['data'] = data

            response = {
                'status': status_data.get('status'),
                'total': status_data.get('total'),
                'completed': status_data.get('completed'),
                'creditsUsed': status_data.get('creditsUsed'),
                'expiresAt': status_data.get('expiresAt'),
                'data': status_data.get('data')
            }

            if 'error' in status_data:
                response['error'] = status_data['error']

            if 'next' in status_data:
                response['next'] = status_data['next']

            return V1CrawlStatusResponse(
                success=False if 'error' in status_data else True,
                **response
            )
        else:
            self._handle_error(response, 'check crawl status')
    
    def check_crawl_errors(self, id: str) -> V1CrawlErrorsResponse:
        """
        Returns information about crawl errors.

        Args:
            id (str): The ID of the crawl job

        Returns:
            V1CrawlErrorsResponse containing:
            * errors (List[Dict[str, str]]): List of errors with fields:
                - id (str): Error ID
                - timestamp (str): When the error occurred
                - url (str): URL that caused the error
                - error (str): Error message
            * robotsBlocked (List[str]): List of URLs blocked by robots.txt

        Raises:
            Exception: If error check fails
        """
        headers = self._prepare_headers()
        response = self._get_request(f'{self.api_url}/v1/crawl/{id}/errors', headers)
        if response.status_code == 200:
            try:
                return V1CrawlErrorsResponse(**response.json())
            except:
                raise Exception(f'Failed to parse Firecrawl response as JSON.')
        else:
            self._handle_error(response, "check crawl errors")
    
    def cancel_crawl(self, id: str) -> Dict[str, Any]:
        """
        Cancel an asynchronous crawl job.

        Args:
            id (str): The ID of the crawl job to cancel

        Returns:
            Dict[str, Any] containing:
            * success (bool): Whether cancellation was successful
            * error (str, optional): Error message if cancellation failed

        Raises:
            Exception: If cancellation fails
        """
        headers = self._prepare_headers()
        response = self._delete_request(f'{self.api_url}/v1/crawl/{id}', headers)
        if response.status_code == 200:
            try:
                return response.json()
            except:
                raise Exception(f'Failed to parse Firecrawl response as JSON.')
        else:
            self._handle_error(response, "cancel crawl job")

    def crawl_url_and_watch(
            self,
            url: str,
            *,
            include_paths: Optional[List[str]] = None,
            exclude_paths: Optional[List[str]] = None,
            max_depth: Optional[int] = None,
            max_discovery_depth: Optional[int] = None,
            limit: Optional[int] = None,
            allow_backward_links: Optional[bool] = None,
            crawl_entire_domain: Optional[bool] = None,
            allow_external_links: Optional[bool] = None,
            ignore_sitemap: Optional[bool] = None,
            scrape_options: Optional[V1ScrapeOptions] = None,
            webhook: Optional[Union[str, V1WebhookConfig]] = None,
            deduplicate_similar_urls: Optional[bool] = None,
            ignore_query_parameters: Optional[bool] = None,
            regex_on_full_url: Optional[bool] = None,
            delay: Optional[int] = None,
            allow_subdomains: Optional[bool] = None,
            max_concurrency: Optional[int] = None,
            zero_data_retention: Optional[bool] = None,
            idempotency_key: Optional[str] = None,
            **kwargs
    ) -> 'V1CrawlWatcher':
        """
        Initiate a crawl job and return a CrawlWatcher to monitor the job via WebSocket.

        Args:
            url (str): Target URL to start crawling from
            include_paths (Optional[List[str]]): Patterns of URLs to include
            exclude_paths (Optional[List[str]]): Patterns of URLs to exclude
            max_depth (Optional[int]): Maximum crawl depth
            max_discovery_depth (Optional[int]): Maximum depth for finding new URLs
            limit (Optional[int]): Maximum pages to crawl
            allow_backward_links (Optional[bool]): DEPRECATED: Use crawl_entire_domain instead
            crawl_entire_domain (Optional[bool]): Follow parent directory links
            allow_external_links (Optional[bool]): Follow external domain links
            ignore_sitemap (Optional[bool]): Skip sitemap.xml processing
            scrape_options (Optional[V1ScrapeOptions]): Page scraping configuration
            webhook (Optional[Union[str, V1WebhookConfig]]): Notification webhook settings
            deduplicate_similar_urls (Optional[bool]): Remove similar URLs
            ignore_query_parameters (Optional[bool]): Ignore URL parameters
            regex_on_full_url (Optional[bool]): Apply regex to full URLs
            delay (Optional[int]): Delay in seconds between scrapes
            allow_subdomains (Optional[bool]): Follow subdomains
            max_concurrency (Optional[int]): Maximum number of concurrent scrapes
            zero_data_retention (Optional[bool]): Whether to delete data after 24 hours
            idempotency_key (Optional[str]): Unique key to prevent duplicate requests
            **kwargs: Additional parameters to pass to the API

        Returns:
            V1CrawlWatcher: An instance to monitor the crawl job via WebSocket

        Raises:
            Exception: If crawl job fails to start
        """
        crawl_response = self.async_crawl_url(
            url,
            include_paths=include_paths,
            exclude_paths=exclude_paths,
            max_depth=max_depth,
            max_discovery_depth=max_discovery_depth,
            limit=limit,
            allow_backward_links=allow_backward_links,
            crawl_entire_domain=crawl_entire_domain,
            allow_external_links=allow_external_links,
            ignore_sitemap=ignore_sitemap,
            scrape_options=scrape_options,
            webhook=webhook,
            deduplicate_similar_urls=deduplicate_similar_urls,
            ignore_query_parameters=ignore_query_parameters,
            regex_on_full_url=regex_on_full_url,
            delay=delay,
            allow_subdomains=allow_subdomains,
            max_concurrency=max_concurrency,
            zero_data_retention=zero_data_retention,
            idempotency_key=idempotency_key,
            **kwargs
        )
        if crawl_response.success and crawl_response.id:
            return V1CrawlWatcher(crawl_response.id, self)
        else:
            raise Exception("Crawl job failed to start")

    def map_url(
            self,
            url: str,
            *,
            search: Optional[str] = None,
            ignore_sitemap: Optional[bool] = None,
            include_subdomains: Optional[bool] = None,
            sitemap_only: Optional[bool] = None,
            limit: Optional[int] = None,
            timeout: Optional[int] = 30000,
            use_index: Optional[bool] = None,
            location: Optional[V1LocationConfig] = None,
            **kwargs) -> V1MapResponse:
        """
        Map and discover links from a URL.

        Args:
            url (str): Target URL to map
            search (Optional[str]): Filter pattern for URLs
            ignore_sitemap (Optional[bool]): Skip sitemap.xml processing
            include_subdomains (Optional[bool]): Include subdomain links
            sitemap_only (Optional[bool]): Only use sitemap.xml
            limit (Optional[int]): Maximum URLs to return
            timeout (Optional[int]): Request timeout in milliseconds
            **kwargs: Additional parameters to pass to the API

        Returns:
            V1MapResponse: Response containing:
                * success (bool): Whether request succeeded
                * links (List[str]): Discovered URLs
                * error (Optional[str]): Error message if any

        Raises:
            Exception: If mapping fails or response cannot be parsed
        """
        # Validate any additional kwargs
        self._validate_kwargs(kwargs, "map_url")

        # Build map parameters
        map_params = {}

        # Add individual parameters
        if search is not None:
            map_params['search'] = search
        if ignore_sitemap is not None:
            map_params['ignoreSitemap'] = ignore_sitemap
        if include_subdomains is not None:
            map_params['includeSubdomains'] = include_subdomains
        if sitemap_only is not None:
            map_params['sitemapOnly'] = sitemap_only
        if limit is not None:
            map_params['limit'] = limit
        if timeout is not None:
            map_params['timeout'] = timeout
        if use_index is not None:
            map_params['useIndex'] = use_index
        if location is not None:
            map_params['location'] = location.dict(by_alias=True, exclude_none=True)
        
        # Add any additional kwargs
        map_params.update(kwargs)
        _integration = map_params.get('integration')

        # Create final params object
        final_params = V1MapParams(**map_params)
        params_dict = final_params.dict(by_alias=True, exclude_none=True)
        params_dict['url'] = url
        params_dict['origin'] = f"python-sdk@{version}"

        if _integration:
            params_dict['integration'] = _integration

        # Make request
        response = requests.post(
            f"{self.api_url}/v1/map",
            headers={"Authorization": f"Bearer {self.api_key}"},
            json=params_dict
        )

        if response.status_code == 200:
            try:
                response_json = response.json()
                if response_json.get('success') and 'links' in response_json:
                    return V1MapResponse(**response_json)
                elif "error" in response_json:
                    raise Exception(f'Map failed. Error: {response_json["error"]}')
                else:
                    raise Exception(f'Map failed. Error: {response_json}')
            except ValueError:
                raise Exception('Failed to parse Firecrawl response as JSON.')
        else:
            self._handle_error(response, 'map')

    def batch_scrape_urls(
        self,
        urls: List[str],
        *,
        formats: Optional[List[Literal["markdown", "html", "rawHtml", "content", "links", "screenshot", "screenshot@fullPage", "extract", "json"]]] = None,
        headers: Optional[Dict[str, str]] = None,
        include_tags: Optional[List[str]] = None,
        exclude_tags: Optional[List[str]] = None,
        only_main_content: Optional[bool] = None,
        wait_for: Optional[int] = None,
        timeout: Optional[int] = 30000,
        location: Optional[V1LocationConfig] = None,
        mobile: Optional[bool] = None,
        skip_tls_verification: Optional[bool] = None,
        remove_base64_images: Optional[bool] = None,
        block_ads: Optional[bool] = None,
        proxy: Optional[Literal["basic", "stealth", "auto"]] = None,
        extract: Optional[V1JsonConfig] = None,
        json_options: Optional[V1JsonConfig] = None,
        actions: Optional[List[Union[V1WaitAction, V1ScreenshotAction, V1ClickAction, V1WriteAction, V1PressAction, V1ScrollAction, V1ScrapeAction, V1ExecuteJavascriptAction, V1PDFAction]]] = None,
        agent: Optional[V1AgentOptions] = None,
        poll_interval: Optional[int] = 2,
        max_concurrency: Optional[int] = None,
        zero_data_retention: Optional[bool] = None,
        idempotency_key: Optional[str] = None,
        **kwargs
    ) -> V1BatchScrapeStatusResponse:
        """
        Batch scrape multiple URLs and monitor until completion.

        Args:
            urls (List[str]): URLs to scrape
            formats (Optional[List[Literal]]): Content formats to retrieve
            headers (Optional[Dict[str, str]]): Custom HTTP headers
            include_tags (Optional[List[str]]): HTML tags to include
            exclude_tags (Optional[List[str]]): HTML tags to exclude
            only_main_content (Optional[bool]): Extract main content only
            wait_for (Optional[int]): Wait time in milliseconds
            timeout (Optional[int]): Request timeout in milliseconds
            location (Optional[LocationConfig]): Location configuration
            mobile (Optional[bool]): Use mobile user agent
            skip_tls_verification (Optional[bool]): Skip TLS verification
            remove_base64_images (Optional[bool]): Remove base64 encoded images
            block_ads (Optional[bool]): Block advertisements
            proxy (Optional[Literal]): Proxy type to use
            extract (Optional[JsonConfig]): Content extraction config
            json_options (Optional[JsonConfig]): JSON extraction config
            actions (Optional[List[Union]]): Actions to perform
            agent (Optional[AgentOptions]): Agent configuration
            max_concurrency (Optional[int]): Maximum number of concurrent scrapes
            poll_interval (Optional[int]): Seconds between status checks (default: 2)
            idempotency_key (Optional[str]): Unique key to prevent duplicate requests
            **kwargs: Additional parameters to pass to the API

        Returns:
            V1BatchScrapeStatusResponse with:
            * Scraping status and progress
            * Scraped content for each URL
            * Success/error information

        Raises:
            Exception: If batch scrape fails
        """
        # Validate any additional kwargs
        self._validate_kwargs(kwargs, "batch_scrape_urls")

        scrape_params = {}

        # Add individual parameters
        if formats is not None:
            scrape_params['formats'] = formats
        if headers is not None:
            scrape_params['headers'] = headers
        if include_tags is not None:
            scrape_params['includeTags'] = include_tags
        if exclude_tags is not None:
            scrape_params['excludeTags'] = exclude_tags
        if only_main_content is not None:
            scrape_params['onlyMainContent'] = only_main_content
        if wait_for is not None:
            scrape_params['waitFor'] = wait_for
        if timeout is not None:
            scrape_params['timeout'] = timeout
        if location is not None:
            scrape_params['location'] = location.dict(by_alias=True, exclude_none=True)
        if mobile is not None:
            scrape_params['mobile'] = mobile
        if skip_tls_verification is not None:
            scrape_params['skipTlsVerification'] = skip_tls_verification
        if remove_base64_images is not None:
            scrape_params['removeBase64Images'] = remove_base64_images
        if block_ads is not None:
            scrape_params['blockAds'] = block_ads
        if proxy is not None:
            scrape_params['proxy'] = proxy
        if extract is not None:
            extract = self._ensure_schema_dict(extract)
            if isinstance(extract, dict) and "schema" in extract:
                extract["schema"] = self._ensure_schema_dict(extract["schema"])
            scrape_params['extract'] = extract if isinstance(extract, dict) else extract.dict(by_alias=True, exclude_none=True)
        if json_options is not None:
            json_options = self._ensure_schema_dict(json_options)
            if isinstance(json_options, dict) and "schema" in json_options:
                json_options["schema"] = self._ensure_schema_dict(json_options["schema"])
            scrape_params['jsonOptions'] = json_options if isinstance(json_options, dict) else json_options.dict(by_alias=True, exclude_none=True)
        if actions:
            scrape_params['actions'] = [action if isinstance(action, dict) else action.dict(by_alias=True, exclude_none=True) for action in actions]
        if agent is not None:
            scrape_params['agent'] = agent.dict(by_alias=True, exclude_none=True)
        if max_concurrency is not None:
            scrape_params['maxConcurrency'] = max_concurrency
        if zero_data_retention is not None:
            scrape_params['zeroDataRetention'] = zero_data_retention
        
        # Add any additional kwargs
        scrape_params.update(kwargs)

        # Create final params object
        final_params = V1ScrapeParams(**scrape_params)
        params_dict = final_params.dict(by_alias=True, exclude_none=True)
        params_dict['urls'] = urls
        params_dict['origin'] = f"python-sdk@{version}"

        if 'extract' in params_dict and params_dict['extract'] and 'schema' in params_dict['extract']:
            params_dict['extract']['schema'] = self._ensure_schema_dict(params_dict['extract']['schema'])
        if 'jsonOptions' in params_dict and params_dict['jsonOptions'] and 'schema' in params_dict['jsonOptions']:
            params_dict['jsonOptions']['schema'] = self._ensure_schema_dict(params_dict['jsonOptions']['schema'])

        # Make request
        headers = self._prepare_headers(idempotency_key)
        response = self._post_request(f'{self.api_url}/v1/batch/scrape', params_dict, headers)

        if response.status_code == 200:
            try:
                id = response.json().get('id')
            except:
                raise Exception(f'Failed to parse Firecrawl response as JSON.')
            return self._monitor_job_status(id, headers, poll_interval)
        else:
            self._handle_error(response, 'start batch scrape job')

    def async_batch_scrape_urls(
        self,
        urls: List[str],
        *,
        formats: Optional[List[Literal["markdown", "html", "rawHtml", "content", "links", "screenshot", "screenshot@fullPage", "extract", "json"]]] = None,
        headers: Optional[Dict[str, str]] = None,
        include_tags: Optional[List[str]] = None,
        exclude_tags: Optional[List[str]] = None,
        only_main_content: Optional[bool] = None,
        wait_for: Optional[int] = None,
        timeout: Optional[int] = 30000,
        location: Optional[V1LocationConfig] = None,
        mobile: Optional[bool] = None,
        skip_tls_verification: Optional[bool] = None,
        remove_base64_images: Optional[bool] = None,
        block_ads: Optional[bool] = None,
        proxy: Optional[Literal["basic", "stealth", "auto"]] = None,
        extract: Optional[V1JsonConfig] = None,
        json_options: Optional[V1JsonConfig] = None,
        actions: Optional[List[Union[V1WaitAction, V1ScreenshotAction, V1ClickAction, V1WriteAction, V1PressAction, V1ScrollAction, V1ScrapeAction, V1ExecuteJavascriptAction, V1PDFAction]]] = None,
        agent: Optional[V1AgentOptions] = None,
        max_concurrency: Optional[int] = None,
        idempotency_key: Optional[str] = None,
        zero_data_retention: Optional[bool] = None,
        **kwargs
    ) -> V1BatchScrapeResponse:
        """
        Initiate a batch scrape job asynchronously.

        Args:
            urls (List[str]): URLs to scrape
            formats (Optional[List[Literal]]): Content formats to retrieve
            headers (Optional[Dict[str, str]]): Custom HTTP headers
            include_tags (Optional[List[str]]): HTML tags to include
            exclude_tags (Optional[List[str]]): HTML tags to exclude
            only_main_content (Optional[bool]): Extract main content only
            wait_for (Optional[int]): Wait time in milliseconds
            timeout (Optional[int]): Request timeout in milliseconds
            location (Optional[LocationConfig]): Location configuration
            mobile (Optional[bool]): Use mobile user agent
            skip_tls_verification (Optional[bool]): Skip TLS verification
            remove_base64_images (Optional[bool]): Remove base64 encoded images
            block_ads (Optional[bool]): Block advertisements
            proxy (Optional[Literal]): Proxy type to use
            extract (Optional[JsonConfig]): Content extraction config
            json_options (Optional[JsonConfig]): JSON extraction config
            actions (Optional[List[Union]]): Actions to perform
            agent (Optional[AgentOptions]): Agent configuration
            max_concurrency (Optional[int]): Maximum number of concurrent scrapes
            zero_data_retention (Optional[bool]): Whether to delete data after 24 hours
            idempotency_key (Optional[str]): Unique key to prevent duplicate requests
            **kwargs: Additional parameters to pass to the API

        Returns:
            V1BatchScrapeResponse with:
            * success - Whether job started successfully
            * id - Unique identifier for the job
            * url - Status check URL
            * error - Error message if start failed

        Raises:
            Exception: If job initiation fails
        """
        # Validate any additional kwargs
        self._validate_kwargs(kwargs, "async_batch_scrape_urls")

        scrape_params = {}

        # Add individual parameters
        if formats is not None:
            scrape_params['formats'] = formats
        if headers is not None:
            scrape_params['headers'] = headers
        if include_tags is not None:
            scrape_params['includeTags'] = include_tags
        if exclude_tags is not None:
            scrape_params['excludeTags'] = exclude_tags
        if only_main_content is not None:
            scrape_params['onlyMainContent'] = only_main_content
        if wait_for is not None:
            scrape_params['waitFor'] = wait_for
        if timeout is not None:
            scrape_params['timeout'] = timeout
        if location is not None:
            scrape_params['location'] = location.dict(by_alias=True, exclude_none=True)
        if mobile is not None:
            scrape_params['mobile'] = mobile
        if skip_tls_verification is not None:
            scrape_params['skipTlsVerification'] = skip_tls_verification
        if remove_base64_images is not None:
            scrape_params['removeBase64Images'] = remove_base64_images
        if block_ads is not None:
            scrape_params['blockAds'] = block_ads
        if proxy is not None:
            scrape_params['proxy'] = proxy
        if extract is not None:
            extract = self._ensure_schema_dict(extract)
            if isinstance(extract, dict) and "schema" in extract:
                extract["schema"] = self._ensure_schema_dict(extract["schema"])
            scrape_params['extract'] = extract if isinstance(extract, dict) else extract.dict(by_alias=True, exclude_none=True)
        if json_options is not None:
            json_options = self._ensure_schema_dict(json_options)
            if isinstance(json_options, dict) and "schema" in json_options:
                json_options["schema"] = self._ensure_schema_dict(json_options["schema"])
            scrape_params['jsonOptions'] = json_options if isinstance(json_options, dict) else json_options.dict(by_alias=True, exclude_none=True)
        if actions:
            scrape_params['actions'] = [action if isinstance(action, dict) else action.dict(by_alias=True, exclude_none=True) for action in actions]
        if agent is not None:
            scrape_params['agent'] = agent.dict(by_alias=True, exclude_none=True)
        if max_concurrency is not None:
            scrape_params['maxConcurrency'] = max_concurrency
        if zero_data_retention is not None:
            scrape_params['zeroDataRetention'] = zero_data_retention
        
        # Add any additional kwargs
        scrape_params.update(kwargs)

        # Create final params object
        final_params = V1ScrapeParams(**scrape_params)
        params_dict = final_params.dict(by_alias=True, exclude_none=True)
        params_dict['urls'] = urls
        params_dict['origin'] = f"python-sdk@{version}"

        if 'extract' in params_dict and params_dict['extract'] and 'schema' in params_dict['extract']:
            params_dict['extract']['schema'] = self._ensure_schema_dict(params_dict['extract']['schema'])
        if 'jsonOptions' in params_dict and params_dict['jsonOptions'] and 'schema' in params_dict['jsonOptions']:
            params_dict['jsonOptions']['schema'] = self._ensure_schema_dict(params_dict['jsonOptions']['schema'])

        # Make request
        headers = self._prepare_headers(idempotency_key)
        response = self._post_request(f'{self.api_url}/v1/batch/scrape', params_dict, headers)

        if response.status_code == 200:
            try:
                return V1BatchScrapeResponse(**response.json())
            except:
                raise Exception(f'Failed to parse Firecrawl response as JSON.')
        else:
            self._handle_error(response, 'start batch scrape job')
    
    def batch_scrape_urls_and_watch(
        self,
        urls: List[str],
        *,
        formats: Optional[List[Literal["markdown", "html", "rawHtml", "content", "links", "screenshot", "screenshot@fullPage", "extract", "json"]]] = None,
        headers: Optional[Dict[str, str]] = None,
        include_tags: Optional[List[str]] = None,
        exclude_tags: Optional[List[str]] = None,
        only_main_content: Optional[bool] = None,
        wait_for: Optional[int] = None,
        timeout: Optional[int] = 30000,
        location: Optional[V1LocationConfig] = None,
        mobile: Optional[bool] = None,
        skip_tls_verification: Optional[bool] = None,
        remove_base64_images: Optional[bool] = None,
        block_ads: Optional[bool] = None,
        proxy: Optional[Literal["basic", "stealth", "auto"]] = None,
        extract: Optional[V1JsonConfig] = None,
        json_options: Optional[V1JsonConfig] = None,
        actions: Optional[List[Union[V1WaitAction, V1ScreenshotAction, V1ClickAction, V1WriteAction, V1PressAction, V1ScrollAction, V1ScrapeAction, V1ExecuteJavascriptAction, V1PDFAction]]] = None,
        agent: Optional[V1AgentOptions] = None,
        max_concurrency: Optional[int] = None,
        zero_data_retention: Optional[bool] = None,
        idempotency_key: Optional[str] = None,
        **kwargs
    ) -> 'V1CrawlWatcher':
        """
        Initiate a batch scrape job and return a CrawlWatcher to monitor the job via WebSocket.

        Args:
            urls (List[str]): URLs to scrape
            formats (Optional[List[Literal]]): Content formats to retrieve
            headers (Optional[Dict[str, str]]): Custom HTTP headers
            include_tags (Optional[List[str]]): HTML tags to include
            exclude_tags (Optional[List[str]]): HTML tags to exclude
            only_main_content (Optional[bool]): Extract main content only
            wait_for (Optional[int]): Wait time in milliseconds
            timeout (Optional[int]): Request timeout in milliseconds
            location (Optional[LocationConfig]): Location configuration
            mobile (Optional[bool]): Use mobile user agent
            skip_tls_verification (Optional[bool]): Skip TLS verification
            remove_base64_images (Optional[bool]): Remove base64 encoded images
            block_ads (Optional[bool]): Block advertisements
            proxy (Optional[Literal]): Proxy type to use
            extract (Optional[JsonConfig]): Content extraction config
            json_options (Optional[JsonConfig]): JSON extraction config
            actions (Optional[List[Union]]): Actions to perform
            agent (Optional[AgentOptions]): Agent configuration
            max_concurrency (Optional[int]): Maximum number of concurrent scrapes
            zero_data_retention (Optional[bool]): Whether to delete data after 24 hours
            idempotency_key (Optional[str]): Unique key to prevent duplicate requests
            **kwargs: Additional parameters to pass to the API

        Returns:
            V1CrawlWatcher: An instance to monitor the batch scrape job via WebSocket

        Raises:
            Exception: If batch scrape job fails to start
        """
        # Validate any additional kwargs
        self._validate_kwargs(kwargs, "batch_scrape_urls_and_watch")

        scrape_params = {}

        # Add individual parameters
        if formats is not None:
            scrape_params['formats'] = formats
        if headers is not None:
            scrape_params['headers'] = headers
        if include_tags is not None:
            scrape_params['includeTags'] = include_tags
        if exclude_tags is not None:
            scrape_params['excludeTags'] = exclude_tags
        if only_main_content is not None:
            scrape_params['onlyMainContent'] = only_main_content
        if wait_for is not None:
            scrape_params['waitFor'] = wait_for
        if timeout is not None:
            scrape_params['timeout'] = timeout
        if location is not None:
            scrape_params['location'] = location.dict(by_alias=True, exclude_none=True)
        if mobile is not None:
            scrape_params['mobile'] = mobile
        if skip_tls_verification is not None:
            scrape_params['skipTlsVerification'] = skip_tls_verification
        if remove_base64_images is not None:
            scrape_params['removeBase64Images'] = remove_base64_images
        if block_ads is not None:
            scrape_params['blockAds'] = block_ads
        if proxy is not None:
            scrape_params['proxy'] = proxy
        if extract is not None:
            extract = self._ensure_schema_dict(extract)
            if isinstance(extract, dict) and "schema" in extract:
                extract["schema"] = self._ensure_schema_dict(extract["schema"])
            scrape_params['extract'] = extract if isinstance(extract, dict) else extract.dict(by_alias=True, exclude_none=True)
        if json_options is not None:
            json_options = self._ensure_schema_dict(json_options)
            if isinstance(json_options, dict) and "schema" in json_options:
                json_options["schema"] = self._ensure_schema_dict(json_options["schema"])
            scrape_params['jsonOptions'] = json_options if isinstance(json_options, dict) else json_options.dict(by_alias=True, exclude_none=True)
        if actions:
            scrape_params['actions'] = [action if isinstance(action, dict) else action.dict(by_alias=True, exclude_none=True) for action in actions]
        if agent is not None:
            scrape_params['agent'] = agent.dict(by_alias=True, exclude_none=True)
        if max_concurrency is not None:
            scrape_params['maxConcurrency'] = max_concurrency
        if zero_data_retention is not None:
            scrape_params['zeroDataRetention'] = zero_data_retention
        
        # Add any additional kwargs
        scrape_params.update(kwargs)

        # Create final params object
        final_params = V1ScrapeParams(**scrape_params)
        params_dict = final_params.dict(by_alias=True, exclude_none=True)
        params_dict['urls'] = urls
        params_dict['origin'] = f"python-sdk@{version}"

        if 'extract' in params_dict and params_dict['extract'] and 'schema' in params_dict['extract']:
            params_dict['extract']['schema'] = self._ensure_schema_dict(params_dict['extract']['schema'])
        if 'jsonOptions' in params_dict and params_dict['jsonOptions'] and 'schema' in params_dict['jsonOptions']:
            params_dict['jsonOptions']['schema'] = self._ensure_schema_dict(params_dict['jsonOptions']['schema'])

        # Make request
        headers = self._prepare_headers(idempotency_key)
        response = self._post_request(f'{self.api_url}/v1/batch/scrape', params_dict, headers)

        if response.status_code == 200:
            try:
                crawl_response = V1BatchScrapeResponse(**response.json())
                if crawl_response.success and crawl_response.id:
                    return V1CrawlWatcher(crawl_response.id, self)
                else:
                    raise Exception("Batch scrape job failed to start")
            except:
                raise Exception(f'Failed to parse Firecrawl response as JSON.')
        else:
            self._handle_error(response, 'start batch scrape job')
    
    def check_batch_scrape_status(self, id: str) -> V1BatchScrapeStatusResponse:
        """
        Check the status of a batch scrape job using the Firecrawl API.

        Args:
            id (str): The ID of the batch scrape job.

        Returns:
            V1BatchScrapeStatusResponse: The status of the batch scrape job.

        Raises:
            Exception: If the status check request fails.
        """
        endpoint = f'/v1/batch/scrape/{id}'

        headers = self._prepare_headers()
        response = self._get_request(f'{self.api_url}{endpoint}', headers)
        if response.status_code == 200:
            try:
                status_data = response.json()
            except:
                raise Exception(f'Failed to parse Firecrawl response as JSON.')
            if status_data['status'] == 'completed':
                if 'data' in status_data:
                    data = status_data['data']
                    while 'next' in status_data:
                        if len(status_data['data']) == 0:
                            break
                        next_url = status_data.get('next')
                        if not next_url:
                            logger.warning("Expected 'next' URL is missing.")
                            break
                        try:
                            status_response = self._get_request(next_url, headers)
                            if status_response.status_code != 200:
                                logger.error(f"Failed to fetch next page: {status_response.status_code}")
                                break
                            try:
                                next_data = status_response.json()
                            except:
                                raise Exception(f'Failed to parse Firecrawl response as JSON.')
                            data.extend(next_data.get('data', []))
                            status_data = next_data
                        except Exception as e:
                            logger.error(f"Error during pagination request: {e}")
                            break
                    status_data['data'] = data

            return V1BatchScrapeStatusResponse(**{
                'success': False if 'error' in status_data else True,
                'status': status_data.get('status'),
                'total': status_data.get('total'),
                'completed': status_data.get('completed'),
                'creditsUsed': status_data.get('creditsUsed'),
                'expiresAt': status_data.get('expiresAt'),
                'data': status_data.get('data'),
                'next': status_data.get('next'),
                'error': status_data.get('error')
            })
        else:
            self._handle_error(response, 'check batch scrape status')

    def check_batch_scrape_errors(self, id: str) -> V1CrawlErrorsResponse:
        """
        Returns information about batch scrape errors.

        Args:
            id (str): The ID of the crawl job.

        Returns:
            V1CrawlErrorsResponse containing:
            * errors (List[Dict[str, str]]): List of errors with fields:
              * id (str): Error ID
              * timestamp (str): When the error occurred
              * url (str): URL that caused the error
              * error (str): Error message
            * robotsBlocked (List[str]): List of URLs blocked by robots.txt

        Raises:
            Exception: If the error check request fails
        """
        headers = self._prepare_headers()
        response = self._get_request(f'{self.api_url}/v1/batch/scrape/{id}/errors', headers)
        if response.status_code == 200:
            try:
                return V1CrawlErrorsResponse(**response.json())
            except:
                raise Exception(f'Failed to parse Firecrawl response as JSON.')
        else:
            self._handle_error(response, "check batch scrape errors")

    def extract(
            self,
            urls: Optional[List[str]] = None,
            *,
            prompt: Optional[str] = None,
            schema: Optional[Any] = None,
            system_prompt: Optional[str] = None,
            allow_external_links: Optional[bool] = False,
            enable_web_search: Optional[bool] = False,
            show_sources: Optional[bool] = False,
            agent: Optional[Dict[str, Any]] = None,
            **kwargs) -> V1ExtractResponse[Any]:
        """
        Extract structured information from URLs.

        Args:
            urls (Optional[List[str]]): URLs to extract from
            prompt (Optional[str]): Custom extraction prompt
            schema (Optional[Any]): JSON schema/Pydantic model
            system_prompt (Optional[str]): System context
            allow_external_links (Optional[bool]): Follow external links
            enable_web_search (Optional[bool]): Enable web search
            show_sources (Optional[bool]): Include source URLs
            agent (Optional[Dict[str, Any]]): Agent configuration
            **kwargs: Additional parameters to pass to the API

        Returns:
            V1ExtractResponse[Any] with:
            * success (bool): Whether request succeeded
            * data (Optional[Any]): Extracted data matching schema
            * error (Optional[str]): Error message if any

        Raises:
            ValueError: If prompt/schema missing or extraction fails
        """
        # Validate any additional kwargs
        self._validate_kwargs(kwargs, "extract")
        
        headers = self._prepare_headers()

        if not prompt and not schema:
            raise ValueError("Either prompt or schema is required")

        if not urls and not prompt:
            raise ValueError("Either urls or prompt is required")

        if schema:
            schema = self._ensure_schema_dict(schema)

        request_data = {
            'urls': urls or [],
            'allowExternalLinks': allow_external_links,
            'enableWebSearch': enable_web_search,
            'showSources': show_sources,
            'schema': schema,
            'origin': f'python-sdk@{get_version()}'
        }

        # Only add prompt and systemPrompt if they exist
        if prompt:
            request_data['prompt'] = prompt
        if system_prompt:
            request_data['systemPrompt'] = system_prompt
            
        if agent:
            request_data['agent'] = agent

        # Add any additional kwargs
        request_data.update(kwargs)

        try:
            # Send the initial extract request
            response = self._post_request(
                f'{self.api_url}/v1/extract',
                request_data,
                headers
            )
            if response.status_code == 200:
                try:
                    data = response.json()
                except:
                    raise Exception(f'Failed to parse Firecrawl response as JSON.')
                if data['success']:
                    job_id = data.get('id')
                    if not job_id:
                        raise Exception('Job ID not returned from extract request.')

                    # Poll for the extract status
                    while True:
                        status_response = self._get_request(
                            f'{self.api_url}/v1/extract/{job_id}',
                            headers
                        )
                        if status_response.status_code == 200:
                            try:
                                status_data = status_response.json()
                            except:
                                raise Exception(f'Failed to parse Firecrawl response as JSON.')
                            if status_data['status'] == 'completed':
                                return V1ExtractResponse(**status_data)
                            elif status_data['status'] in ['failed', 'cancelled']:
                                raise Exception(f'Extract job {status_data["status"]}. Error: {status_data["error"]}')
                        else:
                            self._handle_error(status_response, "extract-status")

                        time.sleep(2)  # Polling interval
                else:
                    raise Exception(f'Failed to extract. Error: {data["error"]}')
            else:
                self._handle_error(response, "extract")
        except Exception as e:
            raise ValueError(str(e), 500)

        return V1ExtractResponse(success=False, error="Internal server error.")
    
    def get_extract_status(self, job_id: str) -> V1ExtractResponse[Any]:
        """
        Retrieve the status of an extract job.

        Args:
            job_id (str): The ID of the extract job.

        Returns:
            ExtractResponse[Any]: The status of the extract job.

        Raises:
            ValueError: If there is an error retrieving the status.
        """
        headers = self._prepare_headers()
        try:
            response = self._get_request(f'{self.api_url}/v1/extract/{job_id}', headers)
            if response.status_code == 200:
                try:
                    return V1ExtractResponse(**response.json())
                except:
                    raise Exception(f'Failed to parse Firecrawl response as JSON.')
            else:
                self._handle_error(response, "get extract status")
        except Exception as e:
            raise ValueError(str(e), 500)

    def async_extract(
            self,
            urls: Optional[List[str]] = None,
            *,
            prompt: Optional[str] = None,
            schema: Optional[Any] = None,
            system_prompt: Optional[str] = None,
            allow_external_links: Optional[bool] = False,
            enable_web_search: Optional[bool] = False,
            show_sources: Optional[bool] = False,
            agent: Optional[Dict[str, Any]] = None) -> V1ExtractResponse[Any]:
        """
        Initiate an asynchronous extract job.

        Args:
            urls (List[str]): URLs to extract information from
            prompt (Optional[str]): Custom extraction prompt
            schema (Optional[Any]): JSON schema/Pydantic model
            system_prompt (Optional[str]): System context
            allow_external_links (Optional[bool]): Follow external links
            enable_web_search (Optional[bool]): Enable web search
            show_sources (Optional[bool]): Include source URLs
            agent (Optional[Dict[str, Any]]): Agent configuration
            idempotency_key (Optional[str]): Unique key to prevent duplicate requests

        Returns:
            ExtractResponse[Any] with:
            * success (bool): Whether request succeeded
            * data (Optional[Any]): Extracted data matching schema
            * error (Optional[str]): Error message if any

        Raises:
            ValueError: If job initiation fails
        """
        headers = self._prepare_headers()
        
        schema = schema
        if schema:
            schema = self._ensure_schema_dict(schema)

        request_data = {
            'urls': urls,
            'allowExternalLinks': allow_external_links,
            'enableWebSearch': enable_web_search,
            'showSources': show_sources,
            'schema': schema,
            'origin': f'python-sdk@{version}'
        }

        if prompt:
            request_data['prompt'] = prompt
        if system_prompt:
            request_data['systemPrompt'] = system_prompt
        if agent:
            request_data['agent'] = agent

        try:
            response = self._post_request(f'{self.api_url}/v1/extract', request_data, headers)
            if response.status_code == 200:
                try:
                    return V1ExtractResponse(**response.json())
                except:
                    raise Exception(f'Failed to parse Firecrawl response as JSON.')
            else:
                self._handle_error(response, "async extract")
        except Exception as e:
            raise ValueError(str(e), 500)

    def generate_llms_text(
            self,
            url: str,
            *,
            max_urls: Optional[int] = None,
            show_full_text: Optional[bool] = None,
            cache: Optional[bool] = None,
            experimental_stream: Optional[bool] = None) -> V1GenerateLLMsTextStatusResponse:
        """
        Generate LLMs.txt for a given URL and poll until completion.

        Args:
            url (str): Target URL to generate LLMs.txt from
            max_urls (Optional[int]): Maximum URLs to process (default: 10)
            show_full_text (Optional[bool]): Include full text in output (default: False)
            cache (Optional[bool]): Whether to use cached content if available (default: True)
            experimental_stream (Optional[bool]): Enable experimental streaming

        Returns:
            GenerateLLMsTextStatusResponse with:
            * Generated LLMs.txt content
            * Full version if requested
            * Generation status
            * Success/error information

        Raises:
            Exception: If generation fails
        """
        params = V1GenerateLLMsTextParams(
            maxUrls=max_urls,
            showFullText=show_full_text,
            cache=cache,
            __experimental_stream=experimental_stream
        )

        response = self.async_generate_llms_text(
            url,
            max_urls=max_urls,
            show_full_text=show_full_text,
            cache=cache,
            experimental_stream=experimental_stream
        )
        
        if not response.success or not response.id:
            return V1GenerateLLMsTextStatusResponse(
                success=False,
                error='Failed to start LLMs.txt generation',
                status='failed',
                expiresAt=''
            )

        job_id = response.id
        while True:
            status = self.check_generate_llms_text_status(job_id)
            
            if status.status == 'completed':
                return status
            elif status.status == 'failed':
                return status
            elif status.status != 'processing':
                return V1GenerateLLMsTextStatusResponse(
                    success=False,
                    error='LLMs.txt generation job terminated unexpectedly',
                    status='failed',
                    expiresAt=''
                )

            time.sleep(2)  # Polling interval

    def async_generate_llms_text(
            self,
            url: str,
            *,
            max_urls: Optional[int] = None,
            show_full_text: Optional[bool] = None,
            cache: Optional[bool] = None,
            experimental_stream: Optional[bool] = None) -> V1GenerateLLMsTextResponse:
        """
        Initiate an asynchronous LLMs.txt generation operation.

        Args:
            url (str): The target URL to generate LLMs.txt from. Must be a valid HTTP/HTTPS URL.
            max_urls (Optional[int]): Maximum URLs to process (default: 10)
            show_full_text (Optional[bool]): Include full text in output (default: False)
            cache (Optional[bool]): Whether to use cached content if available (default: True)
            experimental_stream (Optional[bool]): Enable experimental streaming

        Returns:
            GenerateLLMsTextResponse: A response containing:
            * success (bool): Whether the generation initiation was successful
            * id (str): The unique identifier for the generation job
            * error (str, optional): Error message if initiation failed

        Raises:
            Exception: If the generation job initiation fails.
        """
        params = V1GenerateLLMsTextParams(
            maxUrls=max_urls,
            showFullText=show_full_text,
            cache=cache,
            __experimental_stream=experimental_stream
        )

        headers = self._prepare_headers()
        json_data = {'url': url, **params.dict(by_alias=True, exclude_none=True)}
        json_data['origin'] = f"python-sdk@{version}"

        try:
            req = self._post_request(f'{self.api_url}/v1/llmstxt', json_data, headers)
            response = req.json()
            print("json_data", json_data)
            print("response", response)
            if response.get('success'):
                try:
                    return V1GenerateLLMsTextResponse(**response)
                except:
                    raise Exception('Failed to parse Firecrawl response as JSON.')
            else:
                self._handle_error(response, 'start LLMs.txt generation')
        except Exception as e:
            raise ValueError(str(e))

        return V1GenerateLLMsTextResponse(
            success=False,
            error='Internal server error'
        )

    def check_generate_llms_text_status(self, id: str) -> V1GenerateLLMsTextStatusResponse:
        """
        Check the status of a LLMs.txt generation operation.

        Args:
            id (str): The unique identifier of the LLMs.txt generation job to check status for.

        Returns:
            GenerateLLMsTextStatusResponse: A response containing:
            * success (bool): Whether the generation was successful
            * status (str): Status of generation ("processing", "completed", "failed")
            * data (Dict[str, str], optional): Generated text with fields:
              * llmstxt (str): Generated LLMs.txt content
              * llmsfulltxt (str, optional): Full version if requested
            * error (str, optional): Error message if generation failed
            * expiresAt (str): When the generated data expires

        Raises:
            Exception: If the status check fails.
        """
        headers = self._prepare_headers()
        try:
            response = self._get_request(f'{self.api_url}/v1/llmstxt/{id}', headers)
            if response.status_code == 200:
                try:
                    json_data = response.json()
                    return V1GenerateLLMsTextStatusResponse(**json_data)
                except Exception as e:
                    raise Exception(f'Failed to parse Firecrawl response as GenerateLLMsTextStatusResponse: {str(e)}')
            elif response.status_code == 404:
                raise Exception('LLMs.txt generation job not found')
            else:
                self._handle_error(response, 'check LLMs.txt generation status')
        except Exception as e:
            raise ValueError(str(e))

        return V1GenerateLLMsTextStatusResponse(success=False, error='Internal server error', status='failed', expiresAt='')

    def _prepare_headers(
            self,
            idempotency_key: Optional[str] = None) -> Dict[str, str]:
        """
        Prepare the headers for API requests.

        Args:
            idempotency_key (Optional[str]): A unique key to ensure idempotency of requests.

        Returns:
            Dict[str, str]: The headers including content type, authorization, and optionally idempotency key.
        """
        if idempotency_key:
            return {
                'Content-Type': 'application/json',
                'Authorization': f'Bearer {self.api_key}',
                'x-idempotency-key': idempotency_key
            }

        return {
            'Content-Type': 'application/json',
            'Authorization': f'Bearer {self.api_key}',
        }

    def _post_request(
            self,
            url: str,
            data: Dict[str, Any],
            headers: Dict[str, str],
            retries: int = 3,
            backoff_factor: float = 0.5) -> requests.Response:
        """
        Make a POST request with retries.

        Args:
            url (str): The URL to send the POST request to.
            data (Dict[str, Any]): The JSON data to include in the POST request.
            headers (Dict[str, str]): The headers to include in the POST request.
            retries (int): Number of retries for the request.
            backoff_factor (float): Backoff factor for retries.

        Returns:
            requests.Response: The response from the POST request.

        Raises:
            requests.RequestException: If the request fails after the specified retries.
        """
        for attempt in range(retries):
            response = requests.post(url, headers=headers, json=data, timeout=((data["timeout"] / 1000.0 + 5) if "timeout" in data and data["timeout"] is not None else None))
            if response.status_code == 502:
                time.sleep(backoff_factor * (2 ** attempt))
            else:
                return response
        return response

    def _get_request(
            self,
            url: str,
            headers: Dict[str, str],
            retries: int = 3,
            backoff_factor: float = 0.5) -> requests.Response:
        """
        Make a GET request with retries.

        Args:
            url (str): The URL to send the GET request to.
            headers (Dict[str, str]): The headers to include in the GET request.
            retries (int): Number of retries for the request.
            backoff_factor (float): Backoff factor for retries.

        Returns:
            requests.Response: The response from the GET request.

        Raises:
            requests.RequestException: If the request fails after the specified retries.
        """
        for attempt in range(retries):
            response = requests.get(url, headers=headers)
            if response.status_code == 502:
                time.sleep(backoff_factor * (2 ** attempt))
            else:
                return response
        return response
    
    def _delete_request(
            self,
            url: str,
            headers: Dict[str, str],
            retries: int = 3,
            backoff_factor: float = 0.5) -> requests.Response:
        """
        Make a DELETE request with retries.

        Args:
            url (str): The URL to send the DELETE request to.
            headers (Dict[str, str]): The headers to include in the DELETE request.
            retries (int): Number of retries for the request.
            backoff_factor (float): Backoff factor for retries.

        Returns:
            requests.Response: The response from the DELETE request.

        Raises:
            requests.RequestException: If the request fails after the specified retries.
        """
        for attempt in range(retries):
            response = requests.delete(url, headers=headers)
            if response.status_code == 502:
                time.sleep(backoff_factor * (2 ** attempt))
            else:
                return response
        return response

    def _monitor_job_status(
            self,
            id: str,
            headers: Dict[str, str],
            poll_interval: int) -> V1CrawlStatusResponse:
        """
        Monitor the status of a crawl job until completion.

        Args:
            id (str): The ID of the crawl job.
            headers (Dict[str, str]): The headers to include in the status check requests.
            poll_interval (int): Seconds between status checks.

        Returns:
            CrawlStatusResponse: The crawl results if the job is completed successfully.

        Raises:
            Exception: If the job fails or an error occurs during status checks.
        """
        while True:
            api_url = f'{self.api_url}/v1/crawl/{id}'

            status_response = self._get_request(api_url, headers)
            if status_response.status_code == 200:
                try:
                    status_data = status_response.json()
                except:
                    raise Exception(f'Failed to parse Firecrawl response as JSON.')
                if status_data['status'] == 'completed':
                    if 'data' in status_data:
                        data = status_data['data']
                        while 'next' in status_data:
                            if len(status_data['data']) == 0:
                                break
                            status_response = self._get_request(status_data['next'], headers)
                            try:
                                status_data = status_response.json()
                            except:
                                raise Exception(f'Failed to parse Firecrawl response as JSON.')
                            data.extend(status_data.get('data', []))
                        status_data['data'] = data
                        return V1CrawlStatusResponse(**status_data)
                    else:
                        raise Exception('Crawl job completed but no data was returned')
                elif status_data['status'] in ['active', 'paused', 'pending', 'queued', 'waiting', 'scraping']:
                    poll_interval=max(poll_interval,2)
                    time.sleep(poll_interval)  # Wait for the specified interval before checking again
                else:
                    raise Exception(f'Crawl job failed or was stopped. Status: {status_data["status"]}')
            else:
                self._handle_error(status_response, 'check crawl status')

    def _handle_error(
            self,
            response: requests.Response,
            action: str) -> None:
        """
        Handle errors from API responses.

        Args:
            response (requests.Response): The response object from the API request.
            action (str): Description of the action that was being performed.

        Raises:
            Exception: An exception with a message containing the status code and error details from the response.
        """
        try:
            response_json = response.json()
            error_message = response_json.get('error', 'No error message provided.')
            error_details = response_json.get('details', 'No additional error details provided.')
        except:
            # If we can't parse JSON, provide a helpful error message with response content
            try:
                response_text = response.text[:500]  # Limit to first 500 chars
                if response_text.strip():
                    error_message = f"Server returned non-JSON response: {response_text}"
                    error_details = f"Full response status: {response.status_code}"
                else:
                    error_message = f"Server returned empty response with status {response.status_code}"
                    error_details = "No additional details available"
            except ValueError:
                error_message = f"Server returned unreadable response with status {response.status_code}"
                error_details = "No additional details available"
        
        message = self._get_error_message(response.status_code, action, error_message, error_details)

        # Raise an HTTPError with the custom message and attach the response
        raise requests.exceptions.HTTPError(message, response=response)

    def _get_error_message(self, status_code: int, action: str, error_message: str, error_details: str) -> str:
        """
        Generate a standardized error message based on HTTP status code.
        
        Args:
            status_code (int): The HTTP status code from the response
            action (str): Description of the action that was being performed
            error_message (str): The error message from the API response
            error_details (str): Additional error details from the API response
            
        Returns:
            str: A formatted error message
        """
        if status_code == 402:
            return f"Payment Required: Failed to {action}. {error_message} - {error_details}"
        elif status_code == 403:
            return f"Website Not Supported: Failed to {action}. {error_message} - {error_details}"
        elif status_code == 408:
            return f"Request Timeout: Failed to {action} as the request timed out. {error_message} - {error_details}"
        elif status_code == 409:
            return f"Conflict: Failed to {action} due to a conflict. {error_message} - {error_details}"
        elif status_code == 500:
            return f"Internal Server Error: Failed to {action}. {error_message} - {error_details}"
        else:
            return f"Unexpected error during {action}: Status code {status_code}. {error_message} - {error_details}"

    def deep_research(
            self,
            query: str,
            *,
            max_depth: Optional[int] = None,
            time_limit: Optional[int] = None,
            max_urls: Optional[int] = None,
            analysis_prompt: Optional[str] = None,
            system_prompt: Optional[str] = None,
            __experimental_stream_steps: Optional[bool] = None,
            on_activity: Optional[Callable[[Dict[str, Any]], None]] = None,
            on_source: Optional[Callable[[Dict[str, Any]], None]] = None) -> V1DeepResearchStatusResponse:
        """
        Initiates a deep research operation on a given query and polls until completion.

        Args:
            query (str): Research query or topic to investigate
            max_depth (Optional[int]): Maximum depth of research exploration
            time_limit (Optional[int]): Time limit in seconds for research
            max_urls (Optional[int]): Maximum number of URLs to process
            analysis_prompt (Optional[str]): Custom prompt for analysis
            system_prompt (Optional[str]): Custom system prompt
            __experimental_stream_steps (Optional[bool]): Enable experimental streaming
            on_activity (Optional[Callable]): Progress callback receiving {type, status, message, timestamp, depth}
            on_source (Optional[Callable]): Source discovery callback receiving {url, title, description}

        Returns:
            DeepResearchStatusResponse containing:
            * success (bool): Whether research completed successfully
            * status (str): Current state (processing/completed/failed)
            * error (Optional[str]): Error message if failed
            * id (str): Unique identifier for the research job
            * data (Any): Research findings and analysis
            * sources (List[Dict]): List of discovered sources
            * activities (List[Dict]): Research progress log
            * summaries (List[str]): Generated research summaries

        Raises:
            Exception: If research fails
        """
        research_params = {}
        if max_depth is not None:
            research_params['maxDepth'] = max_depth
        if time_limit is not None:
            research_params['timeLimit'] = time_limit
        if max_urls is not None:
            research_params['maxUrls'] = max_urls
        if analysis_prompt is not None:
            research_params['analysisPrompt'] = analysis_prompt
        if system_prompt is not None:
            research_params['systemPrompt'] = system_prompt
        if __experimental_stream_steps is not None:
            research_params['__experimental_streamSteps'] = __experimental_stream_steps
        research_params = V1DeepResearchParams(**research_params)

        response = self.async_deep_research(
            query,
            max_depth=max_depth,
            time_limit=time_limit,
            max_urls=max_urls,
            analysis_prompt=analysis_prompt,
            system_prompt=system_prompt
        )
        if not response.get('success') or 'id' not in response:
            return response

        job_id = response['id']
        last_activity_count = 0
        last_source_count = 0

        while True:
            status = self.check_deep_research_status(job_id)
            
            if on_activity and 'activities' in status:
                new_activities = status['activities'][last_activity_count:]
                for activity in new_activities:
                    on_activity(activity)
                last_activity_count = len(status['activities'])
            
            if on_source and 'sources' in status:
                new_sources = status['sources'][last_source_count:]
                for source in new_sources:
                    on_source(source)
                last_source_count = len(status['sources'])
            
            if status['status'] == 'completed':
                return status
            elif status['status'] == 'failed':
                raise Exception(f'Deep research failed. Error: {status.get("error")}')
            elif status['status'] != 'processing':
                break

            time.sleep(2)  # Polling interval

        return {'success': False, 'error': 'Deep research job terminated unexpectedly'}

    def async_deep_research(
            self,
            query: str,
            *,
            max_depth: Optional[int] = None,
            time_limit: Optional[int] = None,
            max_urls: Optional[int] = None,
            analysis_prompt: Optional[str] = None,
            system_prompt: Optional[str] = None,
            __experimental_stream_steps: Optional[bool] = None) -> Dict[str, Any]:
        """
        Initiates an asynchronous deep research operation.

        Args:
            query (str): Research query or topic to investigate
            max_depth (Optional[int]): Maximum depth of research exploration
            time_limit (Optional[int]): Time limit in seconds for research
            max_urls (Optional[int]): Maximum number of URLs to process
            analysis_prompt (Optional[str]): Custom prompt for analysis
            system_prompt (Optional[str]): Custom system prompt
            __experimental_stream_steps (Optional[bool]): Enable experimental streaming

        Returns:
            Dict[str, Any]: A response containing:
            * success (bool): Whether the research initiation was successful
            * id (str): The unique identifier for the research job
            * error (str, optional): Error message if initiation failed

        Raises:
            Exception: If the research initiation fails.
        """
        research_params = {}
        if max_depth is not None:
            research_params['maxDepth'] = max_depth
        if time_limit is not None:
            research_params['timeLimit'] = time_limit
        if max_urls is not None:
            research_params['maxUrls'] = max_urls
        if analysis_prompt is not None:
            research_params['analysisPrompt'] = analysis_prompt
        if system_prompt is not None:
            research_params['systemPrompt'] = system_prompt
        if __experimental_stream_steps is not None:
            research_params['__experimental_streamSteps'] = __experimental_stream_steps
        research_params = V1DeepResearchParams(**research_params)

        headers = self._prepare_headers()
        
        json_data = {'query': query, **research_params.dict(by_alias=True, exclude_none=True)}
        json_data['origin'] = f"python-sdk@{version}"

        # Handle json options schema if present
        if 'jsonOptions' in json_data:
            json_opts = json_data['jsonOptions']
            if json_opts and 'schema' in json_opts and hasattr(json_opts['schema'], 'schema'):
                json_data['jsonOptions']['schema'] = json_opts['schema'].schema()

        try:
            response = self._post_request(f'{self.api_url}/v1/deep-research', json_data, headers)
            if response.status_code == 200:
                try:
                    return response.json()
                except:
                    raise Exception('Failed to parse Firecrawl response as JSON.')
            else:
                self._handle_error(response, 'start deep research')
        except Exception as e:
            raise ValueError(str(e))

        return {'success': False, 'error': 'Internal server error'}

    def check_deep_research_status(self, id: str) -> V1DeepResearchStatusResponse:
        """
        Check the status of a deep research operation.

        Args:
            id (str): The ID of the deep research operation.

        Returns:
            DeepResearchResponse containing:

            Status:
            * success - Whether research completed successfully
            * status - Current state (processing/completed/failed)
            * error - Error message if failed
            
            Results:
            * id - Unique identifier for the research job
            * data - Research findings and analysis
            * sources - List of discovered sources
            * activities - Research progress log
            * summaries - Generated research summaries

        Raises:
            Exception: If the status check fails.
        """
        headers = self._prepare_headers()
        try:
            response = self._get_request(f'{self.api_url}/v1/deep-research/{id}', headers)
            if response.status_code == 200:
                try:
                    return response.json()
                except:
                    raise Exception('Failed to parse Firecrawl response as JSON.')
            elif response.status_code == 404:
                raise Exception('Deep research job not found')
            else:
                self._handle_error(response, 'check deep research status')
        except Exception as e:
            raise ValueError(str(e))

        return {'success': False, 'error': 'Internal server error'}

    def _validate_kwargs(self, kwargs: Dict[str, Any], method_name: str) -> None:
        """
        Validate additional keyword arguments before they are passed to the API.
        This provides early validation before the Pydantic model validation.

        Args:
            kwargs (Dict[str, Any]): Additional keyword arguments to validate
            method_name (str): Name of the method these kwargs are for

        Raises:
            ValueError: If kwargs contain invalid or unsupported parameters
        """
        if not kwargs:
            return

        # Known parameter mappings for each method
        method_params = {
            "scrape_url": {"formats", "include_tags", "exclude_tags", "only_main_content", "wait_for", 
                          "timeout", "location", "mobile", "skip_tls_verification", "remove_base64_images",
                          "block_ads", "proxy", "extract", "json_options", "actions", "change_tracking_options", "max_age", "integration"},
            "search": {"limit", "tbs", "filter", "lang", "country", "location", "timeout", "scrape_options", "integration"},
            "crawl_url": {"include_paths", "exclude_paths", "max_depth", "max_discovery_depth", "limit",
                         "allow_backward_links", "allow_external_links", "ignore_sitemap", "scrape_options",
                         "webhook", "deduplicate_similar_urls", "ignore_query_parameters", "regex_on_full_url", "integration"},
            "map_url": {"search", "ignore_sitemap", "include_subdomains", "sitemap_only", "limit", "timeout", "integration"},
            "extract": {"prompt", "schema", "system_prompt", "allow_external_links", "enable_web_search", "show_sources", "agent", "integration"},
            "batch_scrape_urls": {"formats", "headers", "include_tags", "exclude_tags", "only_main_content",
                                 "wait_for", "timeout", "location", "mobile", "skip_tls_verification",
                                 "remove_base64_images", "block_ads", "proxy", "extract", "json_options",
                                 "actions", "agent", "webhook"},
            "async_batch_scrape_urls": {"formats", "headers", "include_tags", "exclude_tags", "only_main_content",
                                       "wait_for", "timeout", "location", "mobile", "skip_tls_verification",
                                       "remove_base64_images", "block_ads", "proxy", "extract", "json_options",
                                       "actions", "agent", "webhook"},
            "batch_scrape_urls_and_watch": {"formats", "headers", "include_tags", "exclude_tags", "only_main_content",
                                           "wait_for", "timeout", "location", "mobile", "skip_tls_verification",
                                           "remove_base64_images", "block_ads", "proxy", "extract", "json_options",
                                           "actions", "agent", "webhook"}
        }

        # Get allowed parameters for this method
        allowed_params = method_params.get(method_name, set())
        
        # Check for unknown parameters
        unknown_params = set(kwargs.keys()) - allowed_params
        if unknown_params:
            raise ValueError(f"Unsupported parameter(s) for {method_name}: {', '.join(unknown_params)}. Please refer to the API documentation for the correct parameters.")

        # Additional type validation can be added here if needed
        # For now, we rely on Pydantic models for detailed type validation

    def _ensure_schema_dict(self, schema):
        """
        Utility to ensure a schema is a dict, not a Pydantic model class. Recursively checks dicts and lists.
        """
        if schema is None:
            return schema
        if isinstance(schema, type):
            # Pydantic v1/v2 model class
            if hasattr(schema, 'model_json_schema'):
                return schema.model_json_schema()
            elif hasattr(schema, 'schema'):
                return schema.schema()
        if isinstance(schema, dict):
            return {k: self._ensure_schema_dict(v) for k, v in schema.items()}
        if isinstance(schema, (list, tuple)):
            return [self._ensure_schema_dict(v) for v in schema]
        return schema

class V1CrawlWatcher:
    """
    A class to watch and handle crawl job events via WebSocket connection.

    Attributes:
        id (str): The ID of the crawl job to watch
        app (V1FirecrawlApp): The V1FirecrawlApp instance
        data (List[Dict[str, Any]]): List of crawled documents/data
        status (str): Current status of the crawl job
        ws_url (str): WebSocket URL for the crawl job
        event_handlers (dict): Dictionary of event type to list of handler functions
    """
    def __init__(self, id: str, app: V1FirecrawlApp):
        self.id = id
        self.app = app
        self.data: List[Dict[str, Any]] = []
        self.status = "scraping"
        self.ws_url = f"{app.api_url.replace('http', 'ws')}/v1/crawl/{id}"
        self.event_handlers = {
            'done': [],
            'error': [],
            'document': []
        }

    async def connect(self) -> None:
        """
        Establishes WebSocket connection and starts listening for messages.
        """
        async with websockets.connect(
            self.ws_url,
            max_size=None,
            additional_headers=[("Authorization", f"Bearer {self.app.api_key}")]
        ) as websocket:
            await self._listen(websocket)

    async def _listen(self, websocket) -> None:
        """
        Listens for incoming WebSocket messages and handles them.

        Args:
            websocket: The WebSocket connection object
        """
        async for message in websocket:
            msg = json.loads(message)
            await self._handle_message(msg)

    def add_event_listener(self, event_type: str, handler: Callable[[Dict[str, Any]], None]) -> None:
        """
        Adds an event handler function for a specific event type.

        Args:
            event_type (str): Type of event to listen for ('done', 'error', or 'document')
            handler (Callable): Function to handle the event
        """
        if event_type in self.event_handlers:
            self.event_handlers[event_type].append(handler)

    def dispatch_event(self, event_type: str, detail: Dict[str, Any]) -> None:
        """
        Dispatches an event to all registered handlers for that event type.

        Args:
            event_type (str): Type of event to dispatch
            detail (Dict[str, Any]): Event details/data to pass to handlers
        """
        if event_type in self.event_handlers:
            for handler in self.event_handlers[event_type]:
                handler(detail)

    async def _handle_message(self, msg: Dict[str, Any]) -> None:
        """
        Handles incoming WebSocket messages based on their type.

        Args:
            msg (Dict[str, Any]): The message to handle
        """
        if msg['type'] == 'done':
            self.status = 'completed'
            self.dispatch_event('done', {'status': self.status, 'data': self.data, 'id': self.id})
        elif msg['type'] == 'error':
            self.status = 'failed'
            self.dispatch_event('error', {'status': self.status, 'data': self.data, 'error': msg['error'], 'id': self.id})
        elif msg['type'] == 'catchup':
            self.status = msg['data']['status']
            self.data.extend(msg['data'].get('data', []))
            for doc in self.data:
                self.dispatch_event('document', {'data': doc, 'id': self.id})
        elif msg['type'] == 'document':
            self.data.append(msg['data'])
            self.dispatch_event('document', {'data': msg['data'], 'id': self.id})

class AsyncV1FirecrawlApp(V1FirecrawlApp):
    """
    Asynchronous version of V1FirecrawlApp that implements async methods using aiohttp.
    Provides non-blocking alternatives to all V1FirecrawlApp operations.
    """

    def __init__(self, api_key: str, api_url: str = "https://api.firecrawl.dev"):
        # Reuse V1 helpers (_prepare_headers, _validate_kwargs, _ensure_schema_dict, _get_error_message)
        super().__init__(api_key=api_key, api_url=api_url)

    async def _async_request(
            self,
            method: str,
            url: str,
            headers: Dict[str, str],
            data: Optional[Dict[str, Any]] = None,
            retries: int = 3,
            backoff_factor: float = 0.5) -> Dict[str, Any]:
        """
        Generic async request method with exponential backoff retry logic.

        Args:
            method (str): The HTTP method to use (e.g., "GET" or "POST").
            url (str): The URL to send the request to.
            headers (Dict[str, str]): Headers to include in the request.
            data (Optional[Dict[str, Any]]): The JSON data to include in the request body (only for POST requests).
            retries (int): Maximum number of retry attempts (default: 3).
            backoff_factor (float): Factor to calculate delay between retries (default: 0.5).
                Delay will be backoff_factor * (2 ** retry_count).

        Returns:
            Dict[str, Any]: The parsed JSON response from the server.

        Raises:
            aiohttp.ClientError: If the request fails after all retries.
            Exception: If max retries are exceeded or other errors occur.
        """
        async with aiohttp.ClientSession() as session:
            for attempt in range(retries):
                try:
                    async with session.request(
                        method=method, url=url, headers=headers, json=data
                    ) as response:
                        if response.status == 502:
                            await asyncio.sleep(backoff_factor * (2 ** attempt))
                            continue
                        if response.status >= 300:
                            await self._handle_error(response, f"make {method} request")
                        return await response.json()
                except aiohttp.ClientError as e:
                    if attempt == retries - 1:
                        raise e
                    await asyncio.sleep(backoff_factor * (2 ** attempt))
            raise Exception("Max retries exceeded")

    async def _async_post_request(
            self, url: str, data: Dict[str, Any], headers: Dict[str, str],
            retries: int = 3, backoff_factor: float = 0.5) -> Dict[str, Any]:
        """
        Make an async POST request with exponential backoff retry logic.

        Args:
            url (str): The URL to send the POST request to.
            data (Dict[str, Any]): The JSON data to include in the request body.
            headers (Dict[str, str]): Headers to include in the request.
            retries (int): Maximum number of retry attempts (default: 3).
            backoff_factor (float): Factor to calculate delay between retries (default: 0.5).
                Delay will be backoff_factor * (2 ** retry_count).

        Returns:
            Dict[str, Any]: The parsed JSON response from the server.

        Raises:
            aiohttp.ClientError: If the request fails after all retries.
            Exception: If max retries are exceeded or other errors occur.
        """
        return await self._async_request("POST", url, headers, data, retries, backoff_factor)

    async def _async_get_request(
            self, url: str, headers: Dict[str, str],
            retries: int = 3, backoff_factor: float = 0.5) -> Dict[str, Any]:
        """
        Make an async GET request with exponential backoff retry logic.

        Args:
            url (str): The URL to send the GET request to.
            headers (Dict[str, str]): Headers to include in the request.
            retries (int): Maximum number of retry attempts (default: 3).
            backoff_factor (float): Factor to calculate delay between retries (default: 0.5).
                Delay will be backoff_factor * (2 ** retry_count).

        Returns:
            Dict[str, Any]: The parsed JSON response from the server.

        Raises:
            aiohttp.ClientError: If the request fails after all retries.
            Exception: If max retries are exceeded or other errors occur.
        """
        return await self._async_request("GET", url, headers, None, retries, backoff_factor)

    async def _handle_error(self, response: aiohttp.ClientResponse, action: str) -> None:
        """
        Handle errors from async API responses with detailed error messages.

        Args:
            response (aiohttp.ClientResponse): The response object from the failed request
            action (str): Description of the action that was being attempted

        Raises:
            aiohttp.ClientError: With a detailed error message based on the response status:
                - 402: Payment Required
                - 408: Request Timeout
                - 409: Conflict
                - 500: Internal Server Error
                - Other: Unexpected error with status code
        """
        try:
            error_data = await response.json()
            error_message = error_data.get('error', 'No error message provided.')
            error_details = error_data.get('details', 'No additional error details provided.')
        except:
            raise aiohttp.ClientError(f'Failed to parse Firecrawl error response as JSON. Status code: {response.status}')

        message = await self._get_async_error_message(response.status, action, error_message, error_details)

        raise aiohttp.ClientError(message)

    async def _get_async_error_message(self, status_code: int, action: str, error_message: str, error_details: str) -> str:
        """
        Generate a standardized error message based on HTTP status code for async operations.
        
        Args:
            status_code (int): The HTTP status code from the response
            action (str): Description of the action that was being performed
            error_message (str): The error message from the API response
            error_details (str): Additional error details from the API response
            
        Returns:
            str: A formatted error message
        """
        return self._get_error_message(status_code, action, error_message, error_details)

    async def get_credit_usage(self) -> V1CreditUsageResponse:
        """Get current credit usage and billing period (v1, async)."""
        headers = self._prepare_headers()
        resp = await self._async_get_request(
            f"{self.api_url}/v1/team/credit-usage",
            headers
        )
        return V1CreditUsageResponse(**resp)

    async def get_token_usage(self) -> V1TokenUsageResponse:
        """Get current token usage and billing period (v1, async)."""
        headers = self._prepare_headers()
        resp = await self._async_get_request(
            f"{self.api_url}/v1/team/token-usage",
            headers
        )
        return V1TokenUsageResponse(**resp)

    async def crawl_url_and_watch(
            self,
            url: str,
            params: Optional[V1CrawlParams] = None,
            idempotency_key: Optional[str] = None) -> 'AsyncV1CrawlWatcher':
        """
        Initiate an async crawl job and return an AsyncV1CrawlWatcher to monitor progress via WebSocket.

        Args:
          url (str): Target URL to start crawling from
          params (Optional[V1CrawlParams]): See V1CrawlParams model for configuration:
            URL Discovery:
            * includePaths - Patterns of URLs to include
            * excludePaths - Patterns of URLs to exclude
            * maxDepth - Maximum crawl depth
            * maxDiscoveryDepth - Maximum depth for finding new URLs
            * limit - Maximum pages to crawl

            Link Following:
            * allowBackwardLinks - DEPRECATED: Use crawlEntireDomain instead
            * crawlEntireDomain - Follow parent directory links
            * allowExternalLinks - Follow external domain links  
            * ignoreSitemap - Skip sitemap.xml processing

            Advanced:
            * scrapeOptions - Page scraping configuration
            * webhook - Notification webhook settings
            * deduplicateSimilarURLs - Remove similar URLs
            * ignoreQueryParameters - Ignore URL parameters
            * regexOnFullURL - Apply regex to full URLs
          idempotency_key (Optional[str]): Unique key to prevent duplicate requests

        Returns:
          AsyncV1CrawlWatcher: An instance to monitor the crawl job via WebSocket

        Raises:
          Exception: If crawl job fails to start
        """
        crawl_response = await self.async_crawl_url(url, params, idempotency_key)
        if crawl_response.get('success') and 'id' in crawl_response:
            return AsyncV1CrawlWatcher(crawl_response['id'], self)
        else:
            raise Exception("Crawl job failed to start")

    async def batch_scrape_urls_and_watch(
            self,
            urls: List[str],
            params: Optional[V1ScrapeParams] = None,
            idempotency_key: Optional[str] = None) -> 'AsyncV1CrawlWatcher':
        """
        Initiate an async batch scrape job and return an AsyncV1CrawlWatcher to monitor progress.

        Args:
            urls (List[str]): List of URLs to scrape
            params (Optional[V1ScrapeParams]): See V1ScrapeParams model for configuration:

              Content Options:
              * formats - Content formats to retrieve
              * includeTags - HTML tags to include
              * excludeTags - HTML tags to exclude
              * onlyMainContent - Extract main content only
              
              Request Options:
              * headers - Custom HTTP headers
              * timeout - Request timeout (ms)
              * mobile - Use mobile user agent
              * proxy - Proxy type
              
              Extraction Options:
              * extract - Content extraction config
              * jsonOptions - JSON extraction config
              * actions - Actions to perform
            idempotency_key (Optional[str]): Unique key to prevent duplicate requests

        Returns:
            AsyncV1CrawlWatcher: An instance to monitor the batch scrape job via WebSocket

        Raises:
            Exception: If batch scrape job fails to start
        """
        batch_response = await self.async_batch_scrape_urls(urls, params, idempotency_key)
        if batch_response.get('success') and 'id' in batch_response:
            return AsyncV1CrawlWatcher(batch_response['id'], self)
        else:
            raise Exception("Batch scrape job failed to start")

    async def scrape_url(
            self,
            url: str,
            *,
            formats: Optional[List[Literal["markdown", "html", "rawHtml", "content", "links", "screenshot", "screenshot@fullPage", "extract", "json", "changeTracking"]]] = None,
            headers: Optional[Dict[str, str]] = None,
            include_tags: Optional[List[str]] = None,
            exclude_tags: Optional[List[str]] = None,
            only_main_content: Optional[bool] = None,
            wait_for: Optional[int] = None,
            timeout: Optional[int] = 30000,
            location: Optional[V1LocationConfig] = None,
            mobile: Optional[bool] = None,
            skip_tls_verification: Optional[bool] = None,
            remove_base64_images: Optional[bool] = None,
            block_ads: Optional[bool] = None,
            proxy: Optional[Literal["basic", "stealth", "auto"]] = None,
            parse_pdf: Optional[bool] = None,
            extract: Optional[V1JsonConfig] = None,
            json_options: Optional[V1JsonConfig] = None,
            actions: Optional[List[Union[V1WaitAction, V1ScreenshotAction, V1ClickAction, V1WriteAction, V1PressAction, V1ScrollAction, V1ScrapeAction, V1ExecuteJavascriptAction, V1PDFAction]]] = None,
            **kwargs) -> V1ScrapeResponse[Any]:
        """
        Scrape a single URL asynchronously.

        Args:
          url (str): Target URL to scrape
          formats (Optional[List[Literal["markdown", "html", "rawHtml", "content", "links", "screenshot", "screenshot@fullPage", "extract", "json"]]]): Content types to retrieve (markdown/html/etc)
          headers (Optional[Dict[str, str]]): Custom HTTP headers
          include_tags (Optional[List[str]]): HTML tags to include
          exclude_tags (Optional[List[str]]): HTML tags to exclude
          only_main_content (Optional[bool]): Extract main content only
          wait_for (Optional[int]): Wait for a specific element to appear
          timeout (Optional[int]): Request timeout (ms)
          location (Optional[V1LocationConfig]): Location configuration
          mobile (Optional[bool]): Use mobile user agent
          skip_tls_verification (Optional[bool]): Skip TLS verification
          remove_base64_images (Optional[bool]): Remove base64 images
          block_ads (Optional[bool]): Block ads
          proxy (Optional[Literal["basic", "stealth", "auto"]]): Proxy type (basic/stealth)
          extract (Optional[V1JsonConfig]): Content extraction settings
          json_options (Optional[V1JsonConfig]): JSON extraction settings
          actions (Optional[List[Union[V1WaitAction, V1ScreenshotAction, V1ClickAction, V1WriteAction, V1PressAction, V1ScrollAction, V1ScrapeAction, V1ExecuteJavascriptAction, V1PDFAction]]]): Actions to perform
          **kwargs: Additional parameters to pass to the API

        Returns:
            V1ScrapeResponse with:
            * success - Whether scrape was successful
            * markdown - Markdown content if requested
            * html - HTML content if requested
            * rawHtml - Raw HTML content if requested
            * links - Extracted links if requested
            * screenshot - Screenshot if requested
            * extract - Extracted data if requested
            * json - JSON data if requested
            * error - Error message if scrape failed

        Raises:
            Exception: If scraping fails
        """
        # Validate any additional kwargs
        self._validate_kwargs(kwargs, "scrape_url")

        _headers = self._prepare_headers()

        # Build scrape parameters
        scrape_params = {
            'url': url,
            'origin': f"python-sdk@{version}"
        }

        # Add optional parameters if provided and not None
        if formats:
            scrape_params['formats'] = formats
        if headers:
            scrape_params['headers'] = headers
        if include_tags:
            scrape_params['includeTags'] = include_tags
        if exclude_tags:
            scrape_params['excludeTags'] = exclude_tags
        if only_main_content is not None:
            scrape_params['onlyMainContent'] = only_main_content
        if wait_for:
            scrape_params['waitFor'] = wait_for
        if timeout:
            scrape_params['timeout'] = timeout
        if location:
            scrape_params['location'] = location.dict(by_alias=True, exclude_none=True)
        if mobile is not None:
            scrape_params['mobile'] = mobile
        if skip_tls_verification is not None:
            scrape_params['skipTlsVerification'] = skip_tls_verification
        if remove_base64_images is not None:
            scrape_params['removeBase64Images'] = remove_base64_images
        if block_ads is not None:
            scrape_params['blockAds'] = block_ads
        if proxy:
            scrape_params['proxy'] = proxy
        if parse_pdf is not None:
            scrape_params['parsePDF'] = parse_pdf
        if extract is not None:
            extract = self._ensure_schema_dict(extract)
            if isinstance(extract, dict) and "schema" in extract:
                extract["schema"] = self._ensure_schema_dict(extract["schema"])
            scrape_params['extract'] = extract if isinstance(extract, dict) else extract.dict(by_alias=True, exclude_none=True)
        if json_options is not None:
            json_options = self._ensure_schema_dict(json_options)
            if isinstance(json_options, dict) and "schema" in json_options:
                json_options["schema"] = self._ensure_schema_dict(json_options["schema"])
            scrape_params['jsonOptions'] = json_options if isinstance(json_options, dict) else json_options.dict(by_alias=True, exclude_none=True)
        if actions:
            scrape_params['actions'] = [action if isinstance(action, dict) else action.dict(by_alias=True, exclude_none=True) for action in actions]
        if 'extract' in scrape_params and scrape_params['extract'] and 'schema' in scrape_params['extract']:
            scrape_params['extract']['schema'] = self._ensure_schema_dict(scrape_params['extract']['schema'])
        if 'jsonOptions' in scrape_params and scrape_params['jsonOptions'] and 'schema' in scrape_params['jsonOptions']:
            scrape_params['jsonOptions']['schema'] = self._ensure_schema_dict(scrape_params['jsonOptions']['schema'])

        # Make async request
        endpoint = f'/v1/scrape'
        response = await self._async_post_request(
            f'{self.api_url}{endpoint}',
            scrape_params,
            _headers
        )

        if response.get('success') and 'data' in response:
            return V1ScrapeResponse(**response['data'])
        elif "error" in response:
            raise Exception(f'Failed to scrape URL. Error: {response["error"]}')
        else:
            # Use the response content directly if possible, otherwise a generic message
            error_content = response.get('error', str(response))
            raise Exception(f'Failed to scrape URL. Error: {error_content}')

    async def batch_scrape_urls(
        self,
        urls: List[str],
        *,
        formats: Optional[List[Literal["markdown", "html", "rawHtml", "content", "links", "screenshot", "screenshot@fullPage", "extract", "json"]]] = None,
        headers: Optional[Dict[str, str]] = None,
        include_tags: Optional[List[str]] = None,
        exclude_tags: Optional[List[str]] = None,
        only_main_content: Optional[bool] = None,
        wait_for: Optional[int] = None,
        timeout: Optional[int] = 30000,
        location: Optional[V1LocationConfig] = None,
        mobile: Optional[bool] = None,
        skip_tls_verification: Optional[bool] = None,
        remove_base64_images: Optional[bool] = None,
        block_ads: Optional[bool] = None,
        proxy: Optional[Literal["basic", "stealth", "auto"]] = None,
        extract: Optional[V1JsonConfig] = None,
        json_options: Optional[V1JsonConfig] = None,
        actions: Optional[List[Union[V1WaitAction, V1ScreenshotAction, V1ClickAction, V1WriteAction, V1PressAction, V1ScrollAction, V1ScrapeAction, V1ExecuteJavascriptAction, V1PDFAction]]] = None,
        agent: Optional[V1AgentOptions] = None,
        poll_interval: Optional[int] = 2,
        idempotency_key: Optional[str] = None,
        **kwargs
    ) -> V1BatchScrapeStatusResponse:
        """
        Asynchronously scrape multiple URLs and monitor until completion.

        Args:
            urls (List[str]): URLs to scrape
            formats (Optional[List[Literal]]): Content formats to retrieve
            headers (Optional[Dict[str, str]]): Custom HTTP headers
            include_tags (Optional[List[str]]): HTML tags to include
            exclude_tags (Optional[List[str]]): HTML tags to exclude
            only_main_content (Optional[bool]): Extract main content only
            wait_for (Optional[int]): Wait time in milliseconds
            timeout (Optional[int]): Request timeout in milliseconds
            location (Optional[LocationConfig]): Location configuration
            mobile (Optional[bool]): Use mobile user agent
            skip_tls_verification (Optional[bool]): Skip TLS verification
            remove_base64_images (Optional[bool]): Remove base64 encoded images
            block_ads (Optional[bool]): Block advertisements
            proxy (Optional[Literal]): Proxy type to use
            extract (Optional[JsonConfig]): Content extraction config
            json_options (Optional[JsonConfig]): JSON extraction config
            actions (Optional[List[Union]]): Actions to perform
            agent (Optional[AgentOptions]): Agent configuration
            poll_interval (Optional[int]): Seconds between status checks (default: 2)
            idempotency_key (Optional[str]): Unique key to prevent duplicate requests
            **kwargs: Additional parameters to pass to the API

        Returns:
            V1BatchScrapeStatusResponse with:
            * Scraping status and progress
            * Scraped content for each URL
            * Success/error information

        Raises:
            Exception: If batch scrape fails
        """
        # Validate any additional kwargs
        self._validate_kwargs(kwargs, "batch_scrape_urls")

        scrape_params = {}

        # Add individual parameters
        if formats is not None:
            scrape_params['formats'] = formats
        if headers is not None:
            scrape_params['headers'] = headers
        if include_tags is not None:
            scrape_params['includeTags'] = include_tags
        if exclude_tags is not None:
            scrape_params['excludeTags'] = exclude_tags
        if only_main_content is not None:
            scrape_params['onlyMainContent'] = only_main_content
        if wait_for is not None:
            scrape_params['waitFor'] = wait_for
        if timeout is not None:
            scrape_params['timeout'] = timeout
        if location is not None:
            scrape_params['location'] = location.dict(by_alias=True, exclude_none=True)
        if mobile is not None:
            scrape_params['mobile'] = mobile
        if skip_tls_verification is not None:
            scrape_params['skipTlsVerification'] = skip_tls_verification
        if remove_base64_images is not None:
            scrape_params['removeBase64Images'] = remove_base64_images
        if block_ads is not None:
            scrape_params['blockAds'] = block_ads
        if proxy is not None:
            scrape_params['proxy'] = proxy
        if extract is not None:
            extract = self._ensure_schema_dict(extract)
            if isinstance(extract, dict) and "schema" in extract:
                extract["schema"] = self._ensure_schema_dict(extract["schema"])
            scrape_params['extract'] = extract if isinstance(extract, dict) else extract.dict(by_alias=True, exclude_none=True)
        if json_options is not None:
            json_options = self._ensure_schema_dict(json_options)
            if isinstance(json_options, dict) and "schema" in json_options:
                json_options["schema"] = self._ensure_schema_dict(json_options["schema"])
            scrape_params['jsonOptions'] = json_options if isinstance(json_options, dict) else json_options.dict(by_alias=True, exclude_none=True)
        if actions is not None:
            scrape_params['actions'] = [action.dict(by_alias=True, exclude_none=True) for action in actions]
        if agent is not None:
            scrape_params['agent'] = agent.dict(by_alias=True, exclude_none=True)

        # Add any additional kwargs
        scrape_params.update(kwargs)

        # Create final params object
        final_params = V1ScrapeParams(**scrape_params)
        params_dict = final_params.dict(by_alias=True, exclude_none=True)
        params_dict['urls'] = urls
        params_dict['origin'] = f"python-sdk@{version}"

        if 'extract' in params_dict and params_dict['extract'] and 'schema' in params_dict['extract']:
            params_dict['extract']['schema'] = self._ensure_schema_dict(params_dict['extract']['schema'])
        if 'jsonOptions' in params_dict and params_dict['jsonOptions'] and 'schema' in params_dict['jsonOptions']:
            params_dict['jsonOptions']['schema'] = self._ensure_schema_dict(params_dict['jsonOptions']['schema'])

        # Make request
        headers = self._prepare_headers(idempotency_key)
        response = await self._async_post_request(
            f'{self.api_url}/v1/batch/scrape',
            params_dict,
            headers
        )

        if response.get('success'):
            try:
                id = response.get('id')
            except:
                raise Exception(f'Failed to parse Firecrawl response as JSON.')
            return await self._async_monitor_job_status(id, headers, poll_interval)
        else:
            self._handle_error(response, 'start batch scrape job')


    async def async_batch_scrape_urls(
        self,
        urls: List[str],
        *,
        formats: Optional[List[Literal["markdown", "html", "rawHtml", "content", "links", "screenshot", "screenshot@fullPage", "extract", "json"]]] = None,
        headers: Optional[Dict[str, str]] = None,
        include_tags: Optional[List[str]] = None,
        exclude_tags: Optional[List[str]] = None,
        only_main_content: Optional[bool] = None,
        wait_for: Optional[int] = None,
        timeout: Optional[int] = 30000,
        location: Optional[V1LocationConfig] = None,
        mobile: Optional[bool] = None,
        skip_tls_verification: Optional[bool] = None,
        remove_base64_images: Optional[bool] = None,
        block_ads: Optional[bool] = None,
        proxy: Optional[Literal["basic", "stealth", "auto"]] = None,
        extract: Optional[V1JsonConfig] = None,
        json_options: Optional[V1JsonConfig] = None,
        actions: Optional[List[Union[V1WaitAction, V1ScreenshotAction, V1ClickAction, V1WriteAction, V1PressAction, V1ScrollAction, V1ScrapeAction, V1ExecuteJavascriptAction, V1PDFAction]]] = None,
        agent: Optional[V1AgentOptions] = None,
        zero_data_retention: Optional[bool] = None,
        idempotency_key: Optional[str] = None,
        **kwargs
    ) -> V1BatchScrapeResponse:
        """
        Initiate a batch scrape job asynchronously.

        Args:
            urls (List[str]): URLs to scrape
            formats (Optional[List[Literal]]): Content formats to retrieve
            headers (Optional[Dict[str, str]]): Custom HTTP headers
            include_tags (Optional[List[str]]): HTML tags to include
            exclude_tags (Optional[List[str]]): HTML tags to exclude
            only_main_content (Optional[bool]): Extract main content only
            wait_for (Optional[int]): Wait time in milliseconds
            timeout (Optional[int]): Request timeout in milliseconds
            location (Optional[LocationConfig]): Location configuration
            mobile (Optional[bool]): Use mobile user agent
            skip_tls_verification (Optional[bool]): Skip TLS verification
            remove_base64_images (Optional[bool]): Remove base64 encoded images
            block_ads (Optional[bool]): Block advertisements
            proxy (Optional[Literal]): Proxy type to use
            extract (Optional[JsonConfig]): Content extraction config
            json_options (Optional[JsonConfig]): JSON extraction config
            actions (Optional[List[Union]]): Actions to perform
            agent (Optional[AgentOptions]): Agent configuration
            zero_data_retention (Optional[bool]): Whether to delete data after 24 hours
            idempotency_key (Optional[str]): Unique key to prevent duplicate requests
            **kwargs: Additional parameters to pass to the API

        Returns:
            V1BatchScrapeResponse with:
            * success - Whether job started successfully
            * id - Unique identifier for the job
            * url - Status check URL
            * error - Error message if start failed

        Raises:
            Exception: If job initiation fails
        """
        # Validate any additional kwargs
        self._validate_kwargs(kwargs, "async_batch_scrape_urls")

        scrape_params = {}

        # Add individual parameters
        if formats is not None:
            scrape_params['formats'] = formats
        if headers is not None:
            scrape_params['headers'] = headers
        if include_tags is not None:
            scrape_params['includeTags'] = include_tags
        if exclude_tags is not None:
            scrape_params['excludeTags'] = exclude_tags
        if only_main_content is not None:
            scrape_params['onlyMainContent'] = only_main_content
        if wait_for is not None:
            scrape_params['waitFor'] = wait_for
        if timeout is not None:
            scrape_params['timeout'] = timeout
        if location is not None:
            scrape_params['location'] = location.dict(by_alias=True, exclude_none=True)
        if mobile is not None:
            scrape_params['mobile'] = mobile
        if skip_tls_verification is not None:
            scrape_params['skipTlsVerification'] = skip_tls_verification
        if remove_base64_images is not None:
            scrape_params['removeBase64Images'] = remove_base64_images
        if block_ads is not None:
            scrape_params['blockAds'] = block_ads
        if proxy is not None:
            scrape_params['proxy'] = proxy
        if extract is not None:
            extract = self._ensure_schema_dict(extract)
            if isinstance(extract, dict) and "schema" in extract:
                extract["schema"] = self._ensure_schema_dict(extract["schema"])
            scrape_params['extract'] = extract if isinstance(extract, dict) else extract.dict(by_alias=True, exclude_none=True)
        if json_options is not None:
            json_options = self._ensure_schema_dict(json_options)
            if isinstance(json_options, dict) and "schema" in json_options:
                json_options["schema"] = self._ensure_schema_dict(json_options["schema"])
            scrape_params['jsonOptions'] = json_options if isinstance(json_options, dict) else json_options.dict(by_alias=True, exclude_none=True)
        if actions:
            scrape_params['actions'] = [action if isinstance(action, dict) else action.dict(by_alias=True, exclude_none=True) for action in actions]
        if agent is not None:
            scrape_params['agent'] = agent.dict(by_alias=True, exclude_none=True)
        if zero_data_retention is not None:
            scrape_params['zeroDataRetention'] = zero_data_retention
        
        # Add any additional kwargs
        scrape_params.update(kwargs)

        # Create final params object
        final_params = V1ScrapeParams(**scrape_params)
        params_dict = final_params.dict(by_alias=True, exclude_none=True)
        params_dict['urls'] = urls
        params_dict['origin'] = f"python-sdk@{version}"

        if 'extract' in params_dict and params_dict['extract'] and 'schema' in params_dict['extract']:
            params_dict['extract']['schema'] = self._ensure_schema_dict(params_dict['extract']['schema'])
        if 'jsonOptions' in params_dict and params_dict['jsonOptions'] and 'schema' in params_dict['jsonOptions']:
            params_dict['jsonOptions']['schema'] = self._ensure_schema_dict(params_dict['jsonOptions']['schema'])

        # Make request
        headers = self._prepare_headers(idempotency_key)
        response = await self._async_post_request(
            f'{self.api_url}/v1/batch/scrape',
            params_dict,
            headers
        )

        if response.get('status_code') == 200:
            try:
                return V1BatchScrapeResponse(**response.json())
            except:
                raise Exception(f'Failed to parse Firecrawl response as JSON.')
        else:
            await self._handle_error(response, 'start batch scrape job')

    async def crawl_url(
        self,
        url: str,
        *,
        include_paths: Optional[List[str]] = None,
        exclude_paths: Optional[List[str]] = None,
        max_depth: Optional[int] = None,
        max_discovery_depth: Optional[int] = None,
        limit: Optional[int] = None,
        allow_backward_links: Optional[bool] = None,
        crawl_entire_domain: Optional[bool] = None,
        allow_external_links: Optional[bool] = None,
        ignore_sitemap: Optional[bool] = None,
        scrape_options: Optional[V1ScrapeOptions] = None,
        webhook: Optional[Union[str, V1WebhookConfig]] = None,
        deduplicate_similar_urls: Optional[bool] = None,
        ignore_query_parameters: Optional[bool] = None,
        regex_on_full_url: Optional[bool] = None,
        delay: Optional[int] = None,
        allow_subdomains: Optional[bool] = None,
        poll_interval: Optional[int] = 2,
        idempotency_key: Optional[str] = None,
        **kwargs
    ) -> V1CrawlStatusResponse:
        """
        Crawl a website starting from a URL.

        Args:
            url (str): Target URL to start crawling from
            include_paths (Optional[List[str]]): Patterns of URLs to include
            exclude_paths (Optional[List[str]]): Patterns of URLs to exclude
            max_depth (Optional[int]): Maximum crawl depth
            max_discovery_depth (Optional[int]): Maximum depth for finding new URLs
            limit (Optional[int]): Maximum pages to crawl
            allow_backward_links (Optional[bool]): DEPRECATED: Use crawl_entire_domain instead
            crawl_entire_domain (Optional[bool]): Follow parent directory links
            allow_external_links (Optional[bool]): Follow external domain links
            ignore_sitemap (Optional[bool]): Skip sitemap.xml processing
            scrape_options (Optional[V1ScrapeOptions]): Page scraping configuration
            webhook (Optional[Union[str, V1WebhookConfig]]): Notification webhook settings
            deduplicate_similar_urls (Optional[bool]): Remove similar URLs
            ignore_query_parameters (Optional[bool]): Ignore URL parameters
            regex_on_full_url (Optional[bool]): Apply regex to full URLs
            delay (Optional[int]): Delay in seconds between scrapes
            allow_subdomains (Optional[bool]): Follow subdomains
            poll_interval (Optional[int]): Seconds between status checks (default: 2)
            idempotency_key (Optional[str]): Unique key to prevent duplicate requests
            **kwargs: Additional parameters to pass to the API

        Returns:
            V1CrawlStatusResponse with:
            * Crawling status and progress
            * Crawled page contents
            * Success/error information

        Raises:
            Exception: If crawl fails
        """
        # Validate any additional kwargs
        self._validate_kwargs(kwargs, "crawl_url")

        crawl_params = {}

        # Add individual parameters
        if include_paths is not None:
            crawl_params['includePaths'] = include_paths
        if exclude_paths is not None:
            crawl_params['excludePaths'] = exclude_paths
        if max_depth is not None:
            crawl_params['maxDepth'] = max_depth
        if max_discovery_depth is not None:
            crawl_params['maxDiscoveryDepth'] = max_discovery_depth
        if limit is not None:
            crawl_params['limit'] = limit
        if crawl_entire_domain is not None:
            crawl_params['crawlEntireDomain'] = crawl_entire_domain
        elif allow_backward_links is not None:
            crawl_params['allowBackwardLinks'] = allow_backward_links
        if allow_external_links is not None:
            crawl_params['allowExternalLinks'] = allow_external_links
        if ignore_sitemap is not None:
            crawl_params['ignoreSitemap'] = ignore_sitemap
        if scrape_options is not None:
            crawl_params['scrapeOptions'] = scrape_options.dict(by_alias=True, exclude_none=True)
        if webhook is not None:
            crawl_params['webhook'] = webhook
        if deduplicate_similar_urls is not None:
            crawl_params['deduplicateSimilarURLs'] = deduplicate_similar_urls
        if ignore_query_parameters is not None:
            crawl_params['ignoreQueryParameters'] = ignore_query_parameters
        if regex_on_full_url is not None:
            crawl_params['regexOnFullURL'] = regex_on_full_url
        if delay is not None:
            crawl_params['delay'] = delay
        if allow_subdomains is not None:
            crawl_params['allowSubdomains'] = allow_subdomains

        # Add any additional kwargs
        crawl_params.update(kwargs)

        # Create final params object
        final_params = V1CrawlParams(**crawl_params)
        params_dict = final_params.dict(by_alias=True, exclude_none=True)
        params_dict['url'] = url
        params_dict['origin'] = f"python-sdk@{version}"
        # Make request
        headers = self._prepare_headers(idempotency_key)
        response = await self._async_post_request(
          f'{self.api_url}/v1/crawl', params_dict, headers)

        if response.get('success'):
            try:
                id = response.get('id')
            except:
                raise Exception(f'Failed to parse Firecrawl response as JSON.')
            return await self._async_monitor_job_status(id, headers, poll_interval)
        else:
            await self._handle_error(response, 'start crawl job')


    async def async_crawl_url(
       self,
        url: str,
        *,
        include_paths: Optional[List[str]] = None,
        exclude_paths: Optional[List[str]] = None,
        max_depth: Optional[int] = None,
        max_discovery_depth: Optional[int] = None,
        limit: Optional[int] = None,
        allow_backward_links: Optional[bool] = None,
        crawl_entire_domain: Optional[bool] = None,
        allow_external_links: Optional[bool] = None,
        ignore_sitemap: Optional[bool] = None,
        scrape_options: Optional[V1ScrapeOptions] = None,
        webhook: Optional[Union[str, V1WebhookConfig]] = None,
        deduplicate_similar_urls: Optional[bool] = None,
        ignore_query_parameters: Optional[bool] = None,
        regex_on_full_url: Optional[bool] = None,
        delay: Optional[int] = None,
        allow_subdomains: Optional[bool] = None,
        poll_interval: Optional[int] = 2,
        idempotency_key: Optional[str] = None,
        **kwargs
    ) -> V1CrawlResponse:
        """
        Start an asynchronous crawl job.

        Args:
            url (str): Target URL to start crawling from
            include_paths (Optional[List[str]]): Patterns of URLs to include
            exclude_paths (Optional[List[str]]): Patterns of URLs to exclude
            max_depth (Optional[int]): Maximum crawl depth
            max_discovery_depth (Optional[int]): Maximum depth for finding new URLs
            limit (Optional[int]): Maximum pages to crawl
            allow_backward_links (Optional[bool]): DEPRECATED: Use crawl_entire_domain instead
            crawl_entire_domain (Optional[bool]): Follow parent directory links
            allow_external_links (Optional[bool]): Follow external domain links
            ignore_sitemap (Optional[bool]): Skip sitemap.xml processing
            scrape_options (Optional[ScrapeOptions]): Page scraping configuration
            webhook (Optional[Union[str, WebhookConfig]]): Notification webhook settings
            deduplicate_similar_urls (Optional[bool]): Remove similar URLs
            ignore_query_parameters (Optional[bool]): Ignore URL parameters
            regex_on_full_url (Optional[bool]): Apply regex to full URLs
            idempotency_key (Optional[str]): Unique key to prevent duplicate requests
            **kwargs: Additional parameters to pass to the API

        Returns:
            V1CrawlResponse with:
            * success - Whether crawl started successfully
            * id - Unique identifier for the crawl job
            * url - Status check URL for the crawl
            * error - Error message if start failed

        Raises:
            Exception: If crawl initiation fails
        """
        crawl_params = {}

        # Add individual parameters
        if include_paths is not None:
            crawl_params['includePaths'] = include_paths
        if exclude_paths is not None:
            crawl_params['excludePaths'] = exclude_paths
        if max_depth is not None:
            crawl_params['maxDepth'] = max_depth
        if max_discovery_depth is not None:
            crawl_params['maxDiscoveryDepth'] = max_discovery_depth
        if limit is not None:
            crawl_params['limit'] = limit
        if crawl_entire_domain is not None:
            crawl_params['crawlEntireDomain'] = crawl_entire_domain
        elif allow_backward_links is not None:
            crawl_params['allowBackwardLinks'] = allow_backward_links
        if allow_external_links is not None:
            crawl_params['allowExternalLinks'] = allow_external_links
        if ignore_sitemap is not None:
            crawl_params['ignoreSitemap'] = ignore_sitemap
        if scrape_options is not None:
            crawl_params['scrapeOptions'] = scrape_options.dict(by_alias=True, exclude_none=True)
        if webhook is not None:
            crawl_params['webhook'] = webhook
        if deduplicate_similar_urls is not None:
            crawl_params['deduplicateSimilarURLs'] = deduplicate_similar_urls
        if ignore_query_parameters is not None:
            crawl_params['ignoreQueryParameters'] = ignore_query_parameters
        if regex_on_full_url is not None:
            crawl_params['regexOnFullURL'] = regex_on_full_url
        if delay is not None:
            crawl_params['delay'] = delay
        if allow_subdomains is not None:
            crawl_params['allowSubdomains'] = allow_subdomains

        # Add any additional kwargs
        crawl_params.update(kwargs)

        # Create final params object
        final_params = V1CrawlParams(**crawl_params)
        params_dict = final_params.dict(by_alias=True, exclude_none=True)
        params_dict['url'] = url
        params_dict['origin'] = f"python-sdk@{version}"

        # Make request
        headers = self._prepare_headers(idempotency_key)
        response = await self._async_post_request(
          f'{self.api_url}/v1/crawl',
          params_dict,
          headers
        )

        if response.get('success'):
            try:
                return V1CrawlResponse(**response)
            except:
                raise Exception(f'Failed to parse Firecrawl response as JSON.')
        else:
            await self._handle_error(response, 'start crawl job')

    async def check_crawl_status(self, id: str) -> V1CrawlStatusResponse:
        """
        Check the status and results of an asynchronous crawl job.

        Args:
            id (str): Unique identifier for the crawl job

        Returns:
            V1CrawlStatusResponse containing:
            Status Information:
            * status - Current state (scraping/completed/failed/cancelled)
            * completed - Number of pages crawled
            * total - Total pages to crawl
            * creditsUsed - API credits consumed
            * expiresAt - Data expiration timestamp
            
            Results:
            * data - List of crawled documents
            * next - URL for next page of results (if paginated)
            * success - Whether status check succeeded
            * error - Error message if failed

        Raises:
            Exception: If status check fails
        """
        headers = self._prepare_headers()
        endpoint = f'/v1/crawl/{id}'
        
        status_data = await self._async_get_request(
            f'{self.api_url}{endpoint}',
            headers
        )

        if status_data.get('status') == 'completed':
            if 'data' in status_data:
                data = status_data['data']
                while 'next' in status_data:
                    if len(status_data['data']) == 0:
                        break
                    next_url = status_data.get('next')
                    if not next_url:
                        logger.warning("Expected 'next' URL is missing.")
                        break
                    next_data = await self._async_get_request(next_url, headers)
                    data.extend(next_data.get('data', []))
                    status_data = next_data
                status_data['data'] = data
        # Create V1CrawlStatusResponse object from status data
        response = V1CrawlStatusResponse(
            status=status_data.get('status'),
            total=status_data.get('total'),
            completed=status_data.get('completed'),
            creditsUsed=status_data.get('creditsUsed'),
            expiresAt=status_data.get('expiresAt'),
            data=status_data.get('data'),
            success=False if 'error' in status_data else True
        )

        if 'error' in status_data:
            response.error = status_data.get('error')

        if 'next' in status_data:
            response.next = status_data.get('next')

        return response

    async def _async_monitor_job_status(self, id: str, headers: Dict[str, str], poll_interval: int = 2) -> V1CrawlStatusResponse:
        """
        Monitor the status of an asynchronous job until completion.

        Args:
            id (str): The ID of the job to monitor
            headers (Dict[str, str]): Headers to include in status check requests
            poll_interval (int): Seconds between status checks (default: 2)

        Returns:
            V1CrawlStatusResponse: The job results if completed successfully

        Raises:
            Exception: If the job fails or an error occurs during status checks
        """
        while True:
            status_data = await self._async_get_request(
                f'{self.api_url}/v1/crawl/{id}',
                headers
            )

            if status_data.get('status') == 'completed':
                if 'data' in status_data:
                    data = status_data['data']
                    while 'next' in status_data:
                        if len(status_data['data']) == 0:
                            break
                        next_url = status_data.get('next')
                        if not next_url:
                            logger.warning("Expected 'next' URL is missing.")
                            break
                        next_data = await self._async_get_request(next_url, headers)
                        data.extend(next_data.get('data', []))
                        status_data = next_data
                    status_data['data'] = data
                    return V1CrawlStatusResponse(**status_data)
                else:
                    raise Exception('Job completed but no data was returned')
            elif status_data.get('status') in ['active', 'paused', 'pending', 'queued', 'waiting', 'scraping']:
                await asyncio.sleep(max(poll_interval, 2))
            else:
                raise Exception(f'Job failed or was stopped. Status: {status_data["status"]}')

    async def map_url(
        self,
        url: str,
        *,
        search: Optional[str] = None,
        ignore_sitemap: Optional[bool] = None,
        include_subdomains: Optional[bool] = None,
        sitemap_only: Optional[bool] = None,
        limit: Optional[int] = None,
        timeout: Optional[int] = 30000,
        location: Optional[V1LocationConfig] = None,
        params: Optional[V1MapParams] = None) -> V1MapResponse:
        """
        Asynchronously map and discover links from a URL.

        Args:
          url (str): Target URL to map
          params (Optional[V1MapParams]): See V1MapParams model:
            Discovery Options:
            * search - Filter pattern for URLs
            * ignoreSitemap - Skip sitemap.xml
            * includeSubdomains - Include subdomain links
            * sitemapOnly - Only use sitemap.xml
            
            Limits:
            * limit - Max URLs to return
            * timeout - Request timeout (ms)

        Returns:
          V1MapResponse with:
          * Discovered URLs
          * Success/error status

        Raises:
          Exception: If mapping fails
        """
        map_params = {}
        if params:
            map_params.update(params.dict(by_alias=True, exclude_none=True))

        # Add individual parameters
        if search is not None:
            map_params['search'] = search
        if ignore_sitemap is not None:
            map_params['ignoreSitemap'] = ignore_sitemap
        if include_subdomains is not None:
            map_params['includeSubdomains'] = include_subdomains
        if sitemap_only is not None:
            map_params['sitemapOnly'] = sitemap_only
        if limit is not None:
            map_params['limit'] = limit
        if timeout is not None:
            map_params['timeout'] = timeout
        if location is not None:
            map_params['location'] = location.dict(by_alias=True, exclude_none=True)

        # Create final params object
        final_params = V1MapParams(**map_params)
        params_dict = final_params.dict(by_alias=True, exclude_none=True)
        params_dict['url'] = url
        params_dict['origin'] = f"python-sdk@{version}"

        # Make request
        endpoint = f'/v1/map'
        response = await self._async_post_request(
            f'{self.api_url}{endpoint}',
            params_dict,
            headers={"Authorization": f"Bearer {self.api_key}"}
        )

        if response.get('success') and 'links' in response:
            return V1MapResponse(**response)
        elif 'error' in response:
            raise Exception(f'Failed to map URL. Error: {response["error"]}')
        else:
            raise Exception(f'Failed to map URL. Error: {response}')

    async def extract(
            self,
            urls: Optional[List[str]] = None,
            *,
            prompt: Optional[str] = None,
            schema: Optional[Any] = None,
            system_prompt: Optional[str] = None,
            allow_external_links: Optional[bool] = False,
            enable_web_search: Optional[bool] = False,
            show_sources: Optional[bool] = False,
            agent: Optional[Dict[str, Any]] = None) -> V1ExtractResponse[Any]:
            
        """
        Asynchronously extract structured information from URLs.

        Args:
            urls (Optional[List[str]]): URLs to extract from
            prompt (Optional[str]): Custom extraction prompt
            schema (Optional[Any]): JSON schema/Pydantic model
            system_prompt (Optional[str]): System context
            allow_external_links (Optional[bool]): Follow external links
            enable_web_search (Optional[bool]): Enable web search
            show_sources (Optional[bool]): Include source URLs
            agent (Optional[Dict[str, Any]]): Agent configuration

        Returns:
          V1ExtractResponse with:
          * Structured data matching schema
          * Source information if requested
          * Success/error status

        Raises:
          ValueError: If prompt/schema missing or extraction fails
        """
        headers = self._prepare_headers()

        if not prompt and not schema:
            raise ValueError("Either prompt or schema is required")

        if not urls and not prompt:
            raise ValueError("Either urls or prompt is required")

        if schema:
            schema = self._ensure_schema_dict(schema)

        request_data = {
            'urls': urls or [],
            'allowExternalLinks': allow_external_links,
            'enableWebSearch': enable_web_search,
            'showSources': show_sources,
            'schema': schema,
            'origin': f'python-sdk@{get_version()}'
        }

        # Only add prompt and systemPrompt if they exist
        if prompt:
            request_data['prompt'] = prompt
        if system_prompt:
            request_data['systemPrompt'] = system_prompt
            
        if agent:
            request_data['agent'] = agent

        response = await self._async_post_request(
            f'{self.api_url}/v1/extract',
            request_data,
            headers
        )

        if response.get('success'):
            job_id = response.get('id')
            if not job_id:
                raise Exception('Job ID not returned from extract request.')

            while True:
                status_data = await self._async_get_request(
                    f'{self.api_url}/v1/extract/{job_id}',
                    headers
                )

                if status_data['status'] == 'completed':
                    return V1ExtractResponse(**status_data)
                elif status_data['status'] in ['failed', 'cancelled']:
                    raise Exception(f'Extract job {status_data["status"]}. Error: {status_data["error"]}')

                await asyncio.sleep(2)
        else:
            raise Exception(f'Failed to extract. Error: {response.get("error")}')

    async def check_batch_scrape_status(self, id: str) -> V1BatchScrapeStatusResponse:
        """
        Check the status of an asynchronous batch scrape job.

        Args:
            id (str): The ID of the batch scrape job

        Returns:
            V1BatchScrapeStatusResponse containing:
            Status Information:
            * status - Current state (scraping/completed/failed/cancelled)
            * completed - Number of URLs scraped
            * total - Total URLs to scrape
            * creditsUsed - API credits consumed
            * expiresAt - Data expiration timestamp
            
            Results:
            * data - List of scraped documents
            * next - URL for next page of results (if paginated)
            * success - Whether status check succeeded
            * error - Error message if failed

        Raises:
            Exception: If status check fails
        """
        headers = self._prepare_headers()
        endpoint = f'/v1/batch/scrape/{id}'

        status_data = await self._async_get_request(
            f'{self.api_url}{endpoint}',
            headers
        )

        if status_data['status'] == 'completed':
            if 'data' in status_data:
                data = status_data['data']
                while 'next' in status_data:
                    if len(status_data['data']) == 0:
                        break
                    next_url = status_data.get('next')
                    if not next_url:
                        logger.warning("Expected 'next' URL is missing.")
                        break
                    next_data = await self._async_get_request(next_url, headers)
                    data.extend(next_data.get('data', []))
                    status_data = next_data
                status_data['data'] = data

        response = V1BatchScrapeStatusResponse(
            status=status_data.get('status'),
            total=status_data.get('total'),
            completed=status_data.get('completed'),
            creditsUsed=status_data.get('creditsUsed'),
            expiresAt=status_data.get('expiresAt'),
            data=status_data.get('data')
        )

        if 'error' in status_data:
            response['error'] = status_data['error']

        if 'next' in status_data:
            response['next'] = status_data['next']

        return {
            'success': False if 'error' in status_data else True,
            **response
        }

    async def check_batch_scrape_errors(self, id: str) -> V1CrawlErrorsResponse:
        """
        Get information about errors from an asynchronous batch scrape job.

        Args:
          id (str): The ID of the batch scrape job

        Returns:
          V1CrawlErrorsResponse containing:
            errors (List[Dict[str, str]]): List of errors with fields:
              * id (str): Error ID
              * timestamp (str): When the error occurred
              * url (str): URL that caused the error
              * error (str): Error message
          * robotsBlocked (List[str]): List of URLs blocked by robots.txt

        Raises:
          Exception: If error check fails
        """
        headers = self._prepare_headers()
        return await self._async_get_request(
            f'{self.api_url}/v1/batch/scrape/{id}/errors',
            headers
        )

    async def check_crawl_errors(self, id: str) -> V1CrawlErrorsResponse:
        """
        Get information about errors from an asynchronous crawl job.

        Args:
            id (str): The ID of the crawl job

        Returns:
            V1CrawlErrorsResponse containing:
            * errors (List[Dict[str, str]]): List of errors with fields:
                - id (str): Error ID
                - timestamp (str): When the error occurred
                - url (str): URL that caused the error
                - error (str): Error message
            * robotsBlocked (List[str]): List of URLs blocked by robots.txt

        Raises:
            Exception: If error check fails
        """
        headers = self._prepare_headers()
        return await self._async_get_request(
            f'{self.api_url}/v1/crawl/{id}/errors',
            headers
        )

    async def cancel_crawl(self, id: str) -> Dict[str, Any]:
        """
        Cancel an asynchronous crawl job.

        Args:
            id (str): The ID of the crawl job to cancel

        Returns:
            Dict[str, Any] containing:
            * success (bool): Whether cancellation was successful
            * error (str, optional): Error message if cancellation failed

        Raises:
            Exception: If cancellation fails
        """
        headers = self._prepare_headers()
        async with aiohttp.ClientSession() as session:
            async with session.delete(f'{self.api_url}/v1/crawl/{id}', headers=headers) as response:
                return await response.json()

    async def get_extract_status(self, job_id: str) -> V1ExtractResponse[Any]:
        """
        Check the status of an asynchronous extraction job.

        Args:
            job_id (str): The ID of the extraction job

        Returns:
            V1ExtractResponse[Any] with:
            * success (bool): Whether request succeeded
            * data (Optional[Any]): Extracted data matching schema
            * error (Optional[str]): Error message if any
            * warning (Optional[str]): Warning message if any
            * sources (Optional[List[str]]): Source URLs if requested

        Raises:
            ValueError: If status check fails
        """
        headers = self._prepare_headers()
        try:
            return await self._async_get_request(
                f'{self.api_url}/v1/extract/{job_id}',
                headers
            )
        except Exception as e:
            raise ValueError(str(e))

    async def async_extract(
            self,
            urls: Optional[List[str]] = None,
            *,
            prompt: Optional[str] = None,
            schema: Optional[Any] = None,
            system_prompt: Optional[str] = None,
            allow_external_links: Optional[bool] = False,
            enable_web_search: Optional[bool] = False,
            show_sources: Optional[bool] = False,
            agent: Optional[Dict[str, Any]] = None) -> V1ExtractResponse[Any]:
        """
        Initiate an asynchronous extraction job without waiting for completion.

        Args:
            urls (Optional[List[str]]): URLs to extract from
            prompt (Optional[str]): Custom extraction prompt
            schema (Optional[Any]): JSON schema/Pydantic model
            system_prompt (Optional[str]): System context
            allow_external_links (Optional[bool]): Follow external links
            enable_web_search (Optional[bool]): Enable web search
            show_sources (Optional[bool]): Include source URLs
            agent (Optional[Dict[str, Any]]): Agent configuration
            idempotency_key (Optional[str]): Unique key to prevent duplicate requests

        Returns:
            V1ExtractResponse[Any] with:
            * success (bool): Whether request succeeded
            * data (Optional[Any]): Extracted data matching schema
            * error (Optional[str]): Error message if any

        Raises:
            ValueError: If job initiation fails
        """
        headers = self._prepare_headers()

        if not prompt and not schema:
            raise ValueError("Either prompt or schema is required")

        if not urls and not prompt:
            raise ValueError("Either urls or prompt is required")

        if schema:
            schema = self._ensure_schema_dict(schema)

        request_data = V1ExtractResponse(
            urls=urls or [],
            allowExternalLinks=allow_external_links,
            enableWebSearch=enable_web_search,
            showSources=show_sources,
            schema=schema,
            origin=f'python-sdk@{version}'
        )

        if prompt:
            request_data['prompt'] = prompt
        if system_prompt:
            request_data['systemPrompt'] = system_prompt
        if agent:
            request_data['agent'] = agent

        try:
            return await self._async_post_request(
                f'{self.api_url}/v1/extract',
                request_data,
                headers
            )
        except Exception as e:
            raise ValueError(str(e))

    async def generate_llms_text(
            self,
            url: str,
            *,
            max_urls: Optional[int] = None,
            show_full_text: Optional[bool] = None,
            experimental_stream: Optional[bool] = None) -> V1GenerateLLMsTextStatusResponse:
        """
        Generate LLMs.txt for a given URL and monitor until completion.

        Args:
            url (str): Target URL to generate LLMs.txt from
            max_urls (Optional[int]): Maximum URLs to process (default: 10)
            show_full_text (Optional[bool]): Include full text in output (default: False)
            experimental_stream (Optional[bool]): Enable experimental streaming

        Returns:
            V1GenerateLLMsTextStatusResponse containing:
            * success (bool): Whether generation completed successfully
            * status (str): Status of generation (processing/completed/failed)
            * data (Dict[str, str], optional): Generated text with fields:
                - llmstxt (str): Generated LLMs.txt content
                - llmsfulltxt (str, optional): Full version if requested
            * error (str, optional): Error message if generation failed
            * expiresAt (str): When the generated data expires

        Raises:
            Exception: If generation fails
        """
        params = {}
        if max_urls is not None:
            params['maxUrls'] = max_urls
        if show_full_text is not None:
            params['showFullText'] = show_full_text
        if experimental_stream is not None:
            params['__experimental_stream'] = experimental_stream

        response = await self.async_generate_llms_text(
            url,
            max_urls=max_urls,
            show_full_text=show_full_text,
            experimental_stream=experimental_stream
        )
        if not response.get('success') or 'id' not in response:
            return response

        job_id = response['id']
        while True:
            status = await self.check_generate_llms_text_status(job_id)
            
            if status['status'] == 'completed':
                return status
            elif status['status'] == 'failed':
                raise Exception(f'LLMs.txt generation failed. Error: {status.get("error")}')
            elif status['status'] != 'processing':
                break

            await asyncio.sleep(2)

        return V1GenerateLLMsTextStatusResponse(success=False, error='LLMs.txt generation job terminated unexpectedly', status='failed', expiresAt='')

    async def async_generate_llms_text(
            self,
            url: str,
            *,
            max_urls: Optional[int] = None,
            show_full_text: Optional[bool] = None,
            cache: Optional[bool] = None,
            experimental_stream: Optional[bool] = None) -> V1GenerateLLMsTextResponse:
        """
        Initiate an asynchronous LLMs.txt generation job without waiting for completion.

        Args:
            url (str): Target URL to generate LLMs.txt from
            max_urls (Optional[int]): Maximum URLs to process (default: 10)
            show_full_text (Optional[bool]): Include full text in output (default: False)
            cache (Optional[bool]): Whether to use cached content if available (default: True)
            experimental_stream (Optional[bool]): Enable experimental streaming

        Returns:
            V1GenerateLLMsTextResponse containing:
            * success (bool): Whether job started successfully
            * id (str): Unique identifier for the job
            * error (str, optional): Error message if start failed

        Raises:
            ValueError: If job initiation fails
        """
        params = {}
        if max_urls is not None:
            params['maxUrls'] = max_urls
        if show_full_text is not None:
            params['showFullText'] = show_full_text
        if experimental_stream is not None:
            params['__experimental_stream'] = experimental_stream

        params = V1GenerateLLMsTextParams(
            maxUrls=max_urls,
            showFullText=show_full_text,
            cache=cache,
            __experimental_stream=experimental_stream
        )

        headers = self._prepare_headers()
        json_data = {'url': url, **params.dict(by_alias=True, exclude_none=True)}
        json_data['origin'] = f"python-sdk@{version}"

        try:
            return await self._async_post_request(
                f'{self.api_url}/v1/llmstxt',
                json_data,
                headers
            )
        except Exception as e:
            raise ValueError(str(e))

    async def check_generate_llms_text_status(self, id: str) -> V1GenerateLLMsTextStatusResponse:
        """
        Check the status of an asynchronous LLMs.txt generation job.

        Args:
            id (str): The ID of the generation job

        Returns:
            V1GenerateLLMsTextStatusResponse containing:
            * success (bool): Whether generation completed successfully
            * status (str): Status of generation (processing/completed/failed)
            * data (Dict[str, str], optional): Generated text with fields:
                - llmstxt (str): Generated LLMs.txt content
                - llmsfulltxt (str, optional): Full version if requested
            * error (str, optional): Error message if generation failed
            * expiresAt (str): When the generated data expires

        Raises:
            ValueError: If status check fails
        """
        headers = self._prepare_headers()
        try:
            return await self._async_get_request(
                f'{self.api_url}/v1/llmstxt/{id}',
                headers
            )
        except Exception as e:
            raise ValueError(str(e))

    async def deep_research(
            self,
            query: str,
            *,
            max_depth: Optional[int] = None,
            time_limit: Optional[int] = None,
            max_urls: Optional[int] = None,
            analysis_prompt: Optional[str] = None,
            system_prompt: Optional[str] = None,
            __experimental_stream_steps: Optional[bool] = None,
            on_activity: Optional[Callable[[Dict[str, Any]], None]] = None,
            on_source: Optional[Callable[[Dict[str, Any]], None]] = None) -> V1DeepResearchStatusResponse:
        """
        Initiates a deep research operation on a given query and polls until completion.

        Args:
            query (str): Research query or topic to investigate
            max_depth (Optional[int]): Maximum depth of research exploration
            time_limit (Optional[int]): Time limit in seconds for research
            max_urls (Optional[int]): Maximum number of URLs to process
            analysis_prompt (Optional[str]): Custom prompt for analysis
            system_prompt (Optional[str]): Custom system prompt
            __experimental_stream_steps (Optional[bool]): Enable experimental streaming
            on_activity (Optional[Callable]): Progress callback receiving {type, status, message, timestamp, depth}
            on_source (Optional[Callable]): Source discovery callback receiving {url, title, description}

        Returns:
            DeepResearchStatusResponse containing:
            * success (bool): Whether research completed successfully
            * status (str): Current state (processing/completed/failed)
            * error (Optional[str]): Error message if failed
            * id (str): Unique identifier for the research job
            * data (Any): Research findings and analysis
            * sources (List[Dict]): List of discovered sources
            * activities (List[Dict]): Research progress log
            * summaries (List[str]): Generated research summaries

        Raises:
            Exception: If research fails
        """
        research_params = {}
        if max_depth is not None:
            research_params['maxDepth'] = max_depth
        if time_limit is not None:
            research_params['timeLimit'] = time_limit
        if max_urls is not None:
            research_params['maxUrls'] = max_urls
        if analysis_prompt is not None:
            research_params['analysisPrompt'] = analysis_prompt
        if system_prompt is not None:
            research_params['systemPrompt'] = system_prompt
        if __experimental_stream_steps is not None:
            research_params['__experimental_streamSteps'] = __experimental_stream_steps
        research_params = V1DeepResearchParams(**research_params)

        response = await self.async_deep_research(
            query,
            max_depth=max_depth,
            time_limit=time_limit,
            max_urls=max_urls,
            analysis_prompt=analysis_prompt,
            system_prompt=system_prompt
        )
        if not response.get('success') or 'id' not in response:
            return response

        job_id = response['id']
        last_activity_count = 0
        last_source_count = 0

        while True:
            status = await self.check_deep_research_status(job_id)
            
            if on_activity and 'activities' in status:
                new_activities = status['activities'][last_activity_count:]
                for activity in new_activities:
                    on_activity(activity)
                last_activity_count = len(status['activities'])
            
            if on_source and 'sources' in status:
                new_sources = status['sources'][last_source_count:]
                for source in new_sources:
                    on_source(source)
                last_source_count = len(status['sources'])
            
            if status['status'] == 'completed':
                return status
            elif status['status'] == 'failed':
                raise Exception(f'Deep research failed. Error: {status.get("error")}')
            elif status['status'] != 'processing':
                break

            await asyncio.sleep(2)

        return V1DeepResearchStatusResponse(success=False, error='Deep research job terminated unexpectedly')

    async def async_deep_research(
            self,
            query: str,
            *,
            max_depth: Optional[int] = None,
            time_limit: Optional[int] = None,
            max_urls: Optional[int] = None,
            analysis_prompt: Optional[str] = None,
            system_prompt: Optional[str] = None,
            __experimental_stream_steps: Optional[bool] = None) -> Dict[str, Any]:
        """
        Initiates an asynchronous deep research operation.

        Args:
            query (str): Research query or topic to investigate
            max_depth (Optional[int]): Maximum depth of research exploration
            time_limit (Optional[int]): Time limit in seconds for research
            max_urls (Optional[int]): Maximum number of URLs to process
            analysis_prompt (Optional[str]): Custom prompt for analysis
            system_prompt (Optional[str]): Custom system prompt
            __experimental_stream_steps (Optional[bool]): Enable experimental streaming

        Returns:
            Dict[str, Any]: A response containing:
            * success (bool): Whether the research initiation was successful
            * id (str): The unique identifier for the research job
            * error (str, optional): Error message if initiation failed

        Raises:
            Exception: If the research initiation fails.
        """
        research_params = {}
        if max_depth is not None:
            research_params['maxDepth'] = max_depth
        if time_limit is not None:
            research_params['timeLimit'] = time_limit
        if max_urls is not None:
            research_params['maxUrls'] = max_urls
        if analysis_prompt is not None:
            research_params['analysisPrompt'] = analysis_prompt
        if system_prompt is not None:
            research_params['systemPrompt'] = system_prompt
        if __experimental_stream_steps is not None:
            research_params['__experimental_streamSteps'] = __experimental_stream_steps
        research_params = V1DeepResearchParams(**research_params)

        headers = self._prepare_headers()
        
        json_data = {'query': query, **research_params.dict(by_alias=True, exclude_none=True)}
        json_data['origin'] = f"python-sdk@{version}"

        try:
            return await self._async_post_request(
                f'{self.api_url}/v1/deep-research',
                json_data,
                headers
            )
        except Exception as e:
            raise ValueError(str(e))

    async def check_deep_research_status(self, id: str) -> V1DeepResearchStatusResponse:
        """
        Check the status of a deep research operation.

        Args:
            id (str): The ID of the deep research operation.

        Returns:
            DeepResearchResponse containing:

            Status:
            * success - Whether research completed successfully
            * status - Current state (processing/completed/failed)
            * error - Error message if failed
            
            Results:
            * id - Unique identifier for the research job
            * data - Research findings and analysis
            * sources - List of discovered sources
            * activities - Research progress log
            * summaries - Generated research summaries

        Raises:
            Exception: If the status check fails.
        """
        headers = self._prepare_headers()
        try:
            return await self._async_get_request(
                f'{self.api_url}/v1/deep-research/{id}',
                headers
            )
        except Exception as e:
            raise ValueError(str(e))

    async def search(
            self,
            query: str,
            *,
            limit: Optional[int] = None,
            tbs: Optional[str] = None,
            filter: Optional[str] = None,
            lang: Optional[str] = None,
            country: Optional[str] = None,
            location: Optional[str] = None,
            timeout: Optional[int] = 30000,
            scrape_options: Optional[V1ScrapeOptions] = None,
            params: Optional[Union[Dict[str, Any], V1SearchParams]] = None,
            **kwargs) -> V1SearchResponse:
        """
        Asynchronously search for content using Firecrawl.

        Args:
            query (str): Search query string
            limit (Optional[int]): Max results (default: 5)
            tbs (Optional[str]): Time filter (e.g. "qdr:d")
            filter (Optional[str]): Custom result filter
            lang (Optional[str]): Language code (default: "en")
            country (Optional[str]): Country code (default: "us") 
            location (Optional[str]): Geo-targeting
            timeout (Optional[int]): Request timeout in milliseconds
            scrape_options (Optional[ScrapeOptions]): Result scraping configuration
            params (Optional[Union[Dict[str, Any], SearchParams]]): Additional search parameters
            **kwargs: Additional keyword arguments for future compatibility

        Returns:
            SearchResponse: Response containing:
                * success (bool): Whether request succeeded
                * data (List[FirecrawlDocument]): Search results
                * warning (Optional[str]): Warning message if any
                * error (Optional[str]): Error message if any

        Raises:
            Exception: If search fails or response cannot be parsed
        """
        # Build search parameters
        search_params = {}
        if params:
            if isinstance(params, dict):
                search_params.update(params)
            else:
                search_params.update(params.dict(by_alias=True, exclude_none=True))

        # Add individual parameters
        if limit is not None:
            search_params['limit'] = limit
        if tbs is not None:
            search_params['tbs'] = tbs
        if filter is not None:
            search_params['filter'] = filter
        if lang is not None:
            search_params['lang'] = lang
        if country is not None:
            search_params['country'] = country
        if location is not None:
            search_params['location'] = location
        if timeout is not None:
            search_params['timeout'] = timeout
        if scrape_options is not None:
            search_params['scrapeOptions'] = scrape_options.dict(by_alias=True, exclude_none=True)
        
        # Add any additional kwargs
        search_params.update(kwargs)

        # Create final params object
        final_params = V1SearchParams(query=query, **search_params)
        params_dict = final_params.dict(by_alias=True, exclude_none=True)
        params_dict['origin'] = f"python-sdk@{version}"

        return await self._async_post_request(
            f"{self.api_url}/v1/search",
            params_dict,
            {"Authorization": f"Bearer {self.api_key}"}
        )

class AsyncV1CrawlWatcher(V1CrawlWatcher):
    """
    Async version of V1CrawlWatcher that properly handles async operations.
    """
    def __init__(self, id: str, app: AsyncV1FirecrawlApp):
        super().__init__(id, app)

    async def connect(self) -> None:
        """
        Establishes async WebSocket connection and starts listening for messages.
        """
        async with websockets.connect(
            self.ws_url,
            additional_headers=[("Authorization", f"Bearer {self.app.api_key}")]
        ) as websocket:
            await self._listen(websocket)

    async def _listen(self, websocket) -> None:
        """
        Listens for incoming WebSocket messages and handles them asynchronously.

        Args:
            websocket: The WebSocket connection object
        """
        async for message in websocket:
            msg = json.loads(message)
            await self._handle_message(msg)

    async def _handle_message(self, msg: Dict[str, Any]) -> None:
        """
        Handles incoming WebSocket messages based on their type asynchronously.

        Args:
            msg (Dict[str, Any]): The message to handle
        """
        if msg['type'] == 'done':
            self.status = 'completed'
            self.dispatch_event('done', {'status': self.status, 'data': self.data, 'id': self.id})
        elif msg['type'] == 'error':
            self.status = 'failed'
            self.dispatch_event('error', {'status': self.status, 'data': self.data, 'error': msg['error'], 'id': self.id})
        elif msg['type'] == 'catchup':
            self.status = msg['data']['status']
            self.data.extend(msg['data'].get('data', []))
            for doc in self.data:
                self.dispatch_event('document', {'data': doc, 'id': self.id})
        elif msg['type'] == 'document':
            self.data.append(msg['data'])
            self.dispatch_event('document', {'data': msg['data'], 'id': self.id})

    async def _handle_error(self, response: aiohttp.ClientResponse, action: str) -> None:
        """
        Handle errors from async API responses.
        """
        try:
            error_data = await response.json()
            error_message = error_data.get('error', 'No error message provided.')
            error_details = error_data.get('details', 'No additional error details provided.')
        except:
            raise aiohttp.ClientError(f'Failed to parse Firecrawl error response as JSON. Status code: {response.status}')

        # Use the app's method to get the error message
        message = await self.app._get_async_error_message(response.status, action, error_message, error_details)

        raise aiohttp.ClientError(message)

    async def _get_async_error_message(self, status_code: int, action: str, error_message: str, error_details: str) -> str:
        """
        Generate a standardized error message based on HTTP status code for async operations.
        
        Args:
            status_code (int): The HTTP status code from the response
            action (str): Description of the action that was being performed
            error_message (str): The error message from the API response
            error_details (str): Additional error details from the API response
            
        Returns:
            str: A formatted error message
        """
        return self._get_error_message(status_code, action, error_message, error_details)
