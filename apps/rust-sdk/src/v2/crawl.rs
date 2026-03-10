//! Crawl endpoint for Firecrawl API v2.

use serde::{Deserialize, Serialize};

use super::client::Client;
use super::scrape::ScrapeOptions;
use super::types::{CrawlErrorsResponse, Document, JobStatus, SitemapMode, WebhookConfig};
use crate::FirecrawlError;

/// Options for crawling a website.
#[serde_with::skip_serializing_none]
#[derive(Deserialize, Serialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CrawlOptions {
    /// Natural language prompt to guide crawl behavior.
    pub prompt: Option<String>,

    /// URL path patterns to exclude from crawling.
    pub exclude_paths: Option<Vec<String>>,

    /// URL path patterns to include in crawling.
    pub include_paths: Option<Vec<String>>,

    /// Maximum depth of links to follow from the initial URL.
    pub max_discovery_depth: Option<u32>,

    /// How to handle the sitemap.
    pub sitemap: Option<SitemapMode>,

    /// Ignore query parameters when deduplicating URLs.
    pub ignore_query_parameters: Option<bool>,

    /// Maximum number of pages to crawl.
    pub limit: Option<u32>,

    /// Crawl the entire domain regardless of path structure.
    pub crawl_entire_domain: Option<bool>,

    /// Allow following links to external domains.
    pub allow_external_links: Option<bool>,

    /// Allow following links to subdomains.
    pub allow_subdomains: Option<bool>,

    /// Delay between requests in seconds.
    pub delay: Option<u32>,

    /// Maximum concurrent requests.
    pub max_concurrency: Option<u32>,

    /// Webhook configuration for job notifications.
    pub webhook: Option<WebhookConfig>,

    /// Scrape options to apply to each page.
    pub scrape_options: Option<ScrapeOptions>,

    /// Enable zero data retention mode.
    pub zero_data_retention: Option<bool>,

    /// Integration identifier for tracking.
    pub integration: Option<String>,

    /// Idempotency key for the request.
    #[serde(skip)]
    pub idempotency_key: Option<String>,

    /// Poll interval for synchronous crawl (milliseconds).
    #[serde(skip)]
    pub poll_interval: Option<u64>,
}

/// Request body for crawl endpoint.
#[derive(Deserialize, Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
struct CrawlRequest {
    url: String,
    #[serde(flatten)]
    options: CrawlOptions,
}

/// Response from starting a crawl job.
#[derive(Deserialize, Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CrawlResponse {
    /// Whether the request was successful.
    pub success: bool,
    /// The crawl job ID.
    pub id: String,
    /// URL to check the crawl status.
    pub url: String,
}

/// Status of a crawl job.
#[serde_with::skip_serializing_none]
#[derive(Deserialize, Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CrawlJob {
    /// Current status of the crawl job.
    pub status: JobStatus,
    /// Total number of pages to crawl.
    pub total: u32,
    /// Number of pages completed.
    pub completed: u32,
    /// Credits used by the crawl.
    pub credits_used: Option<u32>,
    /// Expiry time of the crawl data.
    pub expires_at: Option<String>,
    /// URL for the next page of results.
    pub next: Option<String>,
    /// Crawled documents.
    pub data: Vec<Document>,
}

/// Response from canceling a crawl.
#[derive(Deserialize, Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CancelCrawlResponse {
    /// Status of the cancellation.
    pub status: String,
}

