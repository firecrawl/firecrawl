//! Type definitions for Firecrawl API v2.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

use crate::serde_helpers::deserialize_string_or_array;

/// Available output formats for scraping operations.
#[derive(Deserialize, Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
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
    /// Extracted attributes.
    pub attributes: Option<Vec<AttributeResult>>,
    /// Action results.
    pub actions: Option<HashMap<String, Value>>,
    /// Warning message.
    pub warning: Option<String>,
    /// Change tracking data.
    pub change_tracking: Option<Value>,
    /// Branding analysis.
    pub branding: Option<Value>,
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
}
