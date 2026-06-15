//! Scrape endpoint for Firecrawl API v2.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

use crate::client::Client;
use crate::types::{
    Action, AttributeSelector, ChangeTrackingOptions, Document, Format, JsonOptions,
    LocationConfig, ProfileConfig, ProxyType, ScreenshotOptions,
};
use crate::FirecrawlError;

/// Options for scraping a URL.
#[serde_with::skip_serializing_none]
#[derive(Deserialize, Serialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ScrapeOptions {
    /// Origin label for request attribution (e.g., "rust-sdk@2.8.0").
    pub origin: Option<String>,

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

    /// Lockdown mode: serve only previously cached results, never make outbound requests.
    pub lockdown: Option<bool>,

    /// Redact personally identifiable information from returned content.
    #[serde(rename = "redactPII")]
    pub redact_pii: Option<bool>,

    /// Persistent browser profile for maintaining state across scrapes.
    pub profile: Option<ProfileConfig>,

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
        mode: Option<String>,
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

/// Supported languages for scrape-bound browser execution.
#[derive(Deserialize, Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ScrapeExecuteLanguage {
    Python,
    Node,
    Bash,
}

/// Options for executing code or a prompt in a scrape-bound browser session.
///
/// At least one of `code` or `prompt` must be provided.
#[serde_with::skip_serializing_none]
#[derive(Deserialize, Serialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ScrapeExecuteOptions {
    /// Code to execute (optional if `prompt` is provided).
    pub code: Option<String>,
    /// Natural-language instruction for the browser agent (optional if `code` is provided).
    pub prompt: Option<String>,
    /// Runtime language for the code.
    pub language: Option<ScrapeExecuteLanguage>,
    /// Execution timeout in seconds.
    pub timeout: Option<u32>,
    /// Optional origin tag for request attribution.
    pub origin: Option<String>,
}

/// Response from scrape-bound browser execution.
#[serde_with::skip_serializing_none]
#[derive(Deserialize, Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ScrapeExecuteResponse {
    /// Whether the request succeeded.
    pub success: bool,
    /// Live-view URL for the browser session.
    pub live_view_url: Option<String>,
    /// Interactive live-view URL for the browser session.
    pub interactive_live_view_url: Option<String>,
    /// Agent output when a prompt was used.
    pub output: Option<String>,
    /// Captured stdout from execution.
    pub stdout: Option<String>,
    /// Optional execution result payload.
    pub result: Option<String>,
    /// Captured stderr from execution.
    pub stderr: Option<String>,
    /// Process exit code.
    pub exit_code: Option<i32>,
    /// Whether execution was killed by timeout or system.
    pub killed: Option<bool>,
    /// Error message when execution fails.
    pub error: Option<String>,
}

