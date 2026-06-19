//! Type definitions for Firecrawl API v2.

use serde::{de, Deserialize, Deserializer, Serialize, Serializer};
use serde_json::Value;
use std::collections::HashMap;

use crate::serde_helpers::deserialize_string_or_array;

/// Available output formats for scraping operations.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Format {
    /// Markdown content of the page.
    Markdown,
    /// Filtered, content-only HTML.
    Html,
    /// Original, untouched HTML.
    RawHtml,
    /// List of URLs found on the page.
    Links,
    /// List of image URLs found on the page.
    Images,
    /// Screenshot of the visible viewport.
    Screenshot,
    /// AI-generated summary of the page content.
    Summary,
    /// Change tracking information.
    ChangeTracking,
    /// Structured JSON extraction via LLM.
    Json,
    /// Custom attribute extraction.
    Attributes,
    /// Brand analysis of the page.
    Branding,
    /// Product extraction from the page.
    Product,
    /// Menu extraction from the page.
    Menu,
    /// Audio extraction (MP3) from YouTube videos.
    Audio,
    /// Video extraction from supported video URLs.
    Video,
    /// Question answer generated from the page content.
    Question(QuestionFormat),
    /// Direct highlights selected from the page content.
    Highlights(HighlightsFormat),
    /// Deprecated query answer generated from the page content.
    Query(QueryFormat),
}

impl Serialize for Format {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        match self {
            Format::Markdown => serializer.serialize_str("markdown"),
            Format::Html => serializer.serialize_str("html"),
            Format::RawHtml => serializer.serialize_str("rawHtml"),
            Format::Links => serializer.serialize_str("links"),
            Format::Images => serializer.serialize_str("images"),
            Format::Screenshot => serializer.serialize_str("screenshot"),
            Format::Summary => serializer.serialize_str("summary"),
            Format::ChangeTracking => serializer.serialize_str("changeTracking"),
            Format::Json => serializer.serialize_str("json"),
            Format::Attributes => serializer.serialize_str("attributes"),
            Format::Branding => serializer.serialize_str("branding"),
            Format::Product => serializer.serialize_str("product"),
            Format::Menu => serializer.serialize_str("menu"),
            Format::Audio => serializer.serialize_str("audio"),
            Format::Video => serializer.serialize_str("video"),
            Format::Question(question) => question.serialize(serializer),
            Format::Highlights(highlights) => highlights.serialize(serializer),
            Format::Query(query) => query.serialize(serializer),
        }
    }
}

impl<'de> Deserialize<'de> for Format {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = Value::deserialize(deserializer)?;
        match value {
            Value::String(format) => match format.as_str() {
                "markdown" => Ok(Format::Markdown),
                "html" => Ok(Format::Html),
                "rawHtml" => Ok(Format::RawHtml),
                "links" => Ok(Format::Links),
                "images" => Ok(Format::Images),
                "screenshot" => Ok(Format::Screenshot),
                "summary" => Ok(Format::Summary),
                "changeTracking" => Ok(Format::ChangeTracking),
                "json" => Ok(Format::Json),
                "attributes" => Ok(Format::Attributes),
                "branding" => Ok(Format::Branding),
                "product" => Ok(Format::Product),
                "menu" => Ok(Format::Menu),
                "audio" => Ok(Format::Audio),
                "video" => Ok(Format::Video),
                _ => Err(de::Error::custom(format!("unknown format: {}", format))),
            },
            Value::Object(_) => match value.get("type").and_then(Value::as_str) {
                Some("question") => QuestionFormat::deserialize(value)
                    .map(Format::Question)
                    .map_err(de::Error::custom),
                Some("highlights") => HighlightsFormat::deserialize(value)
                    .map(Format::Highlights)
                    .map_err(de::Error::custom),
                Some("query") => QueryFormat::deserialize(value)
                    .map(Format::Query)
                    .map_err(de::Error::custom),
                Some(format_type) => Err(de::Error::custom(format!(
                    "unknown object format: {}",
                    format_type
                ))),
                None => Err(de::Error::custom("object format must have a type")),
            },
            _ => Err(de::Error::custom("format must be a string or object")),
        }
    }
}

