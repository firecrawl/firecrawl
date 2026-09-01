"""
Type definitions for Firecrawl v2 API.

This module contains clean, modern type definitions for the v2 API.
"""

import warnings
from datetime import datetime
from typing import Any, Dict, Generic, List, Literal, Optional, TypeVar, Union

try:
    from typing import Annotated
except ImportError:  # Python 3.8
    from typing_extensions import Annotated
import logging
from pydantic import (
    BaseModel,
    Field,
    field_validator,
    ValidationError,
    model_serializer,
    model_validator,
)

# Suppress pydantic warnings about schema field shadowing
# Tested using schema_field alias="schema" but it doesn't work.
warnings.filterwarnings(
    "ignore",
    message='Field name "schema" in "Format" shadows an attribute in parent "BaseModel"',
)
warnings.filterwarnings(
    "ignore",
    message='Field name "schema" in "JsonFormat" shadows an attribute in parent "Format"',
)
warnings.filterwarnings(
    "ignore",
    message='Field name "schema" in "ChangeTrackingFormat" shadows an attribute in parent "Format"',
)
warnings.filterwarnings(
    "ignore",
    message='Field name "json" in "ScrapeFormats" shadows an attribute in parent "BaseModel"',
)
warnings.filterwarnings(
    "ignore",
    message='Field name "json" in "Document" shadows an attribute in parent "BaseModel"',
)
warnings.filterwarnings(
    "ignore",
    message='Field name "json" in "MonitorPageDiff" shadows an attribute in parent "BaseModel"',
)
warnings.filterwarnings(
    "ignore",
    message='Field name "json" in "MonitorPageSnapshot" shadows an attribute in parent "BaseModel"',
)
warnings.filterwarnings(
    "ignore",
    message='Field name "schema" in "AgentListItemOptions" shadows an attribute in parent "BaseModel"',
)

T = TypeVar("T")

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

    model_config = {"extra": "allow"}

    @model_serializer(mode="wrap")
    def _serialize(self, handler):
        out = handler(self)
        extra = getattr(self, "__pydantic_extra__", None)
        if isinstance(extra, dict):
            for k, v in extra.items():
                if v is not None:
                    out[k] = v
        return out

    # Common metadata fields
    title: Optional[str] = None
    description: Optional[str] = None
    # URL reported by the selected scrape engine.
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
    # URL requested for the scrape.
    source_url: Optional[str] = None
    # HTTP status code reported for the scrape response.
    status_code: Optional[int] = None
    scrape_id: Optional[str] = None
    num_pages: Optional[int] = None
    total_pages: Optional[int] = None
    content_type: Optional[str] = None
    proxy_used: Optional[Literal["basic", "stealth"]] = None
    timezone: Optional[str] = None
    cache_state: Optional[Literal["hit", "miss"]] = None
    cached_at: Optional[str] = None
    credits_used: Optional[int] = None
    concurrency_limited: Optional[bool] = None
    concurrency_queue_duration_ms: Optional[int] = None

    # Error information
    error: Optional[str] = None

    @property
    def extras(self) -> Dict[str, Any]:
        """Return unknown metadata keys preserved on the model."""
        extra = getattr(self, "__pydantic_extra__", None)
        return dict(extra) if isinstance(extra, dict) else {}

    @staticmethod
    def _coerce_list_to_string(value: Any) -> Any:
        if isinstance(value, list):
            # Prefer first string if semantically a single-valued field, else join
            if len(value) == 1:
                return str(value[0])
            return ", ".join(str(item) for item in value)
        return value

    @staticmethod
    def _coerce_string_to_int(value: Any) -> Any:
        if isinstance(value, str):
            try:
                return int(value)
            except ValueError:
                return value
        return value

    @model_validator(mode="before")
    @classmethod
    def coerce_lists_for_string_fields(cls, data):
        """Before validation: coerce lists to strings for known single-string fields.
        Preserves unknown-key lists.
        """
        if not isinstance(data, dict):
            return data
        single_str_fields = {
            "title",
            "description",
            "url",
            "language",
            "robots",
            "og_title",
            "og_description",
            "og_url",
            "og_image",
            "og_audio",
            "og_determiner",
            "og_locale",
            "og_site_name",
            "og_video",
            "favicon",
            "dc_terms_created",
            "dc_date_created",
            "dc_date",
            "dc_terms_type",
            "dc_type",
            "dc_terms_audience",
            "dc_terms_subject",
            "dc_subject",
            "dc_description",
            "dc_terms_keywords",
            "modified_time",
            "published_time",
            "article_tag",
            "article_section",
            "source_url",
            "scrape_id",
            "content_type",
            "cached_at",
            "error",
            "timezone",
        }
        for k, v in list(data.items()):
            if isinstance(v, list) and k in single_str_fields:
                data[k] = cls._coerce_list_to_string(v)
            # For ints that might appear as list, take first
            if isinstance(v, list) and k in {
                "status_code",
                "num_pages",
                "total_pages",
                "credits_used",
            }:
                first = v[0] if v else None
                data[k] = cls._coerce_string_to_int(first)
        return data

    @field_validator(
        "robots",
        "og_title",
        "og_description",
        "og_url",
        "og_image",
        "language",
        mode="before",
    )
    @classmethod
    def coerce_lists_to_string_fields(cls, v):
        return cls._coerce_list_to_string(v)

    @field_validator("status_code", mode="before")
    @classmethod
    def coerce_status_code_to_int(cls, v):
        return cls._coerce_string_to_int(v)


class AgentOptions(BaseModel):
    """Configuration for the agent in extract operations."""

    model: Literal["FIRE-1", "v3-beta"] = "FIRE-1"


class AttributeResult(BaseModel):
    """Result of attribute extraction."""

    selector: str
    attribute: str
    values: List[str]


class BrandingProfile(BaseModel):
    """Branding information extracted from a website."""

    model_config = {"extra": "allow", "populate_by_name": True}

    color_scheme: Optional[Literal["light", "dark"]] = None
    brand_name: Optional[str] = Field(default=None, alias="brandName")
    logo: Optional[str] = None
    fonts: Optional[List[Dict[str, Any]]] = None
    colors: Optional[Dict[str, str]] = None
    typography: Optional[Dict[str, Any]] = None
    spacing: Optional[Dict[str, Any]] = None
    components: Optional[Dict[str, Any]] = None
    icons: Optional[Dict[str, str]] = None
    images: Optional[Dict[str, Optional[str]]] = None
    animations: Optional[Dict[str, str]] = None
    layout: Optional[Dict[str, Any]] = None
    tone: Optional[Dict[str, str]] = None
    personality: Optional[Dict[str, Any]] = None


class ProductPrice(BaseModel):
    """A monetary price for a product or variant."""

    model_config = {"extra": "allow", "populate_by_name": True}

    amount: float
    currency: Optional[str] = None
    formatted: Optional[str] = None


class ProductAvailability(BaseModel):
    """Availability information for a product or variant."""

    model_config = {"extra": "allow", "populate_by_name": True}

    in_stock: bool = Field(alias="inStock")
    text: Optional[str] = None