impl Client {
    /// Starts a crawl job asynchronously.
    ///
    /// Returns immediately with a job ID that can be used to check status.
    ///
    /// # Arguments
    ///
    /// * `url` - The URL to start crawling from.
    /// * `options` - Optional crawl configuration.
    ///
    /// # Returns
    ///
    /// A `CrawlResponse` containing the job ID.
    ///
    /// # Example
    ///
    /// ```no_run
    /// use firecrawl::v2::{Client, CrawlOptions};
    ///
    /// #[tokio::main]
    /// async fn main() -> Result<(), Box<dyn std::error::Error>> {
    ///     let client = Client::new("your-api-key")?;
    ///
    ///     let response = client.start_crawl("https://example.com", None).await?;
    ///     println!("Crawl job started: {}", response.id);
    ///
    ///     // Check status later
    ///     let status = client.get_crawl_status(&response.id).await?;
    ///     println!("Status: {:?}, Completed: {}/{}", status.status, status.completed, status.total);
    ///
    ///     Ok(())
    /// }
    /// ```
    pub async fn start_crawl(
        &self,
        url: impl AsRef<str>,
        options: impl Into<Option<CrawlOptions>>,
    ) -> Result<CrawlResponse, FirecrawlError> {
        let options = options.into().unwrap_or_default();
        let body = CrawlRequest {
            url: url.as_ref().to_string(),
            options: options.clone(),
        };

        let headers = self.prepare_headers(options.idempotency_key.as_ref());

        let response = self
            .client
            .post(self.url("/crawl"))
            .headers(headers)
            .json(&body)
            .send()
            .await
            .map_err(|e| {
                FirecrawlError::HttpError(format!("Starting crawl of {:?}", url.as_ref()), e)
            })?;

        self.handle_response(response, "start crawl").await
    }

    /// Gets the status of a crawl job.
    ///
    /// If the job is completed, this will automatically fetch all pages of results.
    ///
    /// # Arguments
    ///
    /// * `id` - The crawl job ID.
    ///
    /// # Returns
    ///
    /// A `CrawlJob` containing the current status and any available documents.
    ///
    /// # Example
    ///
    /// ```no_run
    /// use firecrawl::v2::Client;
    ///
    /// #[tokio::main]
    /// async fn main() -> Result<(), Box<dyn std::error::Error>> {
    ///     let client = Client::new("your-api-key")?;
    ///
    ///     let status = client.get_crawl_status("job-id").await?;
    ///     println!("Status: {:?}", status.status);
    ///     println!("Completed: {}/{}", status.completed, status.total);
    ///     println!("Documents: {}", status.data.len());
    ///
    ///     Ok(())
    /// }
    /// ```
    pub async fn get_crawl_status(&self, id: impl AsRef<str>) -> Result<CrawlJob, FirecrawlError> {
        let response = self
            .client
            .get(self.url(&format!("/crawl/{}", id.as_ref())))
            .headers(self.prepare_headers(None))
            .send()
            .await
            .map_err(|e| {
                FirecrawlError::HttpError(format!("Checking crawl status {}", id.as_ref()), e)
            })?;

        let mut status: CrawlJob = self
            .handle_response(response, format!("crawl status {}", id.as_ref()))
            .await?;

        // Auto-paginate if completed
        if status.status == JobStatus::Completed {
            while let Some(next) = status.next.take() {
                let next_status = self.get_crawl_status_next(&next).await?;
                status.data.extend(next_status.data);
                status.next = next_status.next;
            }
        }

        Ok(status)
    }

    /// Fetches the next page of crawl results.
    async fn get_crawl_status_next(&self, next: &str) -> Result<CrawlJob, FirecrawlError> {
        let response = self
            .client
            .get(next)
            .headers(self.prepare_headers(None))
            .send()
            .await
            .map_err(|e| FirecrawlError::HttpError(format!("Paginating crawl at {}", next), e))?;

        self.handle_response(response, "crawl pagination").await
    }