/// Question format for asking a question about page content.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct QuestionFormat {
    pub question: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct QuestionFormatWire {
    #[serde(rename = "type")]
    format_type: String,
    question: String,
}

impl Serialize for QuestionFormat {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        QuestionFormatWire {
            format_type: "question".to_string(),
            question: self.question.clone(),
        }
        .serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for QuestionFormat {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let wire = QuestionFormatWire::deserialize(deserializer)?;
        if wire.format_type != "question" {
            return Err(de::Error::custom(
                "question format object must have type question",
            ));
        }

        Ok(Self {
            question: wire.question,
        })
    }
}

/// Highlights format for selecting direct highlights from page content.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HighlightsFormat {
    pub query: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct HighlightsFormatWire {
    #[serde(rename = "type")]
    format_type: String,
    query: String,
}

impl Serialize for HighlightsFormat {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        HighlightsFormatWire {
            format_type: "highlights".to_string(),
            query: self.query.clone(),
        }
        .serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for HighlightsFormat {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let wire = HighlightsFormatWire::deserialize(deserializer)?;
        if wire.format_type != "highlights" {
            return Err(de::Error::custom(
                "highlights format object must have type highlights",
            ));
        }

        Ok(Self { query: wire.query })
    }
}

/// Deprecated query format for asking a question about page content.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct QueryFormat {
    pub prompt: String,
    pub mode: Option<QueryFormatMode>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct QueryFormatWire {
    #[serde(rename = "type")]
    format_type: String,
    prompt: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    mode: Option<QueryFormatMode>,
}

impl Serialize for QueryFormat {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        QueryFormatWire {
            format_type: "query".to_string(),
            prompt: self.prompt.clone(),
            mode: self.mode,
        }
        .serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for QueryFormat {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let wire = QueryFormatWire::deserialize(deserializer)?;
        if wire.format_type != "query" {
            return Err(de::Error::custom(
                "query format object must have type query",
            ));
        }

        Ok(Self {
            prompt: wire.prompt,
            mode: wire.mode,
        })
    }
}

/// Query answer mode.
#[derive(Deserialize, Serialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum QueryFormatMode {
    #[serde(rename = "freeform")]
    Freeform,
    #[serde(rename = "directQuote")]
    DirectQuote,
}

/// Viewport dimensions for screenshots.
#[serde_with::skip_serializing_none]
#[derive(Deserialize, Serialize, Debug, Default, Clone)]
pub struct Viewport {
    pub width: u32,
    pub height: u32,
}

/// Screenshot format options.
#[serde_with::skip_serializing_none]
#[derive(Deserialize, Serialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ScreenshotOptions {
    /// Take a full-page screenshot instead of just the visible viewport.
    pub full_page: Option<bool>,
    /// Quality of the screenshot (1-100).
    pub quality: Option<u8>,
    /// Custom viewport dimensions.
    pub viewport: Option<Viewport>,
}

/// Change tracking format options.
#[serde_with::skip_serializing_none]
#[derive(Deserialize, Serialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ChangeTrackingOptions {
    /// Modes for change tracking output.
    pub modes: Option<Vec<ChangeTrackingMode>>,
    /// JSON schema for structured change output.
    pub schema: Option<Value>,
    /// Prompt for LLM-based change analysis.
    pub prompt: Option<String>,
    /// Tag to identify this tracking session.
    pub tag: Option<String>,
}

/// Available change tracking modes.
#[derive(Deserialize, Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ChangeTrackingMode {
    GitDiff,
    Json,
}

/// Attribute extraction selector.
#[serde_with::skip_serializing_none]
#[derive(Deserialize, Serialize, Debug, Default, Clone)]
pub struct AttributeSelector {
    /// CSS selector for the element.
    pub selector: String,
    /// Attribute name to extract.
    pub attribute: String,
}

