"""
Type definitions for Firecrawl v2 API.

This module contains clean, modern type definitions for the v2 API.
"""

import warnings
from datetime import datetime
from typing import Any, Dict, Generic, List, Literal, Optional, TypeVar, Union
import logging
from pydantic import BaseModel, Field, field_validator, ValidationError

# Suppress pydantic warnings about schema field shadowing
# Tested using schema_field alias="schema" but it doesn't work.
warnings.filterwarnings("ignore", message="Field name \"schema\" in \"Format\" shadows an attribute in parent \"BaseModel\"")
warnings.filterwarnings("ignore", message="Field name \"schema\" in \"JsonFormat\" shadows an attribute in parent \"Format\"")
warnings.filterwarnings("ignore", message="Field name \"schema\" in \"ChangeTrackingFormat\" shadows an attribute in parent \"Format\"")
warnings.filterwarnings("ignore", message="Field name \"json\" in \"ScrapeFormats\" shadows an attribute in parent \"BaseModel\"")
warnings.filterwarnings("ignore", message="Field name \"json\" in \"Document\" shadows an attribute in parent \"BaseModel\"")

T = TypeVar('T')

# Module logger
logger = logging.getLogger("firecrawl")

# Base response types
class BaseResponse(BaseModel, Generic[T]):
    """Base response structure for all API responses."""
    success: bool
    data: Optional[T] = None
    error: Optional[str] = None
    warning: Optional[str] = None

# Document and content types
class DocumentMetadata(BaseModel):
    """Metadata for scraped documents (snake_case only; API camelCase normalized in code)."""
    # Common metadata fields
    title: Optional[str] = None
    description: Optional[str] = None
    url: Optional[str] = None
    language: Optional[str] = None
    keywords: Optional[Union[str, List[str]]] = None
    robots: Optional[str] = None

    # OpenGraph and social metadata
    og_title: Optional[str] = None
    og_description: Optional[str] = None
    og_url: Optional[str] = None
    og_image: Optional[str] = None
    og_audio: Optional[str] = None
    og_determiner: Optional[str] = None
    og_locale: Optional[str] = None
    og_locale_alternate: Optional[List[str]] = None
    og_site_name: Optional[str] = None
    og_video: Optional[str] = None

    # Dublin Core and other site metadata
    favicon: Optional[str] = None
    dc_terms_created: Optional[str] = None
    dc_date_created: Optional[str] = None
    dc_date: Optional[str] = None
    dc_terms_type: Optional[str] = None
    dc_type: Optional[str] = None
    dc_terms_audience: Optional[str] = None
    dc_terms_subject: Optional[str] = None
    dc_subject: Optional[str] = None
    dc_description: Optional[str] = None
    dc_terms_keywords: Optional[str] = None

    modified_time: Optional[str] = None
    published_time: Optional[str] = None
    article_tag: Optional[str] = None
    article_section: Optional[str] = None

    # Response-level metadata
    source_url: Optional[str] = None
    status_code: Optional[int] = None
    scrape_id: Optional[str] = None
    num_pages: Optional[int] = None
    content_type: Optional[str] = None
    proxy_used: Optional[Literal["basic", "stealth"]] = None
    cache_state: Optional[Literal["hit", "miss"]] = None
    cached_at: Optional[str] = None
    credits_used: Optional[int] = None

    # Error information
    error: Optional[str] = None

    @staticmethod
    def _coerce_list_to_string(value: Any) -> Any:
        if isinstance(value, list):
            # Prefer first string if semantically a single-valued field, else join
            if len(value) == 1:
                return str(value[0])
            return ', '.join(str(item) for item in value)
        return value

    @staticmethod
    def _coerce_string_to_int(value: Any) -> Any:
        if isinstance(value, str):
            try:
                return int(value)
            except ValueError:
                return value
        return value

    @field_validator('robots', 'og_title', 'og_description', 'og_url', 'og_image', 'language', mode='before')
    @classmethod
    def coerce_lists_to_string_fields(cls, v):
        return cls._coerce_list_to_string(v)

    @field_validator('status_code', mode='before')
    @classmethod
    def coerce_status_code_to_int(cls, v):
        return cls._coerce_string_to_int(v)

class AgentOptions(BaseModel):
    """Configuration for the agent in extract operations."""
    model: Literal["FIRE-1"] = "FIRE-1"

