//! Scrape endpoint for Firecrawl API v2.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

use super::client::Client;
use super::types::{
    Action, AttributeSelector, ChangeTrackingOptions, Document, Format, JsonOptions,
    LocationConfig, ProxyType, ScreenshotOptions,
};
use crate::FirecrawlError;

/// Options for scraping a URL.
#[serde_with::skip_serializing_none]
#[derive(Deserialize, Serialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ScrapeOptions {
    /// Output formats to include in the response.
    pub formats: Option<Vec<Format>>,

    /// Additional HTTP headers to send with the request.
    pub headers: Option<HashMap<String, String>>,

    /// HTML tags to exclusively include in the output.
    pub include_tags: Option<Vec<String>>,

    /// HTML tags to exclude from the output.
    pub exclude_tags: Option<Vec<String>>,

    /// Only extract the main content of the page.
    pub only_main_content: Option<bool>,

    /// Timeout in milliseconds before returning an error.
    pub timeout: Option<u32>,

    /// Time to wait after page load before scraping (milliseconds).
    pub wait_for: Option<u32>,

    /// Emulate a mobile device.
    pub mobile: Option<bool>,

    /// Parser configurations (e.g., for PDFs).
    pub parsers: Option<Vec<ParserConfig>>,

    /// Browser automation actions to perform before scraping.
    pub actions: Option<Vec<Action>>,

    /// Location configuration for proxy routing.
    pub location: Option<LocationConfig>,

    /// Skip TLS certificate verification.
    pub skip_tls_verification: Option<bool>,

    /// Remove base64-encoded images from the output.
    pub remove_base64_images: Option<bool>,

    /// Enable fast mode for quicker scrapes with reduced accuracy.
    pub fast_mode: Option<bool>,

    /// Block advertisements on the page.
    pub block_ads: Option<bool>,

    /// Proxy type to use.
    pub proxy: Option<ProxyType>,

    /// Maximum age of cached content to accept (seconds).
    pub max_age: Option<u32>,

    /// Minimum age of cached content to accept (seconds).
    pub min_age: Option<u32>,

    /// Store the result in cache for future requests.
    pub store_in_cache: Option<bool>,

    /// Integration identifier for tracking.
    pub integration: Option<String>,

    /// JSON extraction options.
    pub json_options: Option<JsonOptions>,

    /// Screenshot options.
    pub screenshot_options: Option<ScreenshotOptions>,

    /// Change tracking options.
    pub change_tracking_options: Option<ChangeTrackingOptions>,

    /// Attribute selectors for extraction.
    pub attribute_selectors: Option<Vec<AttributeSelector>>,
}

/// Parser configuration for document parsing.
#[derive(Deserialize, Serialize, Debug, Clone)]
#[serde(untagged)]
pub enum ParserConfig {
    /// Simple parser type string.
    Simple(String),
    /// PDF parser with options.
    Pdf {
        #[serde(rename = "type")]
        parser_type: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        max_pages: Option<u32>,
    },
}

/// Request body for scrape endpoint.
#[derive(Deserialize, Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
struct ScrapeRequest {
    url: String,
    #[serde(flatten)]
    options: ScrapeOptions,
}

/// Response from scrape endpoint.
#[derive(Deserialize, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
struct ScrapeResponse {
    success: bool,
    data: Document,
    #[serde(skip_serializing_if = "Option::is_none")]
    warning: Option<String>,
}

impl Client {
    /// Scrapes a URL and returns the content in the requested formats.
    ///
    /// # Arguments
    ///
    /// * `url` - The URL to scrape.
    /// * `options` - Optional scrape configuration.
    ///
    /// # Returns
    ///
    /// A `Document` containing the scraped content.
    ///
    /// # Example
    ///
    /// ```no_run
    /// use firecrawl::v2::{Client, ScrapeOptions, Format};
    ///
    /// #[tokio::main]
    /// async fn main() -> Result<(), Box<dyn std::error::Error>> {
    ///     let client = Client::new("your-api-key")?;
    ///
    ///     // Simple scrape
    ///     let document = client.scrape("https://example.com", None).await?;
    ///     println!("Markdown: {:?}", document.markdown);
    ///
    ///     // Scrape with options
    ///     let options = ScrapeOptions {
    ///         formats: Some(vec![Format::Markdown, Format::Html, Format::Links]),
    ///         only_main_content: Some(true),
    ///         ..Default::default()
    ///     };
    ///     let document = client.scrape("https://example.com", options).await?;
    ///     println!("Links: {:?}", document.links);
    ///
    ///     Ok(())
    /// }
    /// ```
    pub async fn scrape(
        &self,
        url: impl AsRef<str>,
        options: impl Into<Option<ScrapeOptions>>,
    ) -> Result<Document, FirecrawlError> {
        let body = ScrapeRequest {
            url: url.as_ref().to_string(),
            options: options.into().unwrap_or_default(),
        };

        let headers = self.prepare_headers(None);

        let response = self
            .client
            .post(self.url("/scrape"))
            .headers(headers)
            .json(&body)
            .send()
            .await
            .map_err(|e| FirecrawlError::HttpError(format!("Scraping {:?}", url.as_ref()), e))?;

        let response: ScrapeResponse = self.handle_response(response, "scrape").await?;

        Ok(response.data)
    }

