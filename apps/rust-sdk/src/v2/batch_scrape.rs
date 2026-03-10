//! Batch scrape endpoint for Firecrawl API v2.

use serde::{Deserialize, Serialize};

use super::client::Client;
use super::scrape::ScrapeOptions;
use super::types::{CrawlErrorsResponse, Document, JobStatus, WebhookConfig};
use crate::FirecrawlError;

/// Options for batch scraping.
#[serde_with::skip_serializing_none]
#[derive(Deserialize, Serialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BatchScrapeOptions {
    /// Scrape options to apply to all URLs.
    #[serde(flatten)]
    pub options: Option<ScrapeOptions>,

    /// Webhook configuration for job notifications.
    pub webhook: Option<WebhookConfig>,

    /// ID of an existing batch job to append URLs to.
    pub append_to_id: Option<String>,

    /// Whether to ignore invalid URLs instead of failing.
    #[serde(rename = "ignoreInvalidURLs")]
    pub ignore_invalid_urls: Option<bool>,

    /// Maximum concurrent requests.
    pub max_concurrency: Option<u32>,

    /// Enable zero data retention mode.
    pub zero_data_retention: Option<bool>,

    /// Idempotency key for the request.
    #[serde(skip)]
    pub idempotency_key: Option<String>,

    /// Integration identifier for tracking.
    pub integration: Option<String>,

    /// Poll interval for synchronous batch scrape (milliseconds).
    #[serde(skip)]
    pub poll_interval: Option<u64>,
}

/// Request body for batch scrape endpoint.
#[derive(Deserialize, Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
struct BatchScrapeRequest {
    urls: Vec<String>,
    #[serde(flatten)]
    options: BatchScrapeOptions,
}

/// Response from starting a batch scrape job.
#[derive(Deserialize, Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BatchScrapeResponse {
    /// Whether the request was successful.
    pub success: bool,
    /// The batch scrape job ID.
    pub id: String,
    /// URL to check the batch scrape status.
    pub url: String,
    /// URLs that were invalid and ignored.
    #[serde(rename = "invalidURLs")]
    pub invalid_urls: Option<Vec<String>>,
}

/// Status of a batch scrape job.
#[serde_with::skip_serializing_none]
#[derive(Deserialize, Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BatchScrapeJob {
    /// Current status of the batch scrape job.
    pub status: JobStatus,
    /// Number of URLs completed.
    pub completed: u32,
    /// Total number of URLs to scrape.
    pub total: u32,
    /// Credits used by the batch scrape.
    pub credits_used: Option<u32>,
    /// Expiry time of the batch data.
    pub expires_at: Option<String>,
    /// URL for the next page of results.
    pub next: Option<String>,
    /// Scraped documents.
    pub data: Vec<Document>,
}

impl Client {
    /// Starts a batch scrape job asynchronously.
    ///
    /// Returns immediately with a job ID that can be used to check status.
    ///
    /// # Arguments
    ///
    /// * `urls` - List of URLs to scrape.
    /// * `options` - Optional batch scrape configuration.
    ///
    /// # Returns
    ///
    /// A `BatchScrapeResponse` containing the job ID.
    ///
    /// # Example
    ///
    /// ```no_run
    /// use firecrawl::v2::{Client, BatchScrapeOptions};
    ///
    /// #[tokio::main]
    /// async fn main() -> Result<(), Box<dyn std::error::Error>> {
    ///     let client = Client::new("your-api-key")?;
    ///
    ///     let urls = vec![
    ///         "https://example.com".to_string(),
    ///         "https://example.org".to_string(),
    ///     ];
    ///
    ///     let response = client.start_batch_scrape(urls, None).await?;
    ///     println!("Batch job started: {}", response.id);
    ///
    ///     // Check status later
    ///     let status = client.get_batch_scrape_status(&response.id).await?;
    ///     println!("Completed: {}/{}", status.completed, status.total);
    ///
    ///     Ok(())
    /// }
    /// ```
    pub async fn start_batch_scrape(
        &self,
        urls: Vec<String>,
        options: impl Into<Option<BatchScrapeOptions>>,
    ) -> Result<BatchScrapeResponse, FirecrawlError> {
        let options = options.into().unwrap_or_default();
        let body = BatchScrapeRequest {
            urls,
            options: options.clone(),
        };

        let headers = self.prepare_headers(options.idempotency_key.as_ref());

        let response = self
            .client
            .post(self.url("/batch/scrape"))
            .headers(headers)
            .json(&body)
            .send()
            .await
            .map_err(|e| FirecrawlError::HttpError("Starting batch scrape".to_string(), e))?;

        self.handle_response(response, "start batch scrape").await
    }