class AttributeResult(BaseModel):
    """Result of attribute extraction."""
    selector: str
    attribute: str
    values: List[str]

class Document(BaseModel):
    """A scraped document."""
    markdown: Optional[str] = None
    html: Optional[str] = None
    raw_html: Optional[str] = None
    json: Optional[Any] = None
    summary: Optional[str] = None
    metadata: Optional[DocumentMetadata] = None
    links: Optional[List[str]] = None
    images: Optional[List[str]] = None
    screenshot: Optional[str] = None
    actions: Optional[Dict[str, Any]] = None
    warning: Optional[str] = None
    change_tracking: Optional[Dict[str, Any]] = None

    @property
    def metadata_typed(self) -> DocumentMetadata:
        """Always returns a DocumentMetadata instance for LSP-friendly access."""
        md = self.metadata
        if isinstance(md, DocumentMetadata):
            return md
        if isinstance(md, dict):
            try:
                return DocumentMetadata(**md)
            except (ValidationError, TypeError) as exc:
                logger.debug("Failed to construct DocumentMetadata from dict: %s", exc)
        return DocumentMetadata()

    @property
    def metadata_dict(self) -> Dict[str, Any]:
        """Returns metadata as a plain dict (exclude None)."""
        md = self.metadata
        if isinstance(md, DocumentMetadata):
            return md.model_dump(exclude_none=True)
        if isinstance(md, dict):
            return {k: v for k, v in md.items() if v is not None}
        return {}

# Webhook types
class WebhookConfig(BaseModel):
    """Configuration for webhooks."""
    url: str
    headers: Optional[Dict[str, str]] = None
    metadata: Optional[Dict[str, str]] = None
    events: Optional[List[Literal["completed", "failed", "page", "started"]]] = None

class WebhookData(BaseModel):
    """Data sent to webhooks."""
    job_id: str
    status: str
    current: Optional[int] = None
    total: Optional[int] = None
    data: Optional[List[Document]] = None
    error: Optional[str] = None

class Source(BaseModel):
    """Configuration for a search source."""
    type: str

SourceOption = Union[str, Source]

class Category(BaseModel):
    """Configuration for a search category.
    
    Supported categories:
    - "github": Filter results to GitHub repositories
    - "research": Filter results to research papers and academic sites
    - "pdf": Filter results to PDF files (adds filetype:pdf to search)
    """
    type: str

CategoryOption = Union[str, Category]

FormatString = Literal[
    # camelCase versions (API format)
    "markdown", "html", "rawHtml", "links",  "images", "screenshot", "summary", "changeTracking", "json", "attributes",
    # snake_case versions (user-friendly)
    "raw_html", "change_tracking"
]

class Viewport(BaseModel):
    """Viewport configuration for screenshots."""
    width: int
    height: int

class Format(BaseModel):
    """Configuration for a format."""
    type: FormatString

class JsonFormat(Format):
    """Configuration for JSON extraction."""
    prompt: Optional[str] = None
    schema: Optional[Any] = None

class ChangeTrackingFormat(Format):
    """Configuration for change tracking."""
    modes: List[Literal["git-diff", "json"]]
    schema: Optional[Dict[str, Any]] = None
    prompt: Optional[str] = None
    tag: Optional[str] = None

class ScreenshotFormat(BaseModel):
    """Configuration for screenshot format."""
    type: Literal["screenshot"] = "screenshot"
    full_page: Optional[bool] = None
    quality: Optional[int] = None
    viewport: Optional[Union[Dict[str, int], Viewport]] = None
    
class AttributeSelector(BaseModel):
    """Selector and attribute pair for attribute extraction."""
    selector: str
    attribute: str

class AttributesFormat(Format):
    """Configuration for attribute extraction."""
    type: Literal["attributes"] = "attributes"
    selectors: List[AttributeSelector]

