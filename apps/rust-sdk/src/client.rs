//! Firecrawl API v2 client.

use std::time::Duration;

use reqwest::Response;
use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::error::FirecrawlError;

pub(crate) const API_VERSION: &str = "/v2";
const CLOUD_API_URL: &str = "https://api.firecrawl.dev";
/// Default per-request HTTP timeout: 300000ms, matching the JS SDK's `timeoutMs` default.
const DEFAULT_TIMEOUT: Duration = Duration::from_millis(300_000);

/// Firecrawl API v2 client.
///
/// This client provides access to all v2 API endpoints including scrape, crawl,
/// search, map, batch scrape, and agent operations.
///
/// # Example
///
/// ```no_run
/// use firecrawl::Client;
///
/// #[tokio::main]
/// async fn main() -> Result<(), Box<dyn std::error::Error>> {
///     // Create a client for the Firecrawl cloud service
///     let client = Client::new("your-api-key")?;
///
///     // Or create a client for a self-hosted instance
///     let client = Client::new_selfhosted("http://localhost:3000", Some("api-key"))?;
///
///     Ok(())
/// }
/// ```
#[derive(Clone, Debug)]
pub struct Client {
    pub(crate) api_key: Option<String>,
    pub(crate) api_url: String,
    pub(crate) client: reqwest::Client,
    pub(crate) timeout: Duration,
}

impl Client {
    /// Creates a new client for the Firecrawl cloud service.
    ///
    /// # Arguments
    ///
    /// * `api_key` - Your Firecrawl API key.
    ///
    /// # Errors
    ///
    /// Returns an error if the API key is empty.
    ///
    /// # Example
    ///
    /// ```no_run
    /// use firecrawl::Client;
    ///
    /// let client = Client::new("your-api-key").unwrap();
    /// ```
    pub fn new(api_key: impl AsRef<str>) -> Result<Self, FirecrawlError> {
        Client::new_selfhosted(CLOUD_API_URL, Some(api_key))
    }

    /// Creates a new client for a self-hosted Firecrawl instance.
    ///
    /// # Arguments
    ///
    /// * `api_url` - The base URL of your Firecrawl instance.
    /// * `api_key` - Optional API key (required for cloud, optional for self-hosted).
    ///
    /// # Errors
    ///
    /// Returns an error if using the cloud service without an API key.
    ///
    /// # Example
    ///
    /// ```no_run
    /// use firecrawl::Client;
    ///
    /// // Self-hosted without authentication
    /// let client = Client::new_selfhosted("http://localhost:3000", None::<&str>).unwrap();
    ///
    /// // Self-hosted with authentication
    /// let client = Client::new_selfhosted("http://localhost:3000", Some("api-key")).unwrap();
    /// ```
    pub fn new_selfhosted(
        api_url: impl AsRef<str>,
        api_key: Option<impl AsRef<str>>,
    ) -> Result<Self, FirecrawlError> {
        // Normalize URL by trimming trailing slashes for consistent comparison
        let url = api_url.as_ref().trim_end_matches('/').to_string();
        let api_key = api_key.map(|k| k.as_ref().to_string());

        // An empty/missing API key is allowed: scrape, search, and interact fall
        // back to the keyless free tier (rate-limited per IP). Other methods
        // return 401 from the API until a key is provided.

        let client = reqwest::Client::builder()
            .timeout(DEFAULT_TIMEOUT)
            .build()
            .map_err(|e| FirecrawlError::Misuse(format!("failed to build HTTP client: {e}")))?;

        Ok(Client {
            api_key,
            api_url: url,
            client,
            timeout: DEFAULT_TIMEOUT,
        })
    }

    /// Overrides the per-request HTTP timeout (default: 5 minutes, matching the JS and Go SDKs).
    ///
    /// Covers the entire HTTP request, including reading the response.
    /// An explicit scrape timeout extends this to at least the server timeout plus 5 seconds.
    ///
    /// # Example
    ///
    /// ```no_run
    /// use firecrawl::Client;
    /// use std::time::Duration;
    ///
    /// # fn main() -> Result<(), Box<dyn std::error::Error>> {
    /// let client = Client::new("your-api-key")?.with_timeout(Duration::from_secs(60))?;
    /// # Ok(())
    /// # }
    /// ```
    pub fn with_timeout(mut self, timeout: Duration) -> Result<Self, FirecrawlError> {
        self.client = reqwest::Client::builder()
            .timeout(timeout)
            .build()
            .map_err(|e| FirecrawlError::Misuse(format!("failed to build HTTP client: {e}")))?;
        self.timeout = timeout;
        Ok(self)
    }