class ProductImage(BaseModel):
    """An image associated with a product or variant."""

    model_config = {"extra": "allow", "populate_by_name": True}

    url: str
    alt: Optional[str] = None


class ProductSale(BaseModel):
    """Sale information for a variant, holding the pre-sale price."""

    model_config = {"extra": "allow", "populate_by_name": True}

    original_price: ProductPrice = Field(alias="originalPrice")


class ProductVariant(BaseModel):
    """A purchasable variant of a product (e.g. a size/color combination)."""

    model_config = {"extra": "allow", "populate_by_name": True}

    id: Optional[str] = None
    sku: Optional[str] = None
    title: Optional[str] = None
    values: Optional[Dict[str, Any]] = None
    price: Optional[ProductPrice] = None
    sale: Optional[ProductSale] = None
    availability: ProductAvailability
    images: Optional[List[ProductImage]] = None


class ProductProfile(BaseModel):
    """Structured product information extracted from a website."""

    model_config = {"extra": "allow", "populate_by_name": True}

    title: str
    brand: Optional[str] = None
    category: Optional[str] = None
    url: str
    description: Optional[str] = None
    variants: List[ProductVariant] = Field(default_factory=list)


class MenuPrice(BaseModel):
    """A monetary price for a menu item."""

    model_config = {"extra": "allow", "populate_by_name": True}

    amount: float
    currency: Optional[str] = None
    formatted: Optional[str] = None


class MenuAvailability(BaseModel):
    """Availability information for a menu item."""

    model_config = {"extra": "allow", "populate_by_name": True}

    in_stock: bool = Field(alias="inStock")
    text: Optional[str] = None


class MenuImage(BaseModel):
    """An image associated with a menu item."""

    model_config = {"extra": "allow", "populate_by_name": True}

    url: str
    alt: Optional[str] = None


class MenuItemIdentifiers(BaseModel):
    """External identifiers for a menu item."""

    model_config = {"extra": "allow", "populate_by_name": True}

    merchant_item_id: Optional[str] = Field(default=None, alias="merchantItemId")


class MenuItem(BaseModel):
    """A single item on a menu."""

    model_config = {"extra": "allow", "populate_by_name": True}

    id: str
    name: str
    description: Optional[str] = None
    images: List[MenuImage] = Field(default_factory=list)
    price: Optional[MenuPrice] = None
    availability: MenuAvailability
    dietary: List[str] = Field(default_factory=list)
    calories: Optional[float] = None
    option_groups: List[Any] = Field(default_factory=list, alias="optionGroups")
    identifiers: MenuItemIdentifiers = Field(default_factory=MenuItemIdentifiers)
    url: Optional[str] = None
    source_url: str = Field(alias="sourceUrl")


class MenuSection(BaseModel):
    """An ordered group of menu items."""

    model_config = {"extra": "allow", "populate_by_name": True}

    id: str
    name: str
    description: Optional[str] = None
    items: List[MenuItem] = Field(default_factory=list)


class MenuMerchant(BaseModel):
    """The merchant a menu belongs to."""

    model_config = {"extra": "allow", "populate_by_name": True}

    name: str
    type: Optional[str] = None
    location: Optional[Any] = None


class MenuProfile(BaseModel):
    """Structured menu information extracted from a website."""

    model_config = {"extra": "allow", "populate_by_name": True}

    is_menu: bool = Field(alias="isMenu")
    confidence: float
    merchant: MenuMerchant
    currency: Optional[str] = None
    sections: List[MenuSection] = Field(default_factory=list)
    source_url: str = Field(alias="sourceUrl")


RedactPIIEntity = Literal[
    "PERSON",
    "EMAIL",
    "PHONE",
    "LOCATION",
    "FINANCIAL",
    "SECRET",
]


class PdfBlockConfidence(BaseModel):
    """Layout and OCR confidence scores for a PDF block."""

    model_config = {"extra": "allow", "populate_by_name": True}

    layout: Optional[float] = None
    ocr: Optional[float] = None


class PdfBlockItem(BaseModel):
    """A typed PDF layout block (bounding box, type, reading order)."""

    model_config = {"extra": "allow", "populate_by_name": True}

    id: str
    type: str
    label: Optional[str] = None
    bbox: Optional[List[float]] = None
    content: str
    markdown_span: Optional[List[int]] = Field(default=None, alias="markdownSpan")
    reading_order: int = Field(alias="readingOrder")
    source: Optional[str] = None
    confidence: PdfBlockConfidence


class PdfPageBlocks(BaseModel):
    """Typed layout blocks for a single PDF page."""

    model_config = {"extra": "allow", "populate_by_name": True}

    page_number: int = Field(alias="pageNumber")
    width: Optional[float] = None
    height: Optional[float] = None
    status: str
    items: List[PdfBlockItem] = Field(default_factory=list)


class PdfPage(BaseModel):
    """Physical PDF page markdown, present when parsers[].pages is true."""

    model_config = {"extra": "allow", "populate_by_name": True}

    page_number: int = Field(alias="pageNumber")
    markdown: str


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
    audio: Optional[str] = None
    video: Optional[str] = None
    actions: Optional[Dict[str, Any]] = None
    answer: Optional[str] = None
    highlights: Optional[str] = None
    warning: Optional[str] = None
    change_tracking: Optional[Dict[str, Any]] = None
    branding: Optional[BrandingProfile] = None
    product: Optional[ProductProfile] = None
    menu: Optional[MenuProfile] = None
    pages: Optional[List[PdfPage]] = None
    blocks: Optional[List[PdfPageBlocks]] = None

    @property
    def metadata_typed(self) -> DocumentMetadata:
        """Always returns a DocumentMetadata instance for LSP-friendly access."""
        md = self.metadata
        if isinstance(md, DocumentMetadata):
            return md
        if isinstance(md, dict):
            try:
                return DocumentMetadata.model_validate(md)
            except (ValidationError, TypeError) as exc:
                logger.debug("Failed to construct DocumentMetadata from dict: %s", exc)
        return DocumentMetadata()

    @property
    def metadata_dict(self) -> Dict[str, Any]:
        """Returns metadata as a plain dict (exclude None), including extras."""
        md = self.metadata
        if isinstance(md, DocumentMetadata):
            out = md.model_dump(exclude_none=True)
            # Ensure extras are preserved even if model_dump omits them
            extra = getattr(md, "__pydantic_extra__", None)
            if isinstance(extra, dict):
                for k, v in extra.items():
                    if v is not None:
                        out[k] = v
            return out
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


class AgentWebhookConfig(BaseModel):
    """Configuration for agent webhooks.

    Agent webhooks support different events than crawl webhooks:
    - started: When the agent job starts
    - action: When the agent takes an action/step
    - completed: When the job completes successfully
    - failed: When the job fails
    - cancelled: When the job is cancelled
    """

    url: str
    headers: Optional[Dict[str, str]] = None
    metadata: Optional[Dict[str, str]] = None
    events: Optional[List[Literal["started", "action", "completed", "failed", "cancelled"]]] = None