/// Response from deleting a scrape-bound browser session.
#[serde_with::skip_serializing_none]
#[derive(Deserialize, Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ScrapeBrowserDeleteResponse {
    /// Whether the delete request succeeded.
    pub success: bool,
    /// Session duration in milliseconds when available.
    pub session_duration_ms: Option<u64>,
    /// Credits billed when available.
    pub credits_billed: Option<u32>,
    /// Error message when deletion fails.
    pub error: Option<String>,
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
    /// use firecrawl::{Client, ScrapeOptions, Format};
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
        let mut options = options.into().unwrap_or_default();
        if options.origin.is_none() {
            options.origin = Some(format!("rust-sdk@{}", env!("CARGO_PKG_VERSION")));
        }
        let body = ScrapeRequest {
            url: url.as_ref().to_string(),
            options,
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
    /// use firecrawl::Client;
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

    /// Interacts with the browser session associated with a scrape job.
    ///
    /// # Arguments
    ///
    /// * `job_id` - The scrape job ID.
    /// * `options` - Execution options including code and runtime config.
    ///
    /// # Returns
    ///
    /// A `ScrapeExecuteResponse` containing execution output.
    pub async fn interact(
        &self,
        job_id: impl AsRef<str>,
        options: ScrapeExecuteOptions,
    ) -> Result<ScrapeExecuteResponse, FirecrawlError> {
        let has_code = options.code.as_ref().is_some_and(|c| !c.trim().is_empty());
        let has_prompt = options
            .prompt
            .as_ref()
            .is_some_and(|p| !p.trim().is_empty());
        if !has_code && !has_prompt {
            return Err(FirecrawlError::Misuse(
                "Either 'code' or 'prompt' must be provided".into(),
            ));
        }

        let mut body = options;
        if body.language.is_none() {
            body.language = Some(ScrapeExecuteLanguage::Node);
        }
        if body.origin.is_none() {
            body.origin = Some(format!("rust-sdk@{}", env!("CARGO_PKG_VERSION")));
        }

        let response = self
            .client
            .post(self.url(&format!("/scrape/{}/interact", job_id.as_ref())))
            .headers(self.prepare_headers(None))
            .json(&body)
            .send()
            .await
            .map_err(|e| {
                FirecrawlError::HttpError(
                    format!("Interacting with scrape browser for {}", job_id.as_ref()),
                    e,
                )
            })?;

        self.handle_response(response, "scrape interact").await
    }

    /// Stops the interaction session associated with a scrape job.
    ///
    /// # Arguments
    ///
    /// * `job_id` - The scrape job ID.
    ///
    /// # Returns
    ///
    /// A `ScrapeBrowserDeleteResponse` indicating stop status.
    pub async fn stop_interaction(
        &self,
        job_id: impl AsRef<str>,
    ) -> Result<ScrapeBrowserDeleteResponse, FirecrawlError> {
        let response = self
            .client
            .delete(self.url(&format!("/scrape/{}/interact", job_id.as_ref())))
            .headers(self.prepare_headers(None))
            .send()
            .await
            .map_err(|e| {
                FirecrawlError::HttpError(
                    format!("Stopping interaction for {}", job_id.as_ref()),
                    e,
                )
            })?;

        self.handle_response(response, "stop interaction").await
    }

    /// Deprecated alias for [`Client::interact`].
    #[deprecated(note = "Use interact() instead")]
    pub async fn scrape_execute(
        &self,
        job_id: impl AsRef<str>,
        options: ScrapeExecuteOptions,
    ) -> Result<ScrapeExecuteResponse, FirecrawlError> {
        self.interact(job_id, options).await
    }

    /// Deprecated alias for [`Client::stop_interaction`].
    #[deprecated(note = "Use stop_interaction() instead")]
    pub async fn stop_interactive_browser(
        &self,
        job_id: impl AsRef<str>,
    ) -> Result<ScrapeBrowserDeleteResponse, FirecrawlError> {
        self.stop_interaction(job_id).await
    }

    /// Deprecated alias for [`Client::stop_interaction`].
    #[deprecated(note = "Use stop_interaction() instead")]
    pub async fn delete_scrape_browser(
        &self,
        job_id: impl AsRef<str>,
    ) -> Result<ScrapeBrowserDeleteResponse, FirecrawlError> {
        self.stop_interaction(job_id).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{HighlightsFormat, QueryFormat, QueryFormatMode, QuestionFormat};
    use serde_json::json;

    #[test]
    fn test_query_format_serializes_mode() {
        let options = ScrapeOptions {
            formats: Some(vec![Format::Query(QueryFormat {
                prompt: "What is Firecrawl?".to_string(),
                mode: Some(QueryFormatMode::DirectQuote),
            })]),
            ..Default::default()
        };

        let payload = serde_json::to_value(options).unwrap();
        assert_eq!(
            payload["formats"][0],
            json!({
                "type": "query",
                "prompt": "What is Firecrawl?",
                "mode": "directQuote"
            })
        );
    }

    #[test]
    fn test_question_and_highlights_formats_serialize() {
        let options = ScrapeOptions {
            formats: Some(vec![
                Format::Question(QuestionFormat {
                    question: "What is Firecrawl?".to_string(),
                }),
                Format::Highlights(HighlightsFormat {
                    query: "What is Firecrawl?".to_string(),
                }),
            ]),
            ..Default::default()
        };

        let payload = serde_json::to_value(options).unwrap();
        assert_eq!(
            payload["formats"][0],
            json!({
                "type": "question",
                "question": "What is Firecrawl?"
            })
        );
        assert_eq!(
            payload["formats"][1],
            json!({
                "type": "highlights",
                "query": "What is Firecrawl?"
            })
        );
    }

    #[test]
    fn test_scrape_options_serializes_redact_pii() {
        let options = ScrapeOptions {
            redact_pii: Some(true),
            ..Default::default()
        };

        let payload = serde_json::to_value(options).unwrap();
        assert_eq!(payload["redactPII"], json!(true));
        assert!(payload.get("formats").is_none());
    }

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

    #[tokio::test]
    async fn test_interact_with_mock() {
        let mut server = mockito::Server::new_async().await;

        let mock = server
            .mock("POST", "/v2/scrape/job-123/interact")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                json!({
                    "success": true,
                    "stdout": "ok",
                    "result": "done",
                    "stderr": "",
                    "exitCode": 0,
                    "killed": false
                })
                .to_string(),
            )
            .create();

        let client = Client::new_selfhosted(server.url(), Some("test_key")).unwrap();
        let response = client
            .interact(
                "job-123",
                ScrapeExecuteOptions {
                    code: Some("console.log('ok')".to_string()),
                    timeout: Some(30),
                    ..Default::default()
                },
            )
            .await
            .unwrap();

        assert!(response.success);
        assert_eq!(response.exit_code, Some(0));
        assert_eq!(response.result, Some("done".to_string()));
        mock.assert();
    }

    #[tokio::test]
    async fn test_interact_with_prompt() {
        let mut server = mockito::Server::new_async().await;

        let mock = server
            .mock("POST", "/v2/scrape/job-789/interact")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                json!({
                    "success": true,
                    "output": "Clicked the login button",
                    "liveViewUrl": "https://live.example.com/view",
                    "interactiveLiveViewUrl": "https://live.example.com/interactive",
                    "stdout": "",
                    "exitCode": 0,
                    "killed": false
                })
                .to_string(),
            )
            .create();

        let client = Client::new_selfhosted(server.url(), Some("test_key")).unwrap();
        let response = client
            .interact(
                "job-789",
                ScrapeExecuteOptions {
                    prompt: Some("Click the login button".to_string()),
                    ..Default::default()
                },
            )
            .await
            .unwrap();

        assert!(response.success);
        assert_eq!(
            response.output,
            Some("Clicked the login button".to_string())
        );
        assert_eq!(
            response.live_view_url,
            Some("https://live.example.com/view".to_string())
        );
        assert_eq!(
            response.interactive_live_view_url,
            Some("https://live.example.com/interactive".to_string())
        );
        mock.assert();
    }

    #[tokio::test]
    async fn test_stop_interaction_with_mock() {
        let mut server = mockito::Server::new_async().await;

        let mock = server
            .mock("DELETE", "/v2/scrape/job-123/interact")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                json!({
                    "success": true,
                    "sessionDurationMs": 1200,
                    "creditsBilled": 3
                })
                .to_string(),
            )
            .create();

        let client = Client::new_selfhosted(server.url(), Some("test_key")).unwrap();
        let response = client.stop_interaction("job-123").await.unwrap();

        assert!(response.success);
        assert_eq!(response.session_duration_ms, Some(1200));
        assert_eq!(response.credits_billed, Some(3));
        mock.assert();
    }

    #[tokio::test]
    async fn test_interact_error_response() {
        let mut server = mockito::Server::new_async().await;

        let mock = server
            .mock("POST", "/v2/scrape/job-404/interact")
            .with_status(404)
            .with_header("content-type", "application/json")
            .with_body(
                json!({
                    "success": false,
                    "error": "Job not found."
                })
                .to_string(),
            )
            .create();

        let client = Client::new_selfhosted(server.url(), Some("test_key")).unwrap();
        let result = client
            .interact(
                "job-404",
                ScrapeExecuteOptions {
                    code: Some("console.log('ok')".to_string()),
                    ..Default::default()
                },
            )
            .await;

        assert!(result.is_err());
        mock.assert();
    }
}