FormatOption = Union[Dict[str, Any], FormatString, JsonFormat, ChangeTrackingFormat, ScreenshotFormat, AttributesFormat, Format]
# Scrape types
class ScrapeFormats(BaseModel):
    """Output formats for scraping."""
    formats: Optional[List[FormatOption]] = None
    markdown: bool = True
    html: bool = False
    raw_html: bool = False
    summary: bool = False
    links: bool = False
    images: bool = False
    screenshot: bool = False
    change_tracking: bool = False
    json: bool = False

    @field_validator('formats')
    @classmethod
    def validate_formats(cls, v):
        """Validate and normalize formats input."""
        if v is None:
            return v
        
        normalized_formats = []
        for format_item in v:
            if isinstance(format_item, str):
                normalized_formats.append(Format(type=format_item))
            elif isinstance(format_item, dict):
                # Preserve dicts as-is to avoid dropping custom fields like 'schema'
                normalized_formats.append(format_item)
            elif isinstance(format_item, Format):
                normalized_formats.append(format_item)
            else:
                raise ValueError(f"Invalid format format: {format_item}")
        
        return normalized_formats

class ScrapeOptions(BaseModel):
    """Options for scraping operations."""
    formats: Optional[Union['ScrapeFormats', List[FormatOption]]] = None
    headers: Optional[Dict[str, str]] = None
    include_tags: Optional[List[str]] = None
    exclude_tags: Optional[List[str]] = None
    only_main_content: Optional[bool] = None
    timeout: Optional[int] = None
    wait_for: Optional[int] = None
    mobile: Optional[bool] = None
    parsers: Optional[Union[List[str], List[Union[str, 'PDFParser']]]] = None
    actions: Optional[List[Union['WaitAction', 'ScreenshotAction', 'ClickAction', 'WriteAction', 'PressAction', 'ScrollAction', 'ScrapeAction', 'ExecuteJavascriptAction', 'PDFAction']]] = None
    location: Optional['Location'] = None
    skip_tls_verification: Optional[bool] = None
    remove_base64_images: Optional[bool] = None
    fast_mode: Optional[bool] = None
    use_mock: Optional[str] = None
    block_ads: Optional[bool] = None
    proxy: Optional[Literal["basic", "stealth", "auto"]] = None
    max_age: Optional[int] = None
    store_in_cache: Optional[bool] = None
    integration: Optional[str] = None

    @field_validator('formats')
    @classmethod
    def validate_formats(cls, v):
        """Validate and normalize formats input."""
        if v is None:
            return v
        if isinstance(v, ScrapeFormats):
            return v
        if isinstance(v, list):
            return v
        raise ValueError(f"Invalid formats type: {type(v)}. Expected ScrapeFormats or List[FormatOption]")

class ScrapeRequest(BaseModel):
    """Request for scraping a single URL."""
    url: str
    options: Optional[ScrapeOptions] = None

class ScrapeData(Document):
    """Scrape results data."""
    pass

class ScrapeResponse(BaseResponse[ScrapeData]):
    """Response for scrape operations."""
    pass

# Crawl types
class CrawlRequest(BaseModel):
    """Request for crawling a website."""
    url: str
    prompt: Optional[str] = None
    exclude_paths: Optional[List[str]] = None
    include_paths: Optional[List[str]] = None
    max_discovery_depth: Optional[int] = None
    sitemap: Literal["skip", "include"] = "include"
    ignore_query_parameters: bool = False
    limit: Optional[int] = None
    crawl_entire_domain: bool = False
    allow_external_links: bool = False
    allow_subdomains: bool = False
    delay: Optional[int] = None
    max_concurrency: Optional[int] = None
    webhook: Optional[Union[str, WebhookConfig]] = None
    scrape_options: Optional[ScrapeOptions] = None
    zero_data_retention: bool = False
    integration: Optional[str] = None

class CrawlResponse(BaseModel):
    """Information about a crawl job."""
    id: str
    url: str

class CrawlJob(BaseModel):
    """Crawl job status and progress data."""
    status: Literal["scraping", "completed", "failed", "cancelled"]
    total: int = 0
    completed: int = 0
    credits_used: int = 0
    expires_at: Optional[datetime] = None
    next: Optional[str] = None
    data: List[Document] = []

class CrawlStatusRequest(BaseModel):
    """Request to get crawl job status."""
    job_id: str

class SearchResultWeb(BaseModel):
    """A web search result with URL, title, and description."""
    url: str
    title: Optional[str] = None
    description: Optional[str] = None
    category: Optional[str] = None

class SearchResultNews(BaseModel):
  """A news search result with URL, title, snippet, date, image URL, and position."""
  title: Optional[str] = None
  url: Optional[str] = None
  snippet: Optional[str] = None
  date: Optional[str] = None
  image_url: Optional[str] = None
  position: Optional[int] = None
  category: Optional[str] = None