class MonitorWebhookConfig(BaseModel):
    """Configuration for monitor webhooks.

    Monitor webhooks support different events than crawl webhooks:
    - monitor.page: One event per scraped URL as it finishes, with the
      page-level diff status (`same` | `changed` | `new` | `removed` |
      `error`).
    - monitor.check.completed: A summary event sent after the full
      monitor check is reconciled.
    """

    url: str
    headers: Optional[Dict[str, str]] = None
    metadata: Optional[Dict[str, str]] = None
    events: Optional[List[Literal["monitor.page", "monitor.check.completed"]]] = None


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

    Categories narrow ordinary **web search**. They do not switch `search()` to
    a different index.

    Supported categories:
    - "github": Restrict web results to github.com (a `site:` filter)
    - "research": Restrict web results to a fixed list of ~14 academic
      *websites* (arxiv.org, pubmed.ncbi.nlm.nih.gov, nature.com, science.org,
      ieee.org, sciencedirect.com, biorxiv.org, medrxiv.org, ...). This is a
      website/domain filter and it returns ordinary web page results for those
      domains — **not** paper records.
    - "pdf": Filter results to PDF files (adds filetype:pdf to search)
    - "developer": Developer-index results (issues, pull requests, READMEs and
      documentation) served in `web`; cannot be combined with other categories

    .. warning::
       ``categories=["research"]`` is **not** Firecrawl's research paper index.
       To search papers themselves — ~43M abstracts, about 90% biomedical
       (PubMed, bioRxiv, medRxiv) plus arXiv — with full abstracts, in-body
       passage reads and citation-graph expansion, use
       :meth:`Firecrawl.search_papers` (and ``inspect_paper``, ``read_paper``,
       ``related_papers``), which call ``/v2/search/research``.

       Rule of thumb: literature search → ``search_papers()``; web pages that
       happen to live on academic domains → ``search(categories=["research"])``.
    """

    type: str


CategoryOption = Union[str, Category]

FormatString = Literal[
    # camelCase versions (API format)
    "markdown",
    "html",
    "rawHtml",
    "links",
    "images",
    "screenshot",
    "summary",
    "changeTracking",
    "json",
    "attributes",
    "branding",
    "product",
    "menu",
    "query",
    "audio",
    "video",
    # snake_case versions (user-friendly)
    "raw_html",
    "change_tracking",
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

    type: Literal["json"] = "json"
    prompt: Optional[str] = None
    schema: Optional[Any] = None
    check_prompt_injection: Optional[bool] = None


class ChangeTrackingFormat(Format):
    """Configuration for change tracking."""

    type: Literal["change_tracking", "changeTracking"] = "change_tracking"
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


class QuestionFormat(Format):
    """Configuration for question format - ask a question about the page content."""

    type: Literal["question"] = "question"
    question: str


class HighlightsFormat(Format):
    """Configuration for highlights format - extract direct highlights from page content."""

    type: Literal["highlights"] = "highlights"
    query: str


class QueryFormat(Format):
    """Deprecated query format. Use QuestionFormat or HighlightsFormat instead."""

    type: Literal["query"] = "query"
    prompt: str
    mode: Optional[Literal["freeform", "directQuote"]] = None


FormatOption = Union[
    Dict[str, Any],
    FormatString,
    JsonFormat,
    ChangeTrackingFormat,
    ScreenshotFormat,
    AttributesFormat,
    QuestionFormat,
    HighlightsFormat,
    QueryFormat,
    Format,
]


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

    @field_validator("formats")
    @classmethod
    def validate_formats(cls, v):
        """Validate and normalize formats input."""
        if v is None:
            return v

        normalized_formats = []
        for format_item in v:
            if isinstance(format_item, str):
                if format_item == "query":
                    raise ValueError("query format must be an object with 'type' and 'prompt' fields")
                normalized_formats.append(Format(type=format_item))
            elif isinstance(format_item, dict):
                fmt_type = format_item.get('type')
                prompt = format_item.get('prompt')
                question = format_item.get('question')
                query = format_item.get('query')
                if fmt_type == 'query' and (not isinstance(prompt, str) or not prompt.strip()):
                    raise ValueError("query format requires a non-empty 'prompt' string")
                if fmt_type == 'question' and (not isinstance(question, str) or not question.strip()):
                    raise ValueError("question format requires a non-empty 'question' string")
                if fmt_type == 'highlights' and (not isinstance(query, str) or not query.strip()):
                    raise ValueError("highlights format requires a non-empty 'query' string")
                # Preserve dicts as-is to avoid dropping custom fields like 'schema'
                normalized_formats.append(format_item)
            elif isinstance(format_item, Format):
                normalized_formats.append(format_item)
            else:
                raise ValueError(f"Invalid format format: {format_item}")

        return normalized_formats


class RedactPIIOptions(BaseModel):
    """Tuning options for the PII redaction step."""

    # accurate (default): model-only. Best precision, cleanest output.
    # aggressive: model + Presidio + spaCy. Higher recall, lower precision.
    # fast: Presidio only, no model call. Lower F1, ~2x throughput.
    mode: Optional[Literal["accurate", "aggressive", "fast"]] = None
    # Restrict redaction to these entity buckets. Unset means all entities.
    entities: Optional[List[RedactPIIEntity]] = None
    # tag (default): replace spans with `<KIND>` placeholders.
    # mask: replace spans with `*` of equal length.
    # remove: drop span characters entirely.
    replace_style: Optional[Literal["tag", "mask", "remove"]] = Field(
        default=None, alias="replaceStyle"
    )

    model_config = {"populate_by_name": True}


class ThreatProtectionOptions(BaseModel):
    """Enterprise: per-request field-level override of your team's threat
    protection policy.

    Requires threat protection to be enabled for your team and request
    overrides to be allowed in the team configuration. Only the fields you
    explicitly provide replace the team policy's values.
    """

    # "off" disables scanning for this request; "normal" applies the policy.
    mode: Optional[Literal["off", "normal"]] = None
    # Block verdicts at or above this risk score (integer 0-100).
    risk_score_threshold: Optional[int] = Field(
        default=None, alias="riskScoreThreshold"
    )
    # Exact domains or globs like "*.example.com" to always block (max 1000).
    blacklist: Optional[List[str]] = None
    # Exact domains or globs to always allow; wins over everything (max 1000).
    whitelist: Optional[List[str]] = None
    # Lowercase TLDs without the leading dot, e.g. "zip" (max 1000).
    blocked_tlds: Optional[List[str]] = Field(default=None, alias="blockedTlds")
    # Behavior when scanning is unavailable: "closed" blocks, "open" allows.
    failure_policy: Optional[Literal["open", "closed"]] = Field(
        default=None, alias="failurePolicy"
    )

    model_config = {"populate_by_name": True}


class AuditMetadata(BaseModel):
    """User attribution included with SIEM logging events."""

    username: str = Field(max_length=1024)

    model_config = {"extra": "forbid"}


class ScrapeOptions(BaseModel):
    """Options for scraping operations."""

    formats: Optional[Union["ScrapeFormats", List[FormatOption]]] = None
    headers: Optional[Dict[str, str]] = None
    include_tags: Optional[List[str]] = None
    exclude_tags: Optional[List[str]] = None
    only_main_content: Optional[bool] = None
    timeout: Optional[int] = None
    wait_for: Optional[int] = None
    mobile: Optional[bool] = None
    parsers: Optional[Union[List[str], List[Union[str, "PDFParser"]]]] = None
    actions: Optional[
        List[
            Union[
                "WaitAction",
                "ScreenshotAction",
                "ClickAction",
                "WriteAction",
                "PressAction",
                "ScrollAction",
                "ScrapeAction",
                "ExecuteJavascriptAction",
                "PDFAction",
            ]
        ]
    ] = None
    location: Optional["Location"] = None
    skip_tls_verification: Optional[bool] = None
    remove_base64_images: Optional[bool] = None
    fast_mode: Optional[bool] = None
    use_mock: Optional[str] = None
    block_ads: Optional[bool] = None
    proxy: Optional[Literal["basic", "stealth", "enhanced", "auto"]] = None
    # Maximum age, in milliseconds, of indexed content that may be reused.
    # Set to 0 to bypass index reuse.
    max_age: Optional[int] = None
    min_age: Optional[int] = None
    store_in_cache: Optional[bool] = None
    lockdown: Optional[bool] = None
    redact_pii: Optional[Union[bool, RedactPIIOptions]] = Field(
        default=None, alias="redactPII"
    )
    threat_protection: Optional[ThreatProtectionOptions] = Field(
        default=None, alias="threatProtection"
    )
    audit_metadata: Optional[AuditMetadata] = Field(
        default=None, alias="auditMetadata"
    )
    profile: Optional[Dict[str, Any]] = None
    integration: Optional[str] = None

    model_config = {"populate_by_name": True}

    @field_validator("formats")
    @classmethod
    def validate_formats(cls, v):
        """Validate and normalize formats input."""
        if v is None:
            return v
        if isinstance(v, ScrapeFormats):
            return v
        if isinstance(v, list):
            return v
        raise ValueError(
            f"Invalid formats type: {type(v)}. Expected ScrapeFormats or List[FormatOption]"
        )


# Parse accepts a strict subset of scrape options; unsupported fields are
# rejected by parse-specific request preparation.
ParseOptions = ScrapeOptions


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
    sitemap: Literal["skip", "include", "only"] = "include"
    ignore_query_parameters: bool = False
    deduplicate_similar_urls: bool = True
    limit: Optional[int] = None
    crawl_entire_domain: bool = False
    allow_external_links: bool = False
    allow_subdomains: bool = False
    ignore_robots_txt: bool = False
    robots_user_agent: Optional[str] = None
    delay: Optional[int] = None
    max_concurrency: Optional[int] = None
    webhook: Optional[Union[str, WebhookConfig]] = None
    scrape_options: Optional[ScrapeOptions] = None
    regex_on_full_url: bool = False
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
    """A web search result with URL, title, description, and position."""

    url: str
    title: Optional[str] = None
    description: Optional[str] = None
    position: Optional[int] = None
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
    sitemap: Optional[Literal["skip", "include", "only"]] = None
    ignore_query_parameters: bool = False
    deduplicate_similar_urls: bool = True
    limit: Optional[int] = None
    crawl_entire_domain: bool = False
    allow_external_links: bool = False
    allow_subdomains: bool = False
    ignore_robots_txt: bool = False
    robots_user_agent: Optional[str] = None
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
    ignore_query_parameters: Optional[bool] = None
    limit: Optional[int] = None
    timeout: Optional[int] = None
    integration: Optional[str] = None
    location: Optional["Location"] = None
    threat_protection: Optional[ThreatProtectionOptions] = None
    audit_metadata: Optional[AuditMetadata] = None


class MapRequest(BaseModel):
    """Request for mapping a website."""

    url: str
    options: Optional[MapOptions] = None


class MapData(BaseModel):
    """Map results data."""

    links: List["SearchResult"]


class MapResponse(BaseResponse[MapData]):
    """Response for map operations."""

    pass


# Monitor types
class MonitorSchedule(BaseModel):
    """Schedule for a monitor.

    On create / update you provide exactly one of `cron` or `text`:

    - `cron`: a 5-field cron expression (e.g. ``"*/30 * * * *"``).
    - `text`: a natural-language schedule (e.g. ``"every 30 minutes"``,
      ``"hourly"``, ``"daily at 9:00"``). Firecrawl normalizes this to a
      cron expression server-side.

    On read, the API always returns the normalized ``cron`` value, so
    `cron` is populated in responses even when the monitor was created
    with `text`.
    """

    cron: Optional[str] = None
    text: Optional[str] = None
    timezone: str = "UTC"


class MonitorEmailNotification(BaseModel):
    enabled: bool = False
    recipients: List[str] = []
    include_diffs: bool = Field(default=False, alias="includeDiffs")

    model_config = {"populate_by_name": True}


class MonitorNotification(BaseModel):
    email: Optional[MonitorEmailNotification] = None


class MonitorEmailRecipientSubscription(BaseModel):
    """Per-recipient opt-in state for monitor email notifications.

    External recipients (not members of the team that owns the monitor) must
    confirm their subscription via a one-time email before they receive any
    monitor notifications. Team members are auto-confirmed.

    Statuses:
      - ``pending``      - confirmation email sent, no notifications yet
      - ``confirmed``    - notifications enabled
      - ``unsubscribed`` - recipient opted out and cannot be re-added without
                            a new confirmation flow
    """

    model_config = {"populate_by_name": True}

    email: str
    status: Literal["pending", "confirmed", "unsubscribed"]
    source: Literal["team", "opt_in", "legacy"]
    confirmation_email_sent: Optional[bool] = Field(
        default=None, alias="confirmationEmailSent"
    )


class MonitorTarget(BaseModel):
    """A scrape, crawl, or search target stored on a monitor."""

    model_config = {"extra": "allow", "populate_by_name": True}

    id: Optional[str] = None
    type: Literal["scrape", "crawl", "search"]
    urls: Optional[List[str]] = None
    url: Optional[str] = None
    scrape_options: Optional[Union[ScrapeOptions, Dict[str, Any]]] = Field(default=None, alias="scrapeOptions")
    crawl_options: Optional[Dict[str, Any]] = Field(default=None, alias="crawlOptions")
    # search target fields
    queries: Optional[List[str]] = None
    search_window: Optional[Literal["5m", "15m", "1h", "6h", "24h", "7d"]] = Field(default=None, alias="searchWindow")
    include_domains: Optional[List[str]] = Field(default=None, alias="includeDomains")
    exclude_domains: Optional[List[str]] = Field(default=None, alias="excludeDomains")
    max_results: Optional[int] = Field(default=None, alias="maxResults")


class MonitorCreateRequest(BaseModel):
    model_config = {"populate_by_name": True}

    name: str
    schedule: MonitorSchedule
    webhook: Optional[MonitorWebhookConfig] = None
    notification: Optional[MonitorNotification] = None
    targets: List[Union[MonitorTarget, Dict[str, Any]]]
    retention_days: Optional[int] = Field(default=None, alias="retentionDays")
    goal: Optional[str] = None
    judge_enabled: Optional[bool] = Field(default=None, alias="judgeEnabled")


class MonitorUpdateRequest(BaseModel):
    model_config = {"populate_by_name": True}

    name: Optional[str] = None
    status: Optional[Literal["active", "paused"]] = None
    schedule: Optional[MonitorSchedule] = None
    webhook: Optional[Union[MonitorWebhookConfig, Dict[str, Any]]] = None
    notification: Optional[Union[MonitorNotification, Dict[str, Any]]] = None
    targets: Optional[List[Union[MonitorTarget, Dict[str, Any]]]] = None
    retention_days: Optional[int] = Field(default=None, alias="retentionDays")
    goal: Optional[str] = None
    judge_enabled: Optional[bool] = Field(default=None, alias="judgeEnabled")


class MonitorSummary(BaseModel):
    total_pages: int = Field(default=0, alias="totalPages")
    same: int = 0
    changed: int = 0
    new: int = 0
    removed: int = 0
    error: int = 0

    model_config = {"populate_by_name": True}


class Monitor(BaseModel):
    model_config = {"populate_by_name": True, "extra": "allow"}

    id: str
    name: str
    status: Literal["active", "paused", "deleted"]
    schedule: MonitorSchedule
    next_run_at: Optional[str] = Field(default=None, alias="nextRunAt")
    last_run_at: Optional[str] = Field(default=None, alias="lastRunAt")
    current_check_id: Optional[str] = Field(default=None, alias="currentCheckId")
    targets: List[Dict[str, Any]]
    webhook: Optional[Dict[str, Any]] = None
    notification: Optional[Dict[str, Any]] = None
    # Present on create/update/get when the API has reconciled email
    # recipients (i.e. notification.email.recipients is non-empty). Each
    # entry reports a recipient's opt-in status.
    email_recipient_subscriptions: Optional[List[MonitorEmailRecipientSubscription]] = (
        Field(default=None, alias="emailRecipientSubscriptions")
    )
    retention_days: int = Field(alias="retentionDays")
    estimated_credits_per_month: Optional[int] = Field(default=None, alias="estimatedCreditsPerMonth")
    last_check_summary: Optional[MonitorSummary] = Field(default=None, alias="lastCheckSummary")
    goal: Optional[str] = None
    judge_enabled: Optional[bool] = Field(default=None, alias="judgeEnabled")
    created_at: str = Field(alias="createdAt")
    updated_at: str = Field(alias="updatedAt")


class MonitorMeaningfulChange(BaseModel):
    type: Literal["added", "removed", "changed"]
    before: Optional[str] = None
    after: Optional[str] = None
    reason: str


class MonitorPageJudgment(BaseModel):
    model_config = {"populate_by_name": True}

    meaningful: bool
    confidence: Literal["high", "medium", "low"]
    reason: str
    meaningful_changes: List[MonitorMeaningfulChange] = Field(default_factory=list, alias="meaningfulChanges")


class MonitorTargetResult(BaseModel):
    model_config = {"populate_by_name": True, "extra": "allow"}

    target_id: str = Field(alias="targetId")
    type: Literal["scrape", "crawl", "search"]
    expected_jobs: Optional[List[str]] = Field(default=None, alias="expectedJobs")
    crawl_id: Optional[str] = Field(default=None, alias="crawlId")
    search_completed: Optional[bool] = Field(default=None, alias="searchCompleted")
    result_count: Optional[int] = Field(default=None, alias="resultCount")
    matches: Optional[int] = None
    summary: Optional[str] = None
    judge_degraded: Optional[bool] = Field(default=None, alias="judgeDegraded")
    degraded_reason: Optional[str] = Field(default=None, alias="degradedReason")
    search_credits: Optional[int] = Field(default=None, alias="searchCredits")
    judge_credits: Optional[int] = Field(default=None, alias="judgeCredits")
    results_judged: Optional[int] = Field(default=None, alias="resultsJudged")


class MonitorCheck(BaseModel):
    model_config = {"populate_by_name": True, "extra": "allow"}

    id: str
    monitor_id: str = Field(alias="monitorId")
    status: Literal["queued", "running", "completed", "failed", "partial", "skipped_overlap", "skipped_no_credits"]
    trigger: Literal["scheduled", "manual"]
    scheduled_for: Optional[str] = Field(default=None, alias="scheduledFor")
    started_at: Optional[str] = Field(default=None, alias="startedAt")
    finished_at: Optional[str] = Field(default=None, alias="finishedAt")
    estimated_credits: Optional[int] = Field(default=None, alias="estimatedCredits")
    reserved_credits: Optional[int] = Field(default=None, alias="reservedCredits")
    actual_credits: Optional[int] = Field(default=None, alias="actualCredits")
    billing_status: Literal["not_applicable", "reserved", "confirmed", "released", "failed"] = Field(alias="billingStatus")
    summary: MonitorSummary
    target_results: Optional[List[MonitorTargetResult]] = Field(default=None, alias="targetResults")
    notification_status: Optional[Any] = Field(default=None, alias="notificationStatus")
    error: Optional[str] = None
    created_at: str = Field(alias="createdAt")
    updated_at: str = Field(alias="updatedAt")


class MonitorPageDiff(BaseModel):
    """Diff payload returned alongside a monitor page.

    Markdown-only monitors populate both `text` (unified diff) and `json`
    (the parseDiff AST). JSON-extraction monitors populate `json` only,
    where `json` is the per-field `{previous, current}` map. Mixed-mode
    monitors (JSON + git-diff) populate both `json` (field diff) and
    `text` (markdown sidecar).
    """
    model_config = {"populate_by_name": True, "extra": "allow"}

    text: Optional[str] = None
    json: Optional[Any] = None  # markdown→parseDiff AST | json→field diff


class MonitorPageSnapshot(BaseModel):
    """Current JSON extraction at this run. JSON / mixed mode only."""
    model_config = {"populate_by_name": True, "extra": "allow"}

    json: Optional[Dict[str, Any]] = None


class MonitorCheckPage(BaseModel):
    model_config = {"populate_by_name": True, "extra": "allow"}

    id: str
    target_id: str = Field(alias="targetId")
    url: str
    status: Literal["same", "new", "changed", "removed", "error"]
    previous_scrape_id: Optional[str] = Field(default=None, alias="previousScrapeId")
    current_scrape_id: Optional[str] = Field(default=None, alias="currentScrapeId")
    status_code: Optional[int] = Field(default=None, alias="statusCode")
    error: Optional[str] = None
    metadata: Optional[Any] = None
    diff: Optional[MonitorPageDiff] = None
    snapshot: Optional[MonitorPageSnapshot] = None
    judgment: Optional[MonitorPageJudgment] = None
    created_at: str = Field(alias="createdAt")


class MonitorCheckDetail(MonitorCheck):
    pages: List[MonitorCheckPage] = []
    next: Optional[str] = None


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
    warnings: Optional[List[str]] = None
    replacement: Optional[str] = None
    sources: Optional[Dict[str, Any]] = None
    expires_at: Optional[datetime] = None
    credits_used: Optional[int] = None
    tokens_used: Optional[int] = None


class AgentExchangeOptions(BaseModel):
    """Options forwarded verbatim to the agent; the server owns every default."""

    model_config = {"populate_by_name": True}

    enabled: Optional[bool] = None
    # At most 5.
    toolkits: Optional[List[str]] = None
    max_calls: Optional[int] = Field(default=None, alias="maxCalls")
    require_approval: Optional[bool] = Field(default=None, alias="requireApproval")
    # Answers a pending_approval from the previous turn of the thread.
    approve: Optional[Dict[str, Any]] = None
    decline: Optional[Dict[str, Any]] = None


class AgentExchangeSummary(BaseModel):
    """Per-run summary reported on a status response."""

    model_config = {"populate_by_name": True, "extra": "allow"}

    enabled: Optional[bool] = None
    # What the run resolved to after thread inheritance, not what it requested.
    toolkits: Optional[List[str]] = None
    require_approval: Optional[bool] = Field(default=None, alias="requireApproval")
    paid_calls: Optional[int] = Field(default=None, alias="paidCalls")
    credits_used: Optional[int] = Field(default=None, alias="creditsUsed")


class AgentSuggestion(BaseModel):
    """A follow-up the agent offers for the next turn of the thread."""

    model_config = {"populate_by_name": True, "extra": "allow"}

    label: Optional[str] = None
    prompt: Optional[str] = None


class PendingApprovalCall(BaseModel):
    """One call held back by a pending approval."""

    model_config = {"populate_by_name": True, "extra": "allow"}

    id: Optional[str] = None
    provider: Optional[str] = None
    capability: Optional[str] = None
    input: Optional[Dict[str, Any]] = None
    more: Optional[List[Dict[str, Any]]] = None
    credits_estimate: Optional[int] = Field(default=None, alias="creditsEstimate")


class PendingApprovalResolution(BaseModel):
    """How a pending approval was answered by a later turn."""

    model_config = {"populate_by_name": True, "extra": "allow"}

    approved: Optional[bool] = None
    call_ids: Optional[List[str]] = Field(default=None, alias="callIds")
    always: Optional[bool] = None
    by_run_id: Optional[str] = Field(default=None, alias="byRunId")


class PendingApproval(BaseModel):
    """A turn that ended waiting for the caller to allow or refuse paid calls."""

    model_config = {"populate_by_name": True, "extra": "allow"}

    id: Optional[str] = None
    reason: Optional[str] = None
    calls: Optional[List[PendingApprovalCall]] = None
    resolution: Optional[PendingApprovalResolution] = None


class AgentResponse(BaseModel):
    """Response for agent operations (start/status/final)."""

    model_config = {"populate_by_name": True}

    success: Optional[bool] = None
    id: Optional[str] = None
    status: Optional[Literal["processing", "completed", "failed"]] = None
    data: Optional[Any] = None
    error: Optional[str] = None
    # Deliberately a plain str, not a Literal: this is server-provided and new
    # models ship without an SDK release, so a narrow type turns an unknown
    # model name into a ValidationError on every status poll.
    model: Optional[str] = None
    # Reasoning effort the job ran with; only set for runs that specified it.
    effort: Optional[Literal["low", "medium", "high"]] = None
    expires_at: Optional[datetime] = None
    credits_used: Optional[int] = None
    # Thread this run belongs to; pass it back to continue the conversation.
    thread_id: Optional[str] = Field(default=None, alias="threadId")
    # 1-based position of this run in its thread.
    thread_turn: Optional[int] = Field(default=None, alias="threadTurn")
    mode: Optional[Literal["extract", "chat"]] = None
    # Assistant text reply. Chat-mode runs answer here instead of in `data`.
    message: Optional[str] = None
    suggestions: Optional[List[AgentSuggestion]] = None
    pending_approval: Optional[PendingApproval] = Field(
        default=None, alias="pendingApproval"
    )
    exchange: Optional[AgentExchangeSummary] = None


class AgentListItemSettings(BaseModel):
    """Per-session settings attached to an agent run."""

    model_config = {"populate_by_name": True}

    hidden: bool = False
    starred: bool = False
    label: Optional[str] = None


class AgentListItemOptions(BaseModel):
    """Options an agent run was started with."""

    model_config = {"populate_by_name": True}

    urls: Optional[List[str]] = None
    prompt: str = ""
    schema: Optional[Any] = None
    # Plain str, not a Literal: server-provided, and new models ship without an
    # SDK release (see AgentResponse.model).
    model: Optional[str] = None
    effort: Optional[Literal["low", "medium", "high"]] = None


class AgentListItem(BaseModel):
    """A single agent run as returned by the agent list endpoint."""

    model_config = {"populate_by_name": True}

    id: str
    created_at: str = Field(alias="createdAt")
    target_hint: str = Field(alias="targetHint")
    origin: str = "api"
    integration: Optional[str] = None
    settings: AgentListItemSettings = Field(default_factory=AgentListItemSettings)
    status: Optional[Literal["processing", "completed", "failed"]] = None
    options: Optional[AgentListItemOptions] = None


class AgentListResponse(BaseModel):
    """Response from GET /v2/agent (list agent runs)."""

    success: Optional[bool] = None
    agents: Optional[List[AgentListItem]] = None
    # Absolute URL of the next page; only present when more pages exist.
    next: Optional[str] = None
    error: Optional[str] = None


class AgentThreadRun(BaseModel):
    """A single run of a thread, as returned by get_agent_thread."""

    model_config = {"populate_by_name": True, "extra": "allow"}

    id: Optional[str] = None
    turn: Optional[int] = None
    mode: Optional[Literal["extract", "chat"]] = None
    prompt: Optional[str] = None
    urls: Optional[List[str]] = None
    # Trailing underscore because `schema` shadows a BaseModel attribute.
    schema_: Optional[Any] = Field(default=None, alias="schema")
    effort: Optional[Literal["low", "medium", "high"]] = None
    # Plain str, not a Literal: the run vocabulary is server-owned.
    status: Optional[str] = None
    created_at: Optional[str] = Field(default=None, alias="createdAt")
    finished_at: Optional[str] = Field(default=None, alias="finishedAt")
    credits_used: Optional[int] = Field(default=None, alias="creditsUsed")
    message: Optional[str] = None
    # Only present when the request asked for include_data.
    data: Optional[Any] = None
    suggestions: Optional[List[AgentSuggestion]] = None
    pending_approval: Optional[PendingApproval] = Field(
        default=None, alias="pendingApproval"
    )
    exchange: Optional[AgentExchangeSummary] = None


class AgentThread(BaseModel):
    """A thread and its runs, oldest turn first."""

    model_config = {"populate_by_name": True, "extra": "allow"}

    id: Optional[str] = None
    created_at: Optional[str] = Field(default=None, alias="createdAt")
    updated_at: Optional[str] = Field(default=None, alias="updatedAt")
    status: Optional[Literal["idle", "running"]] = None
    runs: Optional[List[AgentThreadRun]] = None


class AgentThreadResponse(BaseModel):
    """Response from GET /v2/agent/threads/{thread_id}."""

    model_config = {"populate_by_name": True}

    success: Optional[bool] = None
    thread: Optional[AgentThread] = None
    error: Optional[str] = None


# Agent trace types (GET /v2/agent/{job_id}/trace).
# These mirror the agent service's canonical event schema (schemaVersion 1):
# usage.recorded events are withheld server-side and agent.started carries no
# model name.


class AgentTraceAgentIdentity(BaseModel):
    """Which agent produced a trace event."""

    model_config = {"populate_by_name": True}

    id: str
    role: Literal["orchestrator", "subagent", "browser", "system"]
    name: str
    parent_id: Optional[str] = Field(default=None, alias="parentId")


class AgentTraceError(BaseModel):
    """Structured error attached to terminal/error trace events."""

    code: Literal[
        "cancelled", "credit_limit_reached", "parent_finished", "refused", "internal"
    ]
    source: Literal["agent", "tool", "billing", "system"]
    retryable: bool
    message: str


class AgentTraceArtifactChange(BaseModel):
    """Reference to an artifact snapshot; fetch content via get_agent_snapshot."""

    model_config = {"populate_by_name": True}

    kind: Literal["json", "markdown", "html", "screenshot", "text"]
    artifact_id: str = Field(alias="artifactId")
    path: Optional[str] = None
    snapshot_id: str = Field(alias="snapshotId")
    change: Literal["init", "partial", "append", "modify", "update"]
    changed_fields: Optional[List[str]] = Field(default=None, alias="changedFields")
    item_count: Optional[int] = Field(default=None, alias="itemCount")
    source_tool_call_id: Optional[str] = Field(default=None, alias="sourceToolCallId")


class AgentTraceEventBase(BaseModel):
    """Fields every trace event carries."""

    model_config = {"populate_by_name": True}

    schema_version: Literal[1] = Field(alias="schemaVersion")
    event_id: str = Field(alias="eventId")
    run_id: str = Field(alias="runId")
    occurred_at: datetime = Field(alias="occurredAt")
    producer_sequence: int = Field(alias="producerSequence")
    agent: AgentTraceAgentIdentity


class AgentTraceRunStartedEvent(AgentTraceEventBase):
    type: Literal["run.started"]


class AgentTraceRunCancelRequestedEvent(AgentTraceEventBase):
    type: Literal["run.cancel_requested"]
    reason: Literal["user"]


class AgentTraceRunFinishedEvent(AgentTraceEventBase):
    type: Literal["run.finished"]
    outcome: Literal["succeeded", "failed", "cancelled", "refused", "credit_limit_reached"]
    # The canonical schema always writes this key (nullable), but default it so
    # a trace with the key absent still parses instead of raising.
    error: Optional[AgentTraceError] = None


class AgentTraceAgentStartedEvent(AgentTraceEventBase):
    type: Literal["agent.started"]


class AgentTraceAgentFinishedEvent(AgentTraceEventBase):
    type: Literal["agent.finished"]
    outcome: Literal["succeeded", "failed", "cancelled", "refused"]
    duration_ms: int = Field(alias="durationMs")
    # See AgentTraceRunFinishedEvent.error for why this has a default.
    error: Optional[AgentTraceError] = None


class AgentTraceBrowserSessionStartedEvent(AgentTraceEventBase):
    type: Literal["browser.session.started"]
    session_id: str = Field(alias="sessionId")


class AgentTraceBrowserSessionFinishedEvent(AgentTraceEventBase):
    type: Literal["browser.session.finished"]
    session_id: str = Field(alias="sessionId")
    duration_ms: int = Field(alias="durationMs")


class AgentTraceProgressReportedEvent(AgentTraceEventBase):
    type: Literal["progress.reported"]
    phase: Literal["planning", "working", "finalizing"]
    message: str


class AgentTraceReasoningSummaryEvent(AgentTraceEventBase):
    type: Literal["reasoning.summary"]
    text: str


class AgentTraceToolCallStartedEvent(AgentTraceEventBase):
    type: Literal["tool_call.started"]
    tool_call_id: str = Field(alias="toolCallId")
    tool_name: str = Field(alias="toolName")
    # Required key on the wire (zod `.json()`), values may be null: Field(...)
    # keeps the key required so a malformed event cannot silently pass.
    parameters: Any = Field(...)


class AgentTraceToolCallFinishedEvent(AgentTraceEventBase):
    type: Literal["tool_call.finished"]
    tool_call_id: str = Field(alias="toolCallId")
    tool_name: str = Field(alias="toolName")
    # See AgentTraceToolCallStartedEvent.parameters.
    result: Any = Field(...)


class AgentTraceArtifactUpdatedEvent(AgentTraceEventBase):
    type: Literal["artifact.updated"]
    artifact: AgentTraceArtifactChange


class AgentTraceErrorOccurredEvent(AgentTraceEventBase):
    type: Literal["error.occurred"]
    error: AgentTraceError


# Discriminated on the wire's `type` tag so generated schemas expose the
# discriminator and validation dispatches on it directly.
AgentTraceEvent = Annotated[
    Union[
        AgentTraceRunStartedEvent,
        AgentTraceRunCancelRequestedEvent,
        AgentTraceRunFinishedEvent,
        AgentTraceAgentStartedEvent,
        AgentTraceAgentFinishedEvent,
        AgentTraceBrowserSessionStartedEvent,
        AgentTraceBrowserSessionFinishedEvent,
        AgentTraceProgressReportedEvent,
        AgentTraceReasoningSummaryEvent,
        AgentTraceToolCallStartedEvent,
        AgentTraceToolCallFinishedEvent,
        AgentTraceArtifactUpdatedEvent,
        AgentTraceErrorOccurredEvent,
    ],
    Field(discriminator="type"),
]


class AgentTraceViewport(BaseModel):
    width: int
    height: int


class AgentTraceActiveBrowserSession(BaseModel):
    """Live browser session, present only when trace is requested with live_view."""

    model_config = {"populate_by_name": True}

    id: str
    live_view_url: str = Field(alias="liveViewUrl")
    viewport: AgentTraceViewport


class AgentTraceResponse(BaseModel):
    """Response from GET /v2/agent/{job_id}/trace."""

    model_config = {"populate_by_name": True}

    success: Optional[bool] = None
    id: Optional[str] = None
    events: Optional[List[AgentTraceEvent]] = None
    credits_used: Optional[int] = Field(default=None, alias="creditsUsed")
    active_browser_sessions: Optional[List[AgentTraceActiveBrowserSession]] = Field(
        default=None, alias="activeBrowserSessions"
    )
    error: Optional[str] = None


class AgentSnapshotResponse(BaseModel):
    """Response from GET /v2/agent/{job_id}/snapshots/{snapshot_id}."""

    model_config = {"populate_by_name": True}

    success: Optional[bool] = None
    id: Optional[str] = None
    snapshot_id: Optional[str] = Field(default=None, alias="snapshotId")
    snapshot: Optional[str] = None
    error: Optional[str] = None


# Browser types
class BrowserCreateResponse(BaseModel):
    """Response from creating a browser session."""

    success: bool
    id: Optional[str] = None
    cdp_url: Optional[str] = None
    live_view_url: Optional[str] = None
    interactive_live_view_url: Optional[str] = None
    expires_at: Optional[str] = None
    error: Optional[str] = None


class BrowserExecuteResponse(BaseModel):
    """Response from executing code in a browser session."""

    success: bool
    cdp_url: Optional[str] = None
    live_view_url: Optional[str] = None
    interactive_live_view_url: Optional[str] = None
    output: Optional[str] = None
    stdout: Optional[str] = None
    result: Optional[str] = None
    stderr: Optional[str] = None
    exit_code: Optional[int] = None
    killed: Optional[bool] = None
    error: Optional[str] = None


class BrowserDeleteResponse(BaseModel):
    """Response from deleting a browser session."""

    success: bool
    session_duration_ms: Optional[int] = None
    credits_billed: Optional[int] = None
    error: Optional[str] = None


class BrowserSession(BaseModel):
    """Information about a browser session."""

    id: str
    status: str
    cdp_url: str
    live_view_url: str
    interactive_live_view_url: Optional[str] = None
    stream_web_view: bool
    created_at: str
    last_activity: str


class BrowserListResponse(BaseModel):
    """Response from listing browser sessions."""

    success: bool
    sessions: Optional[List["BrowserSession"]] = None
    error: Optional[str] = None


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
    format: Optional[
        Literal[
            "A0",
            "A1",
            "A2",
            "A3",
            "A4",
            "A5",
            "A6",
            "Letter",
            "Legal",
            "Tabloid",
            "Ledger",
        ]
    ] = None
    landscape: Optional[bool] = None
    scale: Optional[float] = None


class PDFParser(BaseModel):
    """PDF parser configuration with optional page limit and processing mode."""

    type: Literal["pdf"] = "pdf"
    mode: Optional[Literal["fast", "auto", "ocr"]] = None
    max_pages: Optional[int] = None
    pages: Optional[bool] = None
    blocks: Optional[bool] = None
    # Join PDF pages in document markdown with `\n\n---\n\n<!-- page N -->\n\n`
    # (N = 1-based physical page of the content that follows). Markers appear
    # between pages only, and numbering may skip pages merged by cross-page
    # stitching — use `pages=True` when every physical page is needed.
    page_markers: Optional[bool] = None

    @model_validator(mode="before")
    @classmethod
    def _fold_deprecated_page_markdown(cls, data: Any) -> Any:
        """Accept the pre-rename pageMarkdown alias and fold it into pages."""
        if not isinstance(data, dict):
            return data
        folded = dict(data)
        alias = folded.pop("page_markdown", None)
        if alias is None:
            alias = folded.pop("pageMarkdown", None)
        if folded.get("pages") is None and alias is not None:
            folded["pages"] = alias
        return folded


# Location types
class Location(BaseModel):
    """Location configuration for scraping."""

    country: Optional[str] = None
    languages: Optional[List[str]] = None


DeveloperSearchType = Literal["doc", "issue", "pull_request", "readme"]


class DeveloperSearchRequest(BaseModel):
    """Request for the dedicated developer-search endpoint."""

    query: str
    k: Optional[int] = Field(default=None, ge=1, le=100)
    passages: Optional[int] = Field(default=None, ge=1, le=5)
    types: Optional[List[DeveloperSearchType]] = Field(default=None, max_length=4)
    repos: Optional[List[str]] = Field(default=None, max_length=20)
    sources: Optional[List[str]] = Field(default=None, max_length=20)
    language: Optional[str] = None
    topic: Optional[List[str]] = Field(default=None, max_length=8)
    license: Optional[str] = None
    min_stars: Optional[int] = Field(default=None, ge=0)
    max_stars: Optional[int] = Field(default=None, ge=0)
    archived: Optional[bool] = None
    fork: Optional[bool] = None
    skills: Optional[Literal["only"]] = None


class DeveloperSearchLicenseDisclosure(BaseModel):
    """Repository license disclosure returned by developer search."""

    state: Literal["licensed", "known_absent", "unknown"]
    spdx_id: Optional[str] = None


class DeveloperSearchPassage(BaseModel):
    text: str
    citation_url: Optional[str] = None


class DeveloperSearchResult(BaseModel):
    id: str
    url: str
    title: Optional[str] = None
    passages: List[DeveloperSearchPassage]
    # Accept both shapes while the API flattens license objects to SPDX strings.
    license: Optional[Union[DeveloperSearchLicenseDisclosure, str]] = None


class DeveloperSearchRepoTypes(BaseModel):
    model_config = {"populate_by_name": True}

    issue: bool
    pull_request: bool = Field(alias="pullRequest")
    readme: bool


class DeveloperSearchRepoStatus(BaseModel):
    repo: str
    indexed: bool
    types: DeveloperSearchRepoTypes


class DeveloperSearchSourceStatus(BaseModel):
    source: str
    indexed: bool


class DeveloperSearchResponse(BaseModel):
    success: bool
    results: List[DeveloperSearchResult]
    repos: Optional[List[DeveloperSearchRepoStatus]] = None
    sources: Optional[List[DeveloperSearchSourceStatus]] = None


class SearchRequest(BaseModel):
    """Request for search operations."""

    query: str
    sources: Optional[List[SourceOption]] = None
    categories: Optional[List[CategoryOption]] = None
    include_domains: Optional[List[str]] = None
    exclude_domains: Optional[List[str]] = None
    limit: Optional[int] = 5
    tbs: Optional[str] = None
    location: Optional[str] = None
    ignore_invalid_urls: Optional[bool] = None
    timeout: Optional[int] = 300000
    highlights: Optional[bool] = None
    scrape_options: Optional[ScrapeOptions] = None
    # Enterprise search options. Use ["zdr"] for end-to-end Zero Data
    # Retention or ["anon"] for anonymized search. Must be enabled for your team.
    enterprise: Optional[List[str]] = None
    threat_protection: Optional[ThreatProtectionOptions] = None
    integration: Optional[str] = None

    @field_validator("sources")
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

    @field_validator("categories")
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

    @model_validator(mode="after")
    def validate_domain_filters(self):
        """Validate mutually exclusive search domain filters."""
        if self.include_domains and self.exclude_domains:
            raise ValueError(
                "include_domains and exclude_domains cannot both be specified"
            )
        return self

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

    @property
    def data(self):
        parts = []
        if self.web:
            parts.append(f".web ({len(self.web)} results)")
        if self.news:
            parts.append(f".news ({len(self.news)} results)")
        if self.images:
            parts.append(f".images ({len(self.images)} results)")
        available = ", ".join(parts) if parts else ".web, .news, or .images"
        raise AttributeError(
            f"SearchData has no '.data'. Results are grouped by source: {available}"
        )


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

    api_key: Optional[str] = None
    api_url: str = "https://api.firecrawl.dev"
    timeout: Optional[float] = None
    max_retries: int = 3
    backoff_factor: float = 0.5


class PaginationConfig(BaseModel):
    """Configuration for pagination behavior."""

    auto_paginate: bool = True
    max_pages: Optional[int] = Field(default=None, ge=0)
    max_results: Optional[int] = Field(default=None, ge=0)
    max_wait_time: Optional[int] = Field(default=None, ge=0)  # seconds


# Response union types
AnyResponse = Union[
    ScrapeResponse,
    CrawlResponse,
    BatchScrapeResponse,
    MapResponse,
    SearchResponse,
    ErrorResponse,
]