    /// Gets the status of a batch scrape job.
    ///
    /// If the job is completed, this will automatically fetch all pages of results.
    ///
    /// # Arguments
    ///
    /// * `id` - The batch scrape job ID.
    ///
    /// # Returns
    ///
    /// A `BatchScrapeJob` containing the current status and any available documents.
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
    ///     let status = client.get_batch_scrape_status("job-id").await?;
    ///     println!("Status: {:?}", status.status);
    ///     println!("Completed: {}/{}", status.completed, status.total);
    ///     println!("Documents: {}", status.data.len());
    ///
    ///     Ok(())
    /// }
    /// ```
    pub async fn get_batch_scrape_status(
        &self,
        id: impl AsRef<str>,
    ) -> Result<BatchScrapeJob, FirecrawlError> {
        let response = self
            .client
            .get(self.url(&format!("/batch/scrape/{}", id.as_ref())))
            .headers(self.prepare_headers(None))
            .send()
            .await
            .map_err(|e| {
                FirecrawlError::HttpError(
                    format!("Checking batch scrape status {}", id.as_ref()),
                    e,
                )
            })?;

        let mut status: BatchScrapeJob = self
            .handle_response(response, format!("batch scrape status {}", id.as_ref()))
            .await?;

        // Auto-paginate if completed
        if status.status == JobStatus::Completed {
            while let Some(next) = status.next.take() {
                let next_status = self.get_batch_scrape_status_next(&next).await?;
                status.data.extend(next_status.data);
                status.next = next_status.next;
            }
        }

        Ok(status)
    }

    /// Fetches the next page of batch scrape results.
    async fn get_batch_scrape_status_next(
        &self,
        next: &str,
    ) -> Result<BatchScrapeJob, FirecrawlError> {
        let response = self
            .client
            .get(next)
            .headers(self.prepare_headers(None))
            .send()
            .await
            .map_err(|e| {
                FirecrawlError::HttpError(format!("Paginating batch scrape at {}", next), e)
            })?;

        self.handle_response(response, "batch scrape pagination")
            .await
    }

    /// Scrapes multiple URLs and waits for completion.
    ///
    /// This method starts a batch scrape and polls until it completes or fails.
    ///
    /// # Arguments
    ///
    /// * `urls` - List of URLs to scrape.
    /// * `options` - Optional batch scrape configuration.
    ///
    /// # Returns
    ///
    /// A `BatchScrapeJob` containing all scraped documents.
    ///
    /// # Example
    ///
    /// ```no_run
    /// use firecrawl::v2::{Client, BatchScrapeOptions, ScrapeOptions, Format};
    ///
    /// #[tokio::main]
    /// async fn main() -> Result<(), Box<dyn std::error::Error>> {
    ///     let client = Client::new("your-api-key")?;
    ///
    ///     let urls = vec![
    ///         "https://example.com/page1".to_string(),
    ///         "https://example.com/page2".to_string(),
    ///         "https://example.com/page3".to_string(),
    ///     ];
    ///
    ///     let options = BatchScrapeOptions {
    ///         options: Some(ScrapeOptions {
    ///             formats: Some(vec![Format::Markdown, Format::Links]),
    ///             ..Default::default()
    ///         }),
    ///         ignore_invalid_urls: Some(true),
    ///         poll_interval: Some(3000),
    ///         ..Default::default()
    ///     };
    ///
    ///     let result = client.batch_scrape(urls, options).await?;
    ///     println!("Scraped {} pages", result.data.len());
    ///
    ///     for doc in result.data {
    ///         println!("URL: {:?}", doc.metadata.and_then(|m| m.source_url));
    ///     }
    ///
    ///     Ok(())
    /// }
    /// ```
    pub async fn batch_scrape(
        &self,
        urls: Vec<String>,
        options: impl Into<Option<BatchScrapeOptions>>,
    ) -> Result<BatchScrapeJob, FirecrawlError> {
        let options = options.into().unwrap_or_default();
        let poll_interval = options.poll_interval.unwrap_or(2000);

        let response = self.start_batch_scrape(urls, options).await?;
        self.wait_for_batch_scrape(&response.id, poll_interval)
            .await
    }