/// JSON extraction options.
#[serde_with::skip_serializing_none]
#[derive(Deserialize, Serialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct JsonOptions {
    /// JSON schema the output should adhere to.
    pub schema: Option<Value>,
    /// System prompt for the LLM agent.
    pub system_prompt: Option<String>,
    /// Extraction prompt for the LLM agent.
    pub prompt: Option<String>,
}

/// Location configuration for proxy routing.
#[serde_with::skip_serializing_none]
#[derive(Deserialize, Serialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LocationConfig {
    /// Country code (ISO 3166-1 alpha-2).
    pub country: Option<String>,
    /// List of preferred language codes.
    pub languages: Option<Vec<String>>,
}

/// Persistent browser profile for maintaining state across scrapes.
#[serde_with::skip_serializing_none]
#[derive(Deserialize, Serialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProfileConfig {
    /// Profile name (1–128 characters).
    pub name: String,
    /// Whether to persist changes made during the session (defaults to true).
    pub save_changes: Option<bool>,
}

/// Proxy type for scraping.
#[derive(Deserialize, Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ProxyType {
    Basic,
    Stealth,
    Enhanced,
    Auto,
}

/// Browser action types for automation.
#[derive(Deserialize, Serialize, Debug, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Action {
    /// Wait for a specified time or element.
    Wait {
        /// Milliseconds to wait.
        #[serde(skip_serializing_if = "Option::is_none")]
        milliseconds: Option<u32>,
        /// CSS selector to wait for.
        #[serde(skip_serializing_if = "Option::is_none")]
        selector: Option<String>,
    },
    /// Take a screenshot.
    Screenshot {
        #[serde(skip_serializing_if = "Option::is_none")]
        full_page: Option<bool>,
        #[serde(skip_serializing_if = "Option::is_none")]
        quality: Option<u8>,
        #[serde(skip_serializing_if = "Option::is_none")]
        viewport: Option<Viewport>,
    },
    /// Click an element.
    Click {
        /// CSS selector of the element to click.
        selector: String,
    },
    /// Write text to the focused input.
    Write {
        /// Text to write.
        text: String,
    },
    /// Press a keyboard key.
    Press {
        /// Key name to press.
        key: String,
    },
    /// Scroll the page.
    Scroll {
        /// Direction to scroll.
        direction: ScrollDirection,
        /// Optional selector to scroll within.
        #[serde(skip_serializing_if = "Option::is_none")]
        selector: Option<String>,
    },
    /// Trigger a scrape action.
    Scrape,
    /// Execute custom JavaScript.
    #[serde(rename = "executeJavascript")]
    ExecuteJavascript {
        /// JavaScript code to execute.
        script: String,
    },
    /// Generate a PDF.
    Pdf {
        #[serde(skip_serializing_if = "Option::is_none")]
        format: Option<PdfFormat>,
        #[serde(skip_serializing_if = "Option::is_none")]
        landscape: Option<bool>,
        #[serde(skip_serializing_if = "Option::is_none")]
        scale: Option<f32>,
    },
}

/// Scroll direction for scroll actions.
#[derive(Deserialize, Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ScrollDirection {
    Up,
    Down,
}

/// PDF format options.
#[derive(Deserialize, Serialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum PdfFormat {
    A0,
    A1,
    A2,
    A3,
    A4,
    A5,
    A6,
    Letter,
    Legal,
    Tabloid,
    Ledger,
}

/// Webhook configuration for async operations.
#[serde_with::skip_serializing_none]
#[derive(Deserialize, Serialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WebhookConfig {
    /// URL to send webhook notifications to.
    pub url: String,
    /// Custom headers to include in webhook requests.
    pub headers: Option<HashMap<String, String>>,
    /// Custom metadata to include in webhook payloads.
    pub metadata: Option<HashMap<String, String>>,
    /// Event types to receive notifications for.
    pub events: Option<Vec<WebhookEvent>>,
}