    /// Crawls a website and waits for completion.
    ///
    /// This method starts a crawl and polls until it completes or fails.
    ///
    /// # Arguments
    ///
    /// * `url` - The URL to start crawling from.
    /// * `options` - Optional crawl configuration.
    ///
    /// # Returns
    ///
    /// A `CrawlJob` containing all crawled documents.
    ///
    /// # Example
    ///
    /// ```no_run
    /// use firecrawl::v2::{Client, CrawlOptions, SitemapMode};
    ///
    /// #[tokio::main]
    /// async fn main() -> Result<(), Box<dyn std::error::Error>> {
    ///     let client = Client::new("your-api-key")?;
    ///
    ///     let options = CrawlOptions {
    ///         sitemap: Some(SitemapMode::Include),
    ///         limit: Some(100),
    ///         poll_interval: Some(5000), // Check every 5 seconds
    ///         ..Default::default()
    ///     };
    ///
    ///     let result = client.crawl("https://example.com", options).await?;
    ///     println!("Crawled {} pages", result.data.len());
    ///
    ///     for doc in result.data {
    ///         println!("URL: {:?}", doc.metadata.and_then(|m| m.source_url));
    ///     }
    ///
    ///     Ok(())
    /// }
    /// ```
    pub async fn crawl(
        &self,
        url: impl AsRef<str>,
        options: impl Into<Option<CrawlOptions>>,
    ) -> Result<CrawlJob, FirecrawlError> {
        let options = options.into().unwrap_or_default();
        let poll_interval = options.poll_interval.unwrap_or(2000);

        let response = self.start_crawl(url, options).await?;
        self.wait_for_crawl(&response.id, poll_interval).await
    }

    /// Waits for a crawl job to complete.
    async fn wait_for_crawl(
        &self,
        id: &str,
        poll_interval: u64,
    ) -> Result<CrawlJob, FirecrawlError> {
        loop {
            let status = self.get_crawl_status(id).await?;

            match status.status {
                JobStatus::Completed => return Ok(status),
                JobStatus::Scraping => {
                    tokio::time::sleep(tokio::time::Duration::from_millis(poll_interval)).await;
                }
                JobStatus::Failed => {
                    return Err(FirecrawlError::CrawlJobFailed(
                        "Crawl job failed".to_string(),
                        crate::crawl::CrawlStatus {
                            status: crate::crawl::CrawlStatusTypes::Failed,
                            total: status.total,
                            completed: status.completed,
                            credits_used: status.credits_used.unwrap_or(0),
                            expires_at: status.expires_at.unwrap_or_default(),
                            next: status.next,
                            data: status
                                .data
                                .into_iter()
                                .map(|d| convert_v2_document_to_v1(d))
                                .collect(),
                        },
                    ));
                }
                JobStatus::Cancelled => {
                    return Err(FirecrawlError::CrawlJobFailed(
                        "Crawl job was cancelled".to_string(),
                        crate::crawl::CrawlStatus {
                            status: crate::crawl::CrawlStatusTypes::Cancelled,
                            total: status.total,
                            completed: status.completed,
                            credits_used: status.credits_used.unwrap_or(0),
                            expires_at: status.expires_at.unwrap_or_default(),
                            next: status.next,
                            data: status
                                .data
                                .into_iter()
                                .map(|d| convert_v2_document_to_v1(d))
                                .collect(),
                        },
                    ));
                }
            }
        }
    }

    /// Cancels a running crawl job.
    ///
    /// # Arguments
    ///
    /// * `id` - The crawl job ID to cancel.
    ///
    /// # Returns
    ///
    /// A `CancelCrawlResponse` indicating the cancellation status.
    ///
    /// # Example
    ///
    /// ```no_run
    /// use firecrawl::v2::Client;
    ///
    /// #[tokio::main]
    /// async fn main() -> Result<(), Box<dyn std::error::Error>> {
    ///     let client = Client::new("your-api-key")?;
    ///
    ///     let response = client.cancel_crawl("job-id").await?;
    ///     println!("Cancellation status: {}", response.status);
    ///
    ///     Ok(())
    /// }
    /// ```
    pub async fn cancel_crawl(
        &self,
        id: impl AsRef<str>,
    ) -> Result<CancelCrawlResponse, FirecrawlError> {
        let response = self
            .client
            .delete(self.url(&format!("/crawl/{}", id.as_ref())))
            .headers(self.prepare_headers(None))
            .send()
            .await
            .map_err(|e| {
                FirecrawlError::HttpError(format!("Cancelling crawl {}", id.as_ref()), e)
            })?;

        self.handle_response(response, "cancel crawl").await
    }