    /// Scrapes a URL with a JSON schema for structured extraction.
    ///
    /// This is a convenience method that combines scraping with JSON extraction.
    ///
    /// # Arguments
    ///
    /// * `url` - The URL to scrape.
    /// * `schema` - JSON schema for the extraction.
    /// * `prompt` - Optional extraction prompt.
    ///
    /// # Returns
    ///
    /// The extracted JSON value matching the schema.
    ///
    /// # Example
    ///
    /// ```no_run
    /// use firecrawl::v2::Client;
    /// use serde_json::json;
    ///
    /// #[tokio::main]
    /// async fn main() -> Result<(), Box<dyn std::error::Error>> {
    ///     let client = Client::new("your-api-key")?;
    ///
    ///     let schema = json!({
    ///         "type": "object",
    ///         "properties": {
    ///             "title": { "type": "string" },
    ///             "price": { "type": "number" }
    ///         }
    ///     });
    ///
    ///     let data = client.scrape_with_schema(
    ///         "https://example.com/product",
    ///         schema,
    ///         Some("Extract the product title and price")
    ///     ).await?;
    ///
    ///     println!("Extracted: {}", data);
    ///
    ///     Ok(())
    /// }
    /// ```
    pub async fn scrape_with_schema(
        &self,
        url: impl AsRef<str>,
        schema: Value,
        prompt: Option<impl AsRef<str>>,
    ) -> Result<Value, FirecrawlError> {
        let options = ScrapeOptions {
            formats: Some(vec![Format::Json]),
            json_options: Some(JsonOptions {
                schema: Some(schema),
                prompt: prompt.map(|p| p.as_ref().to_string()),
                ..Default::default()
            }),
            ..Default::default()
        };

        let document = self.scrape(url, options).await?;
        Ok(document.json.unwrap_or(Value::Null))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn test_scrape_with_mock() {
        let mut server = mockito::Server::new_async().await;

        let mock = server
            .mock("POST", "/v2/scrape")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                json!({
                    "success": true,
                    "data": {
                        "markdown": "# Example Domain\n\nThis is an example.",
                        "metadata": {
                            "sourceURL": "https://example.com",
                            "statusCode": 200,
                            "title": "Example Domain"
                        }
                    }
                })
                .to_string(),
            )
            .create();

        let client = Client::new_selfhosted(server.url(), Some("test_key")).unwrap();
        let document = client.scrape("https://example.com", None).await.unwrap();

        assert!(document.markdown.is_some());
        assert!(document.markdown.unwrap().contains("Example Domain"));
        mock.assert();
    }

    #[tokio::test]
    async fn test_scrape_with_options() {
        let mut server = mockito::Server::new_async().await;

        let mock = server
            .mock("POST", "/v2/scrape")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                json!({
                    "success": true,
                    "data": {
                        "markdown": "# Test",
                        "html": "<h1>Test</h1>",
                        "links": ["https://example.com/page1", "https://example.com/page2"],
                        "metadata": {
                            "sourceURL": "https://example.com",
                            "statusCode": 200
                        }
                    }
                })
                .to_string(),
            )
            .create();

        let client = Client::new_selfhosted(server.url(), Some("test_key")).unwrap();
        let options = ScrapeOptions {
            formats: Some(vec![Format::Markdown, Format::Html, Format::Links]),
            only_main_content: Some(true),
            ..Default::default()
        };

        let document = client.scrape("https://example.com", options).await.unwrap();

        assert!(document.markdown.is_some());
        assert!(document.html.is_some());
        assert!(document.links.is_some());
        assert_eq!(document.links.unwrap().len(), 2);
        mock.assert();
    }

    #[tokio::test]
    async fn test_scrape_with_schema() {
        let mut server = mockito::Server::new_async().await;

        let mock = server
            .mock("POST", "/v2/scrape")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                json!({
                    "success": true,
                    "data": {
                        "json": {
                            "title": "Product Name",
                            "price": 99.99
                        },
                        "metadata": {
                            "sourceURL": "https://example.com/product",
                            "statusCode": 200
                        }
                    }
                })
                .to_string(),
            )
            .create();

        let client = Client::new_selfhosted(server.url(), Some("test_key")).unwrap();

        let schema = json!({
            "type": "object",
            "properties": {
                "title": { "type": "string" },
                "price": { "type": "number" }
            }
        });

        let data = client
            .scrape_with_schema(
                "https://example.com/product",
                schema,
                Some("Extract product info"),
            )
            .await
            .unwrap();

        assert_eq!(data["title"], "Product Name");
        assert_eq!(data["price"], 99.99);
        mock.assert();
    }

    #[tokio::test]
    async fn test_scrape_error_response() {
        let mut server = mockito::Server::new_async().await;

        let mock = server
            .mock("POST", "/v2/scrape")
            .with_status(400)
            .with_header("content-type", "application/json")
            .with_body(
                json!({
                    "success": false,
                    "error": "Invalid URL"
                })
                .to_string(),
            )
            .create();

        let client = Client::new_selfhosted(server.url(), Some("test_key")).unwrap();
        let result = client.scrape("invalid-url", None).await;

        assert!(result.is_err());
        mock.assert();
    }
}