impl From<String> for WebhookConfig {
    fn from(url: String) -> Self {
        Self {
            url,
            ..Default::default()
        }
    }
}

impl From<&str> for WebhookConfig {
    fn from(url: &str) -> Self {
        Self {
            url: url.to_string(),
            ..Default::default()
        }
    }
}

/// Webhook event types for crawl/batch operations.
#[derive(Deserialize, Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum WebhookEvent {
    Completed,
    Failed,
    Page,
    Started,
}

/// Agent-specific webhook event types.
#[derive(Deserialize, Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AgentWebhookEvent {
    Started,
    Action,
    Completed,
    Failed,
    Cancelled,
}

/// Agent webhook configuration.
#[serde_with::skip_serializing_none]
#[derive(Deserialize, Serialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgentWebhookConfig {
    /// URL to send webhook notifications to.
    pub url: String,
    /// Custom headers to include in webhook requests.
    pub headers: Option<HashMap<String, String>>,
    /// Custom metadata to include in webhook payloads.
    pub metadata: Option<HashMap<String, String>>,
    /// Event types to receive notifications for.
    pub events: Option<Vec<AgentWebhookEvent>>,
}

impl From<String> for AgentWebhookConfig {
    fn from(url: String) -> Self {
        Self {
            url,
            ..Default::default()
        }
    }
}

impl From<&str> for AgentWebhookConfig {
    fn from(url: &str) -> Self {
        Self {
            url: url.to_string(),
            ..Default::default()
        }
    }
}

/// Document metadata returned from scrape operations.
#[serde_with::skip_serializing_none]
#[derive(Deserialize, Serialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DocumentMetadata {
    // Firecrawl specific
    #[serde(rename = "sourceURL")]
    pub source_url: Option<String>,
    pub status_code: Option<u16>,
    pub error: Option<String>,

    // Basic meta tags
    #[serde(default, deserialize_with = "deserialize_string_or_array")]
    pub title: Option<String>,
    #[serde(default, deserialize_with = "deserialize_string_or_array")]
    pub description: Option<String>,
    #[serde(default, deserialize_with = "deserialize_string_or_array")]
    pub language: Option<String>,
    #[serde(default, deserialize_with = "deserialize_string_or_array")]
    pub keywords: Option<String>,
    #[serde(default, deserialize_with = "deserialize_string_or_array")]
    pub robots: Option<String>,

    // OpenGraph namespace
    #[serde(default, deserialize_with = "deserialize_string_or_array")]
    pub og_title: Option<String>,
    #[serde(default, deserialize_with = "deserialize_string_or_array")]
    pub og_description: Option<String>,
    #[serde(default, deserialize_with = "deserialize_string_or_array")]
    pub og_url: Option<String>,
    #[serde(default, deserialize_with = "deserialize_string_or_array")]
    pub og_image: Option<String>,
    #[serde(default, deserialize_with = "deserialize_string_or_array")]
    pub og_audio: Option<String>,
    #[serde(default, deserialize_with = "deserialize_string_or_array")]
    pub og_determiner: Option<String>,
    #[serde(default, deserialize_with = "deserialize_string_or_array")]
    pub og_locale: Option<String>,
    pub og_locale_alternate: Option<Vec<String>>,
    #[serde(default, deserialize_with = "deserialize_string_or_array")]
    pub og_site_name: Option<String>,
    #[serde(default, deserialize_with = "deserialize_string_or_array")]
    pub og_video: Option<String>,

    // Article namespace
    #[serde(default, deserialize_with = "deserialize_string_or_array")]
    pub article_section: Option<String>,
    #[serde(default, deserialize_with = "deserialize_string_or_array")]
    pub article_tag: Option<String>,
    #[serde(default, deserialize_with = "deserialize_string_or_array")]
    pub published_time: Option<String>,
    #[serde(default, deserialize_with = "deserialize_string_or_array")]
    pub modified_time: Option<String>,

    // Dublin Core namespace
    #[serde(default, deserialize_with = "deserialize_string_or_array")]
    pub dcterms_keywords: Option<String>,
    #[serde(default, deserialize_with = "deserialize_string_or_array")]
    pub dc_description: Option<String>,
    #[serde(default, deserialize_with = "deserialize_string_or_array")]
    pub dc_subject: Option<String>,
    #[serde(default, deserialize_with = "deserialize_string_or_array")]
    pub dcterms_subject: Option<String>,
    #[serde(default, deserialize_with = "deserialize_string_or_array")]
    pub dcterms_audience: Option<String>,
    #[serde(default, deserialize_with = "deserialize_string_or_array")]
    pub dc_type: Option<String>,
    #[serde(default, deserialize_with = "deserialize_string_or_array")]
    pub dcterms_type: Option<String>,
    #[serde(default, deserialize_with = "deserialize_string_or_array")]
    pub dc_date: Option<String>,
    #[serde(default, deserialize_with = "deserialize_string_or_array")]
    pub dc_date_created: Option<String>,
    #[serde(default, deserialize_with = "deserialize_string_or_array")]
    pub dcterms_created: Option<String>,

    // Response metadata
    #[serde(default, deserialize_with = "deserialize_string_or_array")]
    pub scrape_id: Option<String>,
    pub num_pages: Option<u32>,
    #[serde(default, deserialize_with = "deserialize_string_or_array")]
    pub content_type: Option<String>,
    #[serde(default, deserialize_with = "deserialize_string_or_array")]
    pub timezone: Option<String>,
    #[serde(default, deserialize_with = "deserialize_string_or_array")]
    pub proxy_used: Option<String>,
    #[serde(default, deserialize_with = "deserialize_string_or_array")]
    pub cache_state: Option<String>,
    #[serde(default, deserialize_with = "deserialize_string_or_array")]
    pub cached_at: Option<String>,
    pub credits_used: Option<u32>,
    pub concurrency_limited: Option<bool>,
}