    /// Gets errors from a crawl job.
    ///
    /// # Arguments
    ///
    /// * `id` - The crawl job ID.
    ///
    /// # Returns
    ///
    /// A `CrawlErrorsResponse` containing error details.
    ///
    /// # Example
    ///
    /// ```no_run
    /// use firecrawl::v2::Client;
    ///
    /// #[tokio::main]
    /// async fn main() -> Result<(), Box<dyn std::error::Error>> {
    ///     let client = Client::new("your-api-key")?;
    ///
    ///     let errors = client.get_crawl_errors("job-id").await?;
    ///     for error in errors.errors {
    ///         println!("Error on {}: {}", error.url, error.error);
    ///     }
    ///
    ///     Ok(())
    /// }
    /// ```
    pub async fn get_crawl_errors(
        &self,
        id: impl AsRef<str>,
    ) -> Result<CrawlErrorsResponse, FirecrawlError> {
        let response = self
            .client
            .get(self.url(&format!("/crawl/{}/errors", id.as_ref())))
            .headers(self.prepare_headers(None))
            .send()
            .await
            .map_err(|e| {
                FirecrawlError::HttpError(format!("Getting crawl errors {}", id.as_ref()), e)
            })?;

        self.handle_response(response, "crawl errors").await
    }
}

/// Converts a v2 Document to a v1 Document for error compatibility.
pub(crate) fn convert_v2_document_to_v1_pub(doc: Document) -> crate::document::Document {
    convert_v2_document_to_v1(doc)
}