class SearchResultImages(BaseModel):
  """An image search result with URL, title, image URL, image width, image height, and position."""
  title: Optional[str] = None
  image_url: Optional[str] = None
  image_width: Optional[int] = None
  image_height: Optional[int] = None
  url: Optional[str] = None
  position: Optional[int] = None

class SearchData(BaseModel):
  """Search results grouped by source type."""
  web: Optional[List[Union[SearchResultWeb, Document]]] = None
  news: Optional[List[Union[SearchResultNews, Document]]] = None
  images: Optional[List[Union[SearchResultImages, Document]]] = None

class MapDocument(Document):
    """A document from a map operation with URL and description."""
    url: str
    description: Optional[str] = None

# Crawl params types
class CrawlParamsRequest(BaseModel):
    """Request for getting crawl parameters from LLM."""
    url: str
    prompt: str

class CrawlParamsData(BaseModel):
    """Data returned from crawl params endpoint."""
    include_paths: Optional[List[str]] = None
    exclude_paths: Optional[List[str]] = None
    max_discovery_depth: Optional[int] = None
    ignore_sitemap: bool = False
    ignore_query_parameters: bool = False
    limit: Optional[int] = None
    crawl_entire_domain: bool = False
    allow_external_links: bool = False
    allow_subdomains: bool = False
    delay: Optional[int] = None
    max_concurrency: Optional[int] = None
    webhook: Optional[Union[str, WebhookConfig]] = None
    scrape_options: Optional[ScrapeOptions] = None
    zero_data_retention: bool = False
    warning: Optional[str] = None
    integration: Optional[str] = None

class CrawlParamsResponse(BaseResponse[CrawlParamsData]):
    """Response from crawl params endpoint."""
    pass

# Batch scrape types
class BatchScrapeRequest(BaseModel):
    """Request for batch scraping multiple URLs (internal helper only)."""
    urls: List[str]
    options: Optional[ScrapeOptions] = None
    webhook: Optional[Union[str, WebhookConfig]] = None
    append_to_id: Optional[str] = None
    ignore_invalid_urls: Optional[bool] = None
    max_concurrency: Optional[int] = None
    zero_data_retention: Optional[bool] = None
    integration: Optional[str] = None

class BatchScrapeResponse(BaseModel):
    """Response from starting a batch scrape job (mirrors CrawlResponse naming)."""
    id: str
    url: str
    invalid_urls: Optional[List[str]] = None

class BatchScrapeJob(BaseModel):
    """Batch scrape job status and results."""
    status: Literal["scraping", "completed", "failed", "cancelled"]
    completed: int
    total: int
    credits_used: Optional[int] = None
    expires_at: Optional[datetime] = None
    next: Optional[str] = None
    data: List[Document] = []

class BatchScrapeStatusRequest(BaseModel):
    """Request to get batch scrape job status."""
    job_id: str

class BatchScrapeErrorsRequest(BaseModel):
    """Request to get errors for a batch scrape job."""
    job_id: str

# Map types
class MapOptions(BaseModel):
    """Options for mapping operations."""
    search: Optional[str] = None
    sitemap: Literal["only", "include", "skip"] = "include"
    include_subdomains: Optional[bool] = None
    limit: Optional[int] = None
    timeout: Optional[int] = None
    integration: Optional[str] = None
    location: Optional['Location'] = None

class MapRequest(BaseModel):
    """Request for mapping a website."""
    url: str
    options: Optional[MapOptions] = None



class MapData(BaseModel):
    """Map results data."""
    links: List['SearchResult']

class MapResponse(BaseResponse[MapData]):
    """Response for map operations."""
    pass

# Extract types
class ExtractRequest(BaseModel):
    """Request for extract operations."""
    urls: Optional[List[str]] = None
    prompt: Optional[str] = None
    schema_: Optional[Dict[str, Any]] = Field(default=None, alias="schema")
    system_prompt: Optional[str] = None
    allow_external_links: Optional[bool] = None
    enable_web_search: Optional[bool] = None
    show_sources: Optional[bool] = None
    scrape_options: Optional[ScrapeOptions] = None
    ignore_invalid_urls: Optional[bool] = None
    integration: Optional[str] = None
    agent: Optional[AgentOptions] = None
    