    /// Waits for a batch scrape job to complete.
    async fn wait_for_batch_scrape(
        &self,
        id: &str,
        poll_interval: u64,
    ) -> Result<BatchScrapeJob, FirecrawlError> {
        loop {
            let status = self.get_batch_scrape_status(id).await?;

            match status.status {
                JobStatus::Completed => return Ok(status),
                JobStatus::Scraping => {
                    tokio::time::sleep(tokio::time::Duration::from_millis(poll_interval)).await;
                }
                JobStatus::Failed => {
                    return Err(FirecrawlError::CrawlJobFailed(
                        "Batch scrape job failed".to_string(),
                        convert_batch_job_to_crawl_status(status),
                    ));
                }
                JobStatus::Cancelled => {
                    return Err(FirecrawlError::CrawlJobFailed(
                        "Batch scrape job was cancelled".to_string(),
                        convert_batch_job_to_crawl_status(status),
                    ));
                }
            }
        }
    }

    /// Gets errors from a batch scrape job.
    ///
    /// # Arguments
    ///
    /// * `id` - The batch scrape job ID.
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
    ///     let errors = client.get_batch_scrape_errors("job-id").await?;
    ///     for error in errors.errors {
    ///         println!("Error on {}: {}", error.url, error.error);
    ///     }
    ///
    ///     Ok(())
    /// }
    /// ```
    pub async fn get_batch_scrape_errors(
        &self,
        id: impl AsRef<str>,
    ) -> Result<CrawlErrorsResponse, FirecrawlError> {
        let response = self
            .client
            .get(self.url(&format!("/batch/scrape/{}/errors", id.as_ref())))
            .headers(self.prepare_headers(None))
            .send()
            .await
            .map_err(|e| {
                FirecrawlError::HttpError(format!("Getting batch scrape errors {}", id.as_ref()), e)
            })?;

        self.handle_response(response, "batch scrape errors").await
    }
}

/// Converts a BatchScrapeJob to CrawlStatus for error compatibility.
fn convert_batch_job_to_crawl_status(job: BatchScrapeJob) -> crate::crawl::CrawlStatus {
    crate::crawl::CrawlStatus {
        status: match job.status {
            JobStatus::Completed => crate::crawl::CrawlStatusTypes::Completed,
            JobStatus::Scraping => crate::crawl::CrawlStatusTypes::Scraping,
            JobStatus::Failed => crate::crawl::CrawlStatusTypes::Failed,
            JobStatus::Cancelled => crate::crawl::CrawlStatusTypes::Cancelled,
        },
        total: job.total,
        completed: job.completed,
        credits_used: job.credits_used.unwrap_or(0),
        expires_at: job.expires_at.unwrap_or_default(),
        next: job.next,
        data: job
            .data
            .into_iter()
            .map(|d| super::crawl::convert_v2_document_to_v1_pub(d))
            .collect(),
    }
}

impl super::crawl::CrawlJob {
    /// Helper function to convert v2 document to v1 format.
    pub(crate) fn _convert_document(doc: Document) -> crate::document::Document {
        super::crawl::convert_v2_document_to_v1_pub(doc)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn test_start_batch_scrape_with_mock() {
        let mut server = mockito::Server::new_async().await;

        let mock = server
            .mock("POST", "/v2/batch/scrape")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                json!({
                    "success": true,
                    "id": "batch-123",
                    "url": "https://api.firecrawl.dev/v2/batch/scrape/batch-123"
                })
                .to_string(),
            )
            .create();

        let client = Client::new_selfhosted(server.url(), Some("test_key")).unwrap();
        let urls = vec![
            "https://example.com".to_string(),
            "https://example.org".to_string(),
        ];

        let response = client.start_batch_scrape(urls, None).await.unwrap();

        assert!(response.success);
        assert_eq!(response.id, "batch-123");
        mock.assert();
    }