/// Converts a v2 Document to a v1 Document for error compatibility.
fn convert_v2_document_to_v1(doc: Document) -> crate::document::Document {
    let metadata = doc.metadata.unwrap_or_default();
    crate::document::Document {
        markdown: doc.markdown,
        html: doc.html,
        raw_html: doc.raw_html,
        screenshot: doc.screenshot,
        links: doc.links,
        extract: doc.json,
        metadata: crate::document::DocumentMetadata {
            source_url: metadata.source_url.unwrap_or_default(),
            status_code: metadata.status_code.unwrap_or(0),
            error: metadata.error,
            title: metadata.title,
            description: metadata.description,
            language: metadata.language,
            keywords: metadata.keywords,
            robots: metadata.robots,
            og_title: metadata.og_title,
            og_description: metadata.og_description,
            og_url: metadata.og_url,
            og_image: metadata.og_image,
            og_audio: metadata.og_audio,
            og_determiner: metadata.og_determiner,
            og_locale: metadata.og_locale,
            og_locale_alternate: metadata.og_locale_alternate,
            og_site_name: metadata.og_site_name,
            og_video: metadata.og_video,
            article_section: metadata.article_section,
            article_tag: metadata.article_tag,
            published_time: metadata.published_time,
            modified_time: metadata.modified_time,
            dcterms_keywords: metadata.dcterms_keywords,
            dc_description: metadata.dc_description,
            dc_subject: metadata.dc_subject,
            dcterms_subject: metadata.dcterms_subject,
            dcterms_audience: metadata.dcterms_audience,
            dc_type: metadata.dc_type,
            dcterms_type: metadata.dcterms_type,
            dc_date: metadata.dc_date,
            dc_date_created: metadata.dc_date_created,
            dcterms_created: metadata.dcterms_created,
        },
        warning: doc.warning,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn test_start_crawl_with_mock() {
        let mut server = mockito::Server::new_async().await;

        let mock = server
            .mock("POST", "/v2/crawl")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                json!({
                    "success": true,
                    "id": "crawl-123",
                    "url": "https://api.firecrawl.dev/v2/crawl/crawl-123"
                })
                .to_string(),
            )
            .create();

        let client = Client::new_selfhosted(server.url(), Some("test_key")).unwrap();
        let response = client
            .start_crawl("https://example.com", None)
            .await
            .unwrap();

        assert!(response.success);
        assert_eq!(response.id, "crawl-123");
        mock.assert();
    }

    #[tokio::test]
    async fn test_get_crawl_status_with_mock() {
        let mut server = mockito::Server::new_async().await;

        let mock = server
            .mock("GET", "/v2/crawl/crawl-123")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                json!({
                    "status": "completed",
                    "total": 5,
                    "completed": 5,
                    "creditsUsed": 5,
                    "expiresAt": "2024-12-31T23:59:59Z",
                    "data": [
                        {
                            "markdown": "# Page 1",
                            "metadata": {
                                "sourceURL": "https://example.com/page1",
                                "statusCode": 200
                            }
                        },
                        {
                            "markdown": "# Page 2",
                            "metadata": {
                                "sourceURL": "https://example.com/page2",
                                "statusCode": 200
                            }
                        }
                    ]
                })
                .to_string(),
            )
            .create();

        let client = Client::new_selfhosted(server.url(), Some("test_key")).unwrap();
        let status = client.get_crawl_status("crawl-123").await.unwrap();

        assert_eq!(status.status, JobStatus::Completed);
        assert_eq!(status.total, 5);
        assert_eq!(status.completed, 5);
        assert_eq!(status.data.len(), 2);
        mock.assert();
    }

    #[tokio::test]
    async fn test_cancel_crawl_with_mock() {
        let mut server = mockito::Server::new_async().await;

        let mock = server
            .mock("DELETE", "/v2/crawl/crawl-123")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                json!({
                    "status": "cancelled"
                })
                .to_string(),
            )
            .create();

        let client = Client::new_selfhosted(server.url(), Some("test_key")).unwrap();
        let response = client.cancel_crawl("crawl-123").await.unwrap();

        assert_eq!(response.status, "cancelled");
        mock.assert();
    }

    #[tokio::test]
    async fn test_get_crawl_errors_with_mock() {
        let mut server = mockito::Server::new_async().await;

        let mock = server
            .mock("GET", "/v2/crawl/crawl-123/errors")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                json!({
                    "errors": [
                        {
                            "id": "error-1",
                            "timestamp": "2024-01-01T00:00:00Z",
                            "url": "https://example.com/broken",
                            "error": "404 Not Found"
                        }
                    ],
                    "robotsBlocked": [
                        "https://example.com/admin"
                    ]
                })
                .to_string(),
            )
            .create();

        let client = Client::new_selfhosted(server.url(), Some("test_key")).unwrap();
        let errors = client.get_crawl_errors("crawl-123").await.unwrap();

        assert_eq!(errors.errors.len(), 1);
        assert_eq!(errors.errors[0].url, "https://example.com/broken");
        assert_eq!(errors.robots_blocked.len(), 1);
        mock.assert();
    }

    #[tokio::test]
    async fn test_crawl_with_options() {
        let mut server = mockito::Server::new_async().await;

        // Mock the start endpoint
        let start_mock = server
            .mock("POST", "/v2/crawl")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                json!({
                    "success": true,
                    "id": "crawl-456",
                    "url": "https://api.firecrawl.dev/v2/crawl/crawl-456"
                })
                .to_string(),
            )
            .create();

        // Mock the status endpoint (completed immediately)
        let status_mock = server
            .mock("GET", "/v2/crawl/crawl-456")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                json!({
                    "status": "completed",
                    "total": 2,
                    "completed": 2,
                    "data": [
                        {
                            "markdown": "# Page 1",
                            "metadata": { "sourceURL": "https://example.com/1", "statusCode": 200 }
                        }
                    ]
                })
                .to_string(),
            )
            .create();

        let client = Client::new_selfhosted(server.url(), Some("test_key")).unwrap();
        let options = CrawlOptions {
            limit: Some(10),
            sitemap: Some(SitemapMode::Include),
            ..Default::default()
        };

        let result = client.crawl("https://example.com", options).await.unwrap();

        assert_eq!(result.status, JobStatus::Completed);
        assert_eq!(result.data.len(), 1);
        start_mock.assert();
        status_mock.assert();
    }
}