    pub(crate) fn scrape_http_timeout(&self, server_timeout_ms: Option<u32>) -> Duration {
        server_timeout_ms.map_or(self.timeout, |ms| {
            self.timeout
                .max(Duration::from_millis(u64::from(ms) + 5_000))
        })
    }

    /// Prepares headers for API requests.
    pub(crate) fn prepare_headers(
        &self,
        idempotency_key: Option<&String>,
    ) -> reqwest::header::HeaderMap {
        use reqwest::header::HeaderValue;

        let mut headers = reqwest::header::HeaderMap::new();
        // Static string is always valid ASCII
        headers.insert("Content-Type", HeaderValue::from_static("application/json"));
        if let Some(api_key) = self.api_key.as_ref() {
            // Omit the Authorization header entirely when no key is set so that
            // scrape/search/interact can use the keyless free tier.
            if !api_key.trim().is_empty() {
                if let Ok(value) = format!("Bearer {}", api_key).parse() {
                    headers.insert("Authorization", value);
                }
            }
        }
        if let Some(key) = idempotency_key {
            // Gracefully skip invalid idempotency keys instead of panicking
            if let Ok(value) = key.parse() {
                headers.insert("x-idempotency-key", value);
            }
        }
        headers
    }

    /// Prepares headers for multipart requests (without a fixed content type).
    pub(crate) fn prepare_multipart_headers(
        &self,
        idempotency_key: Option<&String>,
    ) -> reqwest::header::HeaderMap {
        let mut headers = self.prepare_headers(idempotency_key);
        headers.remove(reqwest::header::CONTENT_TYPE);
        headers
    }

    /// Handles API responses, parsing JSON and handling errors.
    pub(crate) async fn handle_response<T: DeserializeOwned>(
        &self,
        response: Response,
        action: impl AsRef<str>,
    ) -> Result<T, FirecrawlError> {
        let (is_success, status) = (response.status().is_success(), response.status());

        let response = response
            .text()
            .await
            .map_err(FirecrawlError::ResponseParseErrorText)
            .and_then(|response_json| {
                serde_json::from_str::<Value>(&response_json)
                    .map_err(FirecrawlError::ResponseParseError)
            })
            .and_then(|response_value| {
                // Check for success field, or allow responses without it for status checks
                if action.as_ref().contains("status")
                    || action.as_ref().contains("cancel")
                    || response_value["success"].as_bool().unwrap_or(false)
                    || response_value.get("success").is_none()
                {
                    serde_json::from_value::<T>(response_value)
                        .map_err(FirecrawlError::ResponseParseError)
                } else {
                    Err(FirecrawlError::APIError(
                        action.as_ref().to_string(),
                        serde_json::from_value(response_value)
                            .map_err(FirecrawlError::ResponseParseError)?,
                    ))
                }
            });

        match &response {
            Ok(_) => response,
            Err(FirecrawlError::ResponseParseError(_))
            | Err(FirecrawlError::ResponseParseErrorText(_)) => {
                if is_success {
                    response
                } else {
                    Err(FirecrawlError::HttpRequestFailed(
                        action.as_ref().to_string(),
                        status.as_u16(),
                        status.as_str().to_string(),
                    ))
                }
            }
            Err(_) => response,
        }
    }

    /// Builds the full URL for an API endpoint.
    pub(crate) fn url(&self, path: &str) -> String {
        format!("{}{}{}", self.api_url, API_VERSION, path)
    }