/// Extracted attribute result.
#[serde_with::skip_serializing_none]
#[derive(Deserialize, Serialize, Debug, Default, Clone)]
pub struct AttributeResult {
    pub selector: String,
    pub attribute: String,
    pub values: Vec<String>,
}

/// Document returned from scrape operations.
#[serde_with::skip_serializing_none]
#[derive(Deserialize, Serialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Document {
    /// Markdown content of the page.
    pub markdown: Option<String>,
    /// Filtered HTML content.
    pub html: Option<String>,
    /// Raw HTML content.
    pub raw_html: Option<String>,
    /// Structured JSON extraction result.
    pub json: Option<Value>,
    /// AI-generated summary.
    pub summary: Option<String>,
    /// Document metadata.
    pub metadata: Option<DocumentMetadata>,
    /// Links found on the page.
    pub links: Option<Vec<String>>,
    /// Images found on the page.
    pub images: Option<Vec<String>>,
    /// Screenshot URL or base64 data.
    pub screenshot: Option<String>,
    /// Audio download URL (signed GCS link for MP3).
    pub audio: Option<String>,
    /// Video download URL (signed GCS link).
    pub video: Option<String>,
    /// Extracted attributes.
    pub attributes: Option<Vec<AttributeResult>>,
    /// Action results.
    pub actions: Option<HashMap<String, Value>>,
    /// Answer generated by the question or deprecated query format.
    pub answer: Option<String>,
    /// Highlights generated by the highlights format.
    pub highlights: Option<String>,
    /// Warning message.
    pub warning: Option<String>,
    /// Change tracking data.
    pub change_tracking: Option<Value>,
    /// Branding analysis.
    pub branding: Option<Value>,
    /// Product extraction result.
    pub product: Option<Product>,
    /// Menu extraction result.
    pub menu: Option<Menu>,
}