    #[tokio::test]
    async fn test_get_batch_scrape_status_with_mock() {
        let mut server = mockito::Server::new_async().await;

        let mock = server
            .mock("GET", "/v2/batch/scrape/batch-123")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                json!({
                    "status": "completed",
                    "total": 3,
                    "completed": 3,
                    "creditsUsed": 3,
                    "data": [
                        {
                            "markdown": "# Page 1",
                            "metadata": { "sourceURL": "https://example.com/1", "statusCode": 200 }
                        },
                        {
                            "markdown": "# Page 2",
                            "metadata": { "sourceURL": "https://example.com/2", "statusCode": 200 }
                        }
                    ]
                })
                .to_string(),
            )
            .create();

        let client = Client::new_selfhosted(server.url(), Some("test_key")).unwrap();
        let status = client.get_batch_scrape_status("batch-123").await.unwrap();

        assert_eq!(status.status, JobStatus::Completed);
        assert_eq!(status.total, 3);
        assert_eq!(status.completed, 3);
        assert_eq!(status.data.len(), 2);
        mock.assert();
    }

    #[tokio::test]
    async fn test_batch_scrape_with_invalid_urls() {
        let mut server = mockito::Server::new_async().await;

        let mock = server
            .mock("POST", "/v2/batch/scrape")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                json!({
                    "success": true,
                    "id": "batch-456",
                    "url": "https://api.firecrawl.dev/v2/batch/scrape/batch-456",
                    "invalidURLs": ["not-a-url"]
                })
                .to_string(),
            )
            .create();

        let client = Client::new_selfhosted(server.url(), Some("test_key")).unwrap();
        let urls = vec!["https://example.com".to_string(), "not-a-url".to_string()];

        let options = BatchScrapeOptions {
            ignore_invalid_urls: Some(true),
            ..Default::default()
        };

        let response = client.start_batch_scrape(urls, options).await.unwrap();

        assert!(response.success);
        assert_eq!(response.invalid_urls, Some(vec!["not-a-url".to_string()]));
        mock.assert();
    }

    #[tokio::test]
    async fn test_batch_scrape_sync() {
        let mut server = mockito::Server::new_async().await;

        // Mock the start endpoint
        let start_mock = server
            .mock("POST", "/v2/batch/scrape")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                json!({
                    "success": true,
                    "id": "batch-789",
                    "url": "https://api.firecrawl.dev/v2/batch/scrape/batch-789"
                })
                .to_string(),
            )
            .create();

        // Mock the status endpoint (completed immediately)
        let status_mock = server
            .mock("GET", "/v2/batch/scrape/batch-789")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                json!({
                    "status": "completed",
                    "total": 2,
                    "completed": 2,
                    "data": [
                        {
                            "markdown": "# Content",
                            "metadata": { "sourceURL": "https://example.com", "statusCode": 200 }
                        }
                    ]
                })
                .to_string(),
            )
            .create();

        let client = Client::new_selfhosted(server.url(), Some("test_key")).unwrap();
        let urls = vec!["https://example.com".to_string()];

        let result = client.batch_scrape(urls, None).await.unwrap();

        assert_eq!(result.status, JobStatus::Completed);
        assert_eq!(result.data.len(), 1);
        start_mock.assert();
        status_mock.assert();
    }

    #[tokio::test]
    async fn test_get_batch_scrape_errors() {
        let mut server = mockito::Server::new_async().await;

        let mock = server
            .mock("GET", "/v2/batch/scrape/batch-123/errors")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                json!({
                    "errors": [
                        {
                            "id": "err-1",
                            "url": "https://example.com/broken",
                            "error": "Connection timeout"
                        }
                    ],
                    "robotsBlocked": []
                })
                .to_string(),
            )
            .create();

        let client = Client::new_selfhosted(server.url(), Some("test_key")).unwrap();
        let errors = client.get_batch_scrape_errors("batch-123").await.unwrap();

        assert_eq!(errors.errors.len(), 1);
        assert_eq!(errors.errors[0].error, "Connection timeout");
        mock.assert();
    }
}