class ExtractResponse(BaseModel):
    """Response for extract operations (start/status/final)."""
    success: Optional[bool] = None
    id: Optional[str] = None
    status: Optional[Literal["processing", "completed", "failed", "cancelled"]] = None
    data: Optional[Any] = None
    error: Optional[str] = None
    warning: Optional[str] = None
    sources: Optional[Dict[str, Any]] = None
    expires_at: Optional[datetime] = None

# Usage/limits types
class ConcurrencyCheck(BaseModel):
    """Current concurrency and limits for the team/API key."""
    concurrency: int
    max_concurrency: int

class CreditUsage(BaseModel):
    """Remaining credits for the team/API key."""
    remaining_credits: int
    plan_credits: Optional[int] = None
    billing_period_start: Optional[str] = None
    billing_period_end: Optional[str] = None

class TokenUsage(BaseModel):
    """Recent token usage metrics (if available)."""
    remaining_tokens: int
    plan_tokens: Optional[int] = None
    billing_period_start: Optional[str] = None
    billing_period_end: Optional[str] = None

class QueueStatusRequest(BaseModel):
    """Request to retrieve queue status."""
    pass

class QueueStatusResponse(BaseModel):
    """Metrics about the team's scrape queue."""
    jobs_in_queue: int
    active_jobs_in_queue: int
    waiting_jobs_in_queue: int
    max_concurrency: int
    most_recent_success: Optional[datetime] = None

class CreditUsageHistoricalPeriod(BaseModel):
    startDate: Optional[str] = None
    endDate: Optional[str] = None
    apiKey: Optional[str] = None
    creditsUsed: int

class CreditUsageHistoricalResponse(BaseModel):
    success: bool
    periods: List[CreditUsageHistoricalPeriod]

class TokenUsageHistoricalPeriod(BaseModel):
    startDate: Optional[str] = None
    endDate: Optional[str] = None
    apiKey: Optional[str] = None
    tokensUsed: int

class TokenUsageHistoricalResponse(BaseModel):
    success: bool
    periods: List[TokenUsageHistoricalPeriod]

# Action types
class WaitAction(BaseModel):
    """Wait action to perform during scraping."""
    type: Literal["wait"] = "wait"
    milliseconds: Optional[int] = None
    selector: Optional[str] = None

class ScreenshotAction(BaseModel):
    """Screenshot action to perform during scraping."""
    type: Literal["screenshot"] = "screenshot"
    full_page: Optional[bool] = None
    quality: Optional[int] = None
    viewport: Optional[Union[Dict[str, int], Viewport]] = None

class ClickAction(BaseModel):
    """Click action to perform during scraping."""
    type: Literal["click"] = "click"
    selector: str

class WriteAction(BaseModel):
    """Write action to perform during scraping."""
    type: Literal["write"] = "write"
    text: str

class PressAction(BaseModel):
    """Press action to perform during scraping."""
    type: Literal["press"] = "press"
    key: str

class ScrollAction(BaseModel):
    """Scroll action to perform during scraping."""
    type: Literal["scroll"] = "scroll"
    direction: Literal["up", "down"]
    selector: Optional[str] = None

class ScrapeAction(BaseModel):
    """Scrape action to perform during scraping."""
    type: Literal["scrape"] = "scrape"

class ExecuteJavascriptAction(BaseModel):
    """Execute javascript action to perform during scraping."""
    type: Literal["executeJavascript"] = "executeJavascript"
    script: str

class PDFAction(BaseModel):
    """PDF action to perform during scraping."""
    type: Literal["pdf"] = "pdf"
    format: Optional[Literal["A0", "A1", "A2", "A3", "A4", "A5", "A6", "Letter", "Legal", "Tabloid", "Ledger"]] = None
    landscape: Optional[bool] = None
    scale: Optional[float] = None

class PDFParser(BaseModel):
    """PDF parser configuration with optional page limit."""
    type: Literal["pdf"] = "pdf"
    max_pages: Optional[int] = None

# Location types
class Location(BaseModel):
    """Location configuration for scraping."""
    country: Optional[str] = None
    languages: Optional[List[str]] = None