/// Product extraction result for a page.
#[serde_with::skip_serializing_none]
#[derive(Deserialize, Serialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Product {
    /// Product title.
    pub title: String,
    /// Brand name.
    pub brand: Option<String>,
    /// Product category.
    pub category: Option<String>,
    /// Product URL.
    pub url: String,
    /// Product description.
    pub description: Option<String>,
    /// Product variants.
    #[serde(default)]
    pub variants: Vec<ProductVariant>,
}

/// An image associated with a product.
#[serde_with::skip_serializing_none]
#[derive(Deserialize, Serialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProductImage {
    /// Image URL.
    pub url: String,
    /// Alternative text for the image.
    pub alt: Option<String>,
}

/// Price information for a product.
#[serde_with::skip_serializing_none]
#[derive(Deserialize, Serialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProductPrice {
    /// Numeric price amount.
    pub amount: f64,
    /// Currency code.
    pub currency: Option<String>,
    /// Human-readable formatted price.
    pub formatted: Option<String>,
}

/// Availability information for a product.
#[serde_with::skip_serializing_none]
#[derive(Deserialize, Serialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProductAvailability {
    /// Whether the product is in stock.
    #[serde(rename = "inStock")]
    pub in_stock: bool,
    /// Human-readable availability text.
    pub text: Option<String>,
}

/// A variant of a product.
#[serde_with::skip_serializing_none]
#[derive(Deserialize, Serialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProductVariant {
    /// Variant identifier.
    pub id: Option<String>,
    /// Stock keeping unit.
    pub sku: Option<String>,
    /// Variant title.
    pub title: Option<String>,
    /// Variant option values (e.g. size, color).
    pub values: Option<HashMap<String, serde_json::Value>>,
    /// Variant price.
    pub price: Option<ProductPrice>,
    /// Sale information, present when the variant is discounted.
    pub sale: Option<ProductSale>,
    /// Variant availability information (always present).
    pub availability: ProductAvailability,
    /// Variant images.
    pub images: Option<Vec<ProductImage>>,
}

/// Sale information for a product variant.
#[serde_with::skip_serializing_none]
#[derive(Deserialize, Serialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProductSale {
    /// Original price before the discount.
    pub original_price: ProductPrice,
}

/// Menu extraction result for a page.
#[serde_with::skip_serializing_none]
#[derive(Deserialize, Serialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Menu {
    /// Whether the page was identified as a menu.
    pub is_menu: bool,
    /// Confidence score for the menu classification.
    pub confidence: f64,
    /// Currency code for the menu prices.
    pub currency: Option<String>,
    /// Source URL of the menu.
    pub source_url: String,
    /// Merchant information.
    pub merchant: MenuMerchant,
    /// Menu sections.
    #[serde(default)]
    pub sections: Vec<MenuSection>,
}

/// Merchant information for a menu.
#[serde_with::skip_serializing_none]
#[derive(Deserialize, Serialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MenuMerchant {
    /// Merchant name.
    pub name: String,
    /// Merchant type.
    #[serde(rename = "type")]
    pub merchant_type: Option<String>,
    /// Merchant location (arbitrary shape).
    pub location: Option<Value>,
}

/// A section of a menu.
#[serde_with::skip_serializing_none]
#[derive(Deserialize, Serialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MenuSection {
    /// Section identifier.
    pub id: String,
    /// Section name.
    pub name: String,
    /// Section description.
    pub description: Option<String>,
    /// Items in the section.
    #[serde(default)]
    pub items: Vec<MenuItem>,
}

/// An item on a menu.
#[serde_with::skip_serializing_none]
#[derive(Deserialize, Serialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MenuItem {
    /// Item identifier.
    pub id: String,
    /// Item name.
    pub name: String,
    /// Item description.
    pub description: Option<String>,
    /// Item images.
    #[serde(default)]
    pub images: Vec<MenuImage>,
    /// Item price.
    pub price: Option<MenuPrice>,
    /// Item availability information.
    pub availability: MenuAvailability,
    /// Dietary tags.
    #[serde(default)]
    pub dietary: Vec<String>,
    /// Calorie count.
    pub calories: Option<f64>,
    /// Option groups (arbitrary shape).
    #[serde(default)]
    pub option_groups: Vec<Value>,
    /// Item identifiers.
    #[serde(default)]
    pub identifiers: MenuItemIdentifiers,
    /// Item URL.
    pub url: Option<String>,
    /// Source URL of the item.
    pub source_url: String,
}