    /// Resolves a pagination `next` URL against `api_url`, rewriting absolute and
    /// protocol-relative URLs onto the `api_url` origin so credentials never leave it.
    pub(crate) fn pin_to_api_origin(&self, next: &str) -> Result<reqwest::Url, FirecrawlError> {
        let mut pinned = reqwest::Url::parse(&format!("{}/", self.api_url))
            .ok()
            .filter(reqwest::Url::has_host)
            .ok_or_else(|| {
                FirecrawlError::Misuse(format!(
                    "api_url must be an absolute URL, got {:?}",
                    self.api_url
                ))
            })?;
        let resolved = pinned.join(next).map_err(|e| {
            FirecrawlError::ResponseParseError(serde::de::Error::custom(format!(
                "invalid pagination URL {:?}: {}",
                next, e
            )))
        })?;
        pinned.set_path(resolved.path());
        pinned.set_query(resolved.query());
        Ok(pinned)
    }
}

#[cfg(test)]
pub(crate) fn foreign_next_urls(api_url: &str, other_port_url: &str, path: &str) -> Vec<String> {
    vec![
        format!("https://evil.example{}", path),
        format!("//evil.example{}", path),
        format!("{}{}", other_port_url, path),
        format!("{}{}", api_url.replacen("http://", "https://", 1), path),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_new_client() {
        let client = Client::new("test-api-key").unwrap();
        assert_eq!(client.api_key, Some("test-api-key".to_string()));
        assert_eq!(client.api_url, CLOUD_API_URL);
    }

    #[test]
    fn test_new_client_allows_no_api_key_for_cloud_keyless() {
        // Keyless free tier: a cloud client with no API key is now allowed.
        let client = Client::new_selfhosted(CLOUD_API_URL, None::<&str>).unwrap();
        assert_eq!(client.api_key, None);
    }

    #[test]
    fn test_new_client_allows_empty_api_key_for_cloud_keyless() {
        // Empty/whitespace keys are no longer rejected (treated as keyless).
        assert!(Client::new_selfhosted(CLOUD_API_URL, Some("")).is_ok());
        assert!(Client::new_selfhosted(CLOUD_API_URL, Some("   ")).is_ok());
    }

    #[test]
    fn test_new_selfhosted_client() {
        let client = Client::new_selfhosted("http://localhost:3000", Some("api-key")).unwrap();
        assert_eq!(client.api_key, Some("api-key".to_string()));
        assert_eq!(client.api_url, "http://localhost:3000");
    }

    #[test]
    fn test_selfhosted_without_api_key() {
        let client = Client::new_selfhosted("http://localhost:3000", None::<&str>).unwrap();
        assert_eq!(client.api_key, None);
        assert_eq!(client.api_url, "http://localhost:3000");
    }

    #[test]
    fn test_url_builder() {
        let client = Client::new("test-key").unwrap();
        assert_eq!(client.url("/scrape"), "https://api.firecrawl.dev/v2/scrape");
    }

    #[test]
    fn test_url_normalization_trailing_slash() {
        // Cloud URL with trailing slash is normalized; no API key required (keyless).
        let client = Client::new_selfhosted("https://api.firecrawl.dev/", None::<&str>).unwrap();
        assert_eq!(client.api_url, "https://api.firecrawl.dev");

        // Should also work with an API key
        let client = Client::new_selfhosted("https://api.firecrawl.dev/", Some("key")).unwrap();
        assert_eq!(client.api_url, "https://api.firecrawl.dev");

        // Self-hosted URL normalization
        let client = Client::new_selfhosted("http://localhost:3000/", None::<&str>).unwrap();
        assert_eq!(client.api_url, "http://localhost:3000");
    }

    #[test]
    fn test_scrape_timeout_buffer() -> Result<(), Box<dyn std::error::Error>> {
        let client = Client::new("test-key")?;
        for (server_ms, expected_secs) in [(None, 300), (Some(60_000), 300), (Some(300_000), 305)] {
            if client.scrape_http_timeout(server_ms) != Duration::from_secs(expected_secs) {
                Err(format!("unexpected HTTP timeout for {server_ms:?}"))?
            }
        }
        let client = client.with_timeout(Duration::from_secs(600))?;
        if client.scrape_http_timeout(Some(300_000)) != Duration::from_secs(600) {
            Err("longer configured client timeout was not preserved")?
        }
        let client = client.with_timeout(Duration::from_secs(15))?;
        if client.scrape_http_timeout(Some(60_000)) != Duration::from_secs(65) {
            Err("explicit server timeout did not extend the client timeout")?
        }
        Ok(())
    }

    #[tokio::test]
    async fn test_with_timeout_cuts_off_a_hung_connection() -> Result<(), Box<dyn std::error::Error>>
    {
        // Accept the connection without responding to simulate a stalled server.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let addr = listener.local_addr()?;
        let server = tokio::spawn(async move {
            let (_socket, _) = listener.accept().await?;
            std::future::pending::<()>().await;
            Ok::<(), std::io::Error>(())
        });

        let result = async {
            let client = Client::new_selfhosted(format!("http://{addr}"), None::<&str>)?
                .with_timeout(Duration::from_millis(200))?;
            let response = tokio::time::timeout(
                Duration::from_secs(5),
                client.scrape("https://example.com", None),
            )
            .await?;

            match response {
                Err(FirecrawlError::HttpError(_, e)) if e.is_timeout() => Ok(()),
                other => Err(format!("expected a timeout HttpError, got: {other:?}").into()),
            }
        }
        .await;

        server.abort();
        match server.await {
            Ok(result) => result?,
            Err(e) if e.is_cancelled() => (),
            Err(e) => Err(e)?,
        }
        result
    }

    #[tokio::test]
    async fn test_with_timeout_still_allows_normal_requests(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let mut server = mockito::Server::new_async().await;
        let mock = server
            .mock("POST", "/v2/scrape")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"{"success":true,"data":{"markdown":"hi"}}"#)
            .create_async()
            .await;

        let client = Client::new_selfhosted(server.url(), None::<&str>)?
            .with_timeout(Duration::from_secs(10))?;
        let doc = client.scrape("https://example.com", None).await?;
        if doc.markdown.as_deref() != Some("hi") {
            Err(format!("unexpected markdown: {:?}", doc.markdown))?
        }
        if !mock.matched_async().await {
            Err("expected scrape request was not received")?
        }
        Ok(())
    }

    #[test]
    fn test_pin_to_api_origin() {
        let client = Client::new_selfhosted("https://api.firecrawl.dev", Some("key")).unwrap();
        let pinned = |next: &str| client.pin_to_api_origin(next).unwrap().to_string();
        let expected = "https://api.firecrawl.dev/v2/crawl/abc?skip=10";

        assert_eq!(
            pinned("https://api.firecrawl.dev/v2/crawl/abc?skip=10"),
            expected
        );
        assert_eq!(
            pinned("https://evil.example/v2/crawl/abc?skip=10"),
            expected
        );
        assert_eq!(pinned("//evil.example/v2/crawl/abc?skip=10"), expected);
        assert_eq!(
            pinned("https://api.firecrawl.dev:8443/v2/crawl/abc?skip=10"),
            expected
        );
        assert_eq!(
            pinned("http://api.firecrawl.dev/v2/crawl/abc?skip=10"),
            expected
        );
        assert_eq!(
            pinned("https://user:pass@evil.example/v2/crawl/abc?skip=10#frag"),
            expected
        );
        assert_eq!(pinned("/v2/crawl/abc?skip=10"), expected);
        assert_eq!(pinned("https://evil.example"), "https://api.firecrawl.dev/");
    }

    #[test]
    fn test_pin_to_api_origin_keeps_self_hosted_port() {
        let client = Client::new_selfhosted("http://localhost:3002/", None::<&str>).unwrap();
        assert_eq!(
            client
                .pin_to_api_origin("https://evil.example:444/v2/batch/scrape/x?skip=5")
                .unwrap()
                .as_str(),
            "http://localhost:3002/v2/batch/scrape/x?skip=5"
        );
    }

    #[test]
    fn test_pin_to_api_origin_reports_malformed_next_as_response_error() {
        let client = Client::new("key").unwrap();
        assert!(matches!(
            client.pin_to_api_origin("https://evil.example:99999/v2/crawl/abc"),
            Err(FirecrawlError::ResponseParseError(_))
        ));
    }

    #[test]
    fn test_pin_to_api_origin_rejects_relative_api_url() {
        let client = Client::new_selfhosted("localhost:3002", None::<&str>).unwrap();
        assert!(matches!(
            client.pin_to_api_origin("https://evil.example/v2/crawl/abc"),
            Err(FirecrawlError::Misuse(_))
        ));
    }
}