class SearchRequest(BaseModel):
    """Request for search operations."""
    query: str
    sources: Optional[List[SourceOption]] = None
    categories: Optional[List[CategoryOption]] = None
    limit: Optional[int] = 5
    tbs: Optional[str] = None
    location: Optional[str] = None
    ignore_invalid_urls: Optional[bool] = None
    timeout: Optional[int] = 60000
    scrape_options: Optional[ScrapeOptions] = None
    integration: Optional[str] = None

    @field_validator('sources')
    @classmethod
    def validate_sources(cls, v):
        """Validate and normalize sources input."""
        if v is None:
            return v
        
        normalized_sources = []
        for source in v:
            if isinstance(source, str):
                normalized_sources.append(Source(type=source))
            elif isinstance(source, dict):
                normalized_sources.append(Source(**source))
            elif isinstance(source, Source):
                normalized_sources.append(source)
            else:
                raise ValueError(f"Invalid source format: {source}")
        
        return normalized_sources
    
    @field_validator('categories')
    @classmethod
    def validate_categories(cls, v):
        """Validate and normalize categories input."""
        if v is None:
            return v
        
        normalized_categories = []
        for category in v:
            if isinstance(category, str):
                normalized_categories.append(Category(type=category))
            elif isinstance(category, dict):
                normalized_categories.append(Category(**category))
            elif isinstance(category, Category):
                normalized_categories.append(category)
            else:
                raise ValueError(f"Invalid category format: {category}")
        
        return normalized_categories

    # NOTE: parsers validation does not belong on SearchRequest; it is part of ScrapeOptions.

class LinkResult(BaseModel):
    """A generic link result with optional metadata (used by search and map)."""
    url: str
    title: Optional[str] = None
    description: Optional[str] = None
    
# Backward-compatible alias for existing tests/usages
SearchResult = LinkResult

class SearchData(BaseModel):
    """Search results grouped by source type."""
    web: Optional[List[Union[SearchResultWeb, Document]]] = None
    news: Optional[List[Union[SearchResultNews, Document]]] = None
    images: Optional[List[Union[SearchResultImages, Document]]] = None

class SearchResponse(BaseResponse[SearchData]):
    """Response from search operation."""
    pass

# Error types
class ErrorDetails(BaseModel):
    """Detailed error information."""
    code: Optional[str] = None
    message: str
    details: Optional[Dict[str, Any]] = None

class ErrorResponse(BaseModel):
    """Error response structure."""
    success: bool = False
    error: str
    details: Optional[ErrorDetails] = None

# Job management types
class JobStatus(BaseModel):
    """Generic job status information."""
    id: str
    status: Literal["pending", "scraping", "completed", "failed"]
    current: Optional[int] = None
    total: Optional[int] = None
    created_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None
    expires_at: Optional[datetime] = None

class CrawlError(BaseModel):
    """A crawl error."""
    id: str
    timestamp: Optional[datetime] = None
    url: str
    code: Optional[str] = None
    error: str

class CrawlErrorsResponse(BaseModel):
    """Response from crawl error monitoring."""
    errors: List[CrawlError]
    robots_blocked: List[str]

class CrawlErrorsRequest(BaseModel):
    """Request for crawl error monitoring."""
    crawl_id: str

class ActiveCrawl(BaseModel):
    """Information about an active crawl job."""
    id: str
    team_id: str
    url: str
    options: Optional[Dict[str, Any]] = None

class ActiveCrawlsResponse(BaseModel):
    """Response from active crawls endpoint."""
    success: bool = True
    crawls: List[ActiveCrawl]

class ActiveCrawlsRequest(BaseModel):
    """Request for listing active crawl jobs."""
    pass

# Configuration types
class ClientConfig(BaseModel):
    """Configuration for the Firecrawl client."""
    api_key: str
    api_url: str = "https://api.firecrawl.dev"
    timeout: Optional[float] = None
    max_retries: int = 3
    backoff_factor: float = 0.5

class PaginationConfig(BaseModel):
    """Configuration for pagination behavior."""
    auto_paginate: bool = True
    max_pages: Optional[int] = Field(default=None, ge=0)
    max_results: Optional[int] = Field(default=None, ge=0)
    max_wait_time: Optional[int] = Field(default=None, ge=0)    # seconds

# Response union types
AnyResponse = Union[
    ScrapeResponse,
    CrawlResponse,
    BatchScrapeResponse,
    MapResponse,
    SearchResponse,
    ErrorResponse,
]