/// An image associated with a menu item.
#[serde_with::skip_serializing_none]
#[derive(Deserialize, Serialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MenuImage {
    /// Image URL.
    pub url: String,
    /// Alternative text for the image.
    pub alt: Option<String>,
}

/// Price information for a menu item.
#[serde_with::skip_serializing_none]
#[derive(Deserialize, Serialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MenuPrice {
    /// Numeric price amount.
    pub amount: f64,
    /// Currency code.
    pub currency: Option<String>,
    /// Human-readable formatted price.
    pub formatted: Option<String>,
}

/// Availability information for a menu item.
#[serde_with::skip_serializing_none]
#[derive(Deserialize, Serialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MenuAvailability {
    /// Whether the item is in stock.
    #[serde(rename = "inStock")]
    pub in_stock: bool,
    /// Human-readable availability text.
    pub text: Option<String>,
}

/// Identifiers for a menu item.
#[serde_with::skip_serializing_none]
#[derive(Deserialize, Serialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MenuItemIdentifiers {
    /// Merchant-specific item identifier.
    pub merchant_item_id: Option<String>,
}

/// Job status types for crawl and batch operations.
#[derive(Deserialize, Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum JobStatus {
    Scraping,
    Completed,
    Failed,
    Cancelled,
}

/// Sitemap handling mode.
#[derive(Deserialize, Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SitemapMode {
    /// Skip sitemap entirely.
    Skip,
    /// Include sitemap links alongside discovered links.
    Include,
    /// Only use links from the sitemap.
    Only,
}

/// Agent model types.
#[derive(Deserialize, Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum AgentModel {
    #[serde(rename = "spark-1-pro")]
    Spark1Pro,
    #[serde(rename = "spark-1-mini")]
    Spark1Mini,
}

/// Search source types.
#[derive(Deserialize, Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SearchSource {
    Web,
    News,
    Images,
}

/// Search category types.
#[derive(Deserialize, Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SearchCategory {
    Github,
    Research,
    Pdf,
}

/// Web search result.
#[serde_with::skip_serializing_none]
#[derive(Deserialize, Serialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SearchResultWeb {
    pub url: String,
    pub title: Option<String>,
    pub description: Option<String>,
    pub category: Option<String>,
}

/// News search result.
#[serde_with::skip_serializing_none]
#[derive(Deserialize, Serialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SearchResultNews {
    pub title: Option<String>,
    pub url: Option<String>,
    pub snippet: Option<String>,
    pub date: Option<String>,
    pub image_url: Option<String>,
    pub position: Option<u32>,
    pub category: Option<String>,
}

/// Image search result.
#[serde_with::skip_serializing_none]
#[derive(Deserialize, Serialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SearchResultImage {
    pub title: Option<String>,
    pub image_url: Option<String>,
    pub image_width: Option<u32>,
    pub image_height: Option<u32>,
    pub url: Option<String>,
    pub position: Option<u32>,
}

/// Crawl error information.
#[serde_with::skip_serializing_none]
#[derive(Deserialize, Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CrawlError {
    pub id: String,
    pub timestamp: Option<String>,
    pub url: String,
    pub code: Option<String>,
    pub error: String,
}

/// Crawl errors response.
#[serde_with::skip_serializing_none]
#[derive(Deserialize, Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CrawlErrorsResponse {
    pub errors: Vec<CrawlError>,
    #[serde(rename = "robotsBlocked")]
    pub robots_blocked: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_full_document_with_array_metadata() {
        let json = json!({
            "markdown": "# Hello",
            "video": "https://storage.googleapis.com/firecrawl/video.mp4",
            "metadata": {
                "sourceURL": "https://example.com",
                "statusCode": 200,
                "title": "Example Page",
                "description": ["A great page", "with multiple descriptions"],
                "robots": ["index", "follow"],
                "ogImage": ["https://img.jpg"],
                "language": "en",
                "keywords": ["rust", "sdk", "firecrawl"]
            }
        });
        let doc: Document = serde_json::from_value(json).unwrap();
        assert_eq!(doc.markdown, Some("# Hello".to_string()));
        assert_eq!(
            doc.video,
            Some("https://storage.googleapis.com/firecrawl/video.mp4".to_string())
        );
        let meta = doc.metadata.unwrap();
        assert_eq!(meta.title, Some("Example Page".to_string()));
        assert_eq!(
            meta.description,
            Some("A great page, with multiple descriptions".to_string())
        );
        assert_eq!(meta.robots, Some("index, follow".to_string()));
        assert_eq!(meta.og_image, Some("https://img.jpg".to_string()));
        assert_eq!(meta.language, Some("en".to_string()));
        assert_eq!(meta.keywords, Some("rust, sdk, firecrawl".to_string()));
    }

    #[test]
    fn test_format_menu_round_trip() {
        let format = Format::Menu;
        let serialized = serde_json::to_value(&format).unwrap();
        assert_eq!(serialized, json!("menu"));
        let deserialized: Format = serde_json::from_value(json!("menu")).unwrap();
        assert_eq!(deserialized, Format::Menu);
    }

    #[test]
    fn test_document_with_menu() {
        let json = json!({
            "menu": {
                "isMenu": true,
                "confidence": 0.95,
                "currency": "USD",
                "sourceUrl": "https://example.com/menu",
                "merchant": {
                    "name": "Test Diner",
                    "type": "restaurant",
                    "location": { "city": "Springfield" }
                },
                "sections": [
                    {
                        "id": "s1",
                        "name": "Mains",
                        "items": [
                            {
                                "id": "i1",
                                "name": "Burger",
                                "images": [{ "url": "https://example.com/burger.jpg" }],
                                "price": { "amount": 12.5, "currency": "USD", "formatted": "$12.50" },
                                "availability": { "inStock": true },
                                "dietary": ["vegetarian"],
                                "optionGroups": [],
                                "identifiers": { "merchantItemId": "abc123" },
                                "sourceUrl": "https://example.com/menu#i1"
                            }
                        ]
                    }
                ]
            }
        });
        let doc: Document = serde_json::from_value(json).unwrap();
        let menu = doc.menu.as_ref().expect("menu should be present");
        assert!(menu.is_menu);
        assert_eq!(menu.confidence, 0.95);
        assert_eq!(menu.currency, Some("USD".to_string()));
        assert_eq!(menu.source_url, "https://example.com/menu");
        assert_eq!(menu.merchant.name, "Test Diner");
        assert_eq!(menu.merchant.merchant_type, Some("restaurant".to_string()));
        assert_eq!(menu.sections.len(), 1);
        let section = &menu.sections[0];
        assert_eq!(section.name, "Mains");
        assert_eq!(section.items.len(), 1);
        let item = &section.items[0];
        assert_eq!(item.name, "Burger");
        assert!(item.availability.in_stock);
        assert_eq!(item.dietary, vec!["vegetarian".to_string()]);
        assert_eq!(
            item.identifiers.merchant_item_id,
            Some("abc123".to_string())
        );
        let price = item.price.as_ref().unwrap();
        assert_eq!(price.amount, 12.5);

        // Round-trip back to JSON and ensure camelCase field names are preserved.
        let reserialized = serde_json::to_value(&doc).unwrap();
        let item_json = &reserialized["menu"]["sections"][0]["items"][0];
        assert_eq!(item_json["sourceUrl"], "https://example.com/menu#i1");
        assert_eq!(item_json["availability"]["inStock"], true);
        assert_eq!(item_json["identifiers"]["merchantItemId"], "abc123");
    }
}
