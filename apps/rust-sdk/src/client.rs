//! Firecrawl API v2 client.

use reqwest::Response;
use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::error::FirecrawlError;
use crate::types::JobStatus;

pub(crate) const API_VERSION: &str = "/v2";
const CLOUD_API_URL: &str = "https://api.firecrawl.dev";

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

        Ok(Client {
            api_key,
            api_url: url,
            client: reqwest::Client::new(),
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
        // A body-read failure on a non-2xx response still carries a status worth reporting.
        let body = match response.text().await {
            Ok(body) => body,
            Err(e) if is_success => return Err(FirecrawlError::ResponseParseErrorText(e)),
            Err(_) => {
                let reason = status.canonical_reason().unwrap_or("unknown status");
                return Err(FirecrawlError::HttpRequestFailed(
                    action.as_ref().to_string(),
                    status.as_u16(),
                    reason.to_string(),
                ));
            }
        };

        let response = serde_json::from_str::<Value>(&body)
            .map_err(FirecrawlError::ResponseParseError)
            .and_then(|response_value| {
                // success:false is an APIError unless the body also carries a job status (e.g. a
                // crawl that failed at kickoff), in which case it's routed through T instead.
                if response_value["success"].as_bool() == Some(false)
                    && !has_job_status(&response_value)
                {
                    Err(FirecrawlError::APIError(
                        action.as_ref().to_string(),
                        serde_json::from_value(response_value)
                            .map_err(FirecrawlError::ResponseParseError)?,
                    ))
                } else {
                    serde_json::from_value::<T>(response_value)
                        .map_err(FirecrawlError::ResponseParseError)
                }
            });

        match response {
            // A non-2xx response that isn't a Firecrawl error body: report the real reason and body, not just the code.
            Err(FirecrawlError::ResponseParseError(_)) if !is_success => {
                let reason = status.canonical_reason().unwrap_or("unknown status");
                let snippet: String = body.chars().take(200).collect();
                let detail = if snippet.is_empty() {
                    reason.to_string()
                } else {
                    format!("{reason}: {snippet}")
                };
                Err(FirecrawlError::HttpRequestFailed(
                    action.as_ref().to_string(),
                    status.as_u16(),
                    detail,
                ))
            }
            other => other,
        }
    }

    /// Builds the full URL for an API endpoint.
    pub(crate) fn url(&self, path: &str) -> String {
        format!("{}{}{}", self.api_url, API_VERSION, path)
    }
}

/// True when `value["status"]` is a recognized `JobStatus`, marking a crawl/batch job payload.
fn has_job_status(value: &Value) -> bool {
    value
        .get("status")
        .is_some_and(|s| serde_json::from_value::<JobStatus>(s.clone()).is_ok())
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
}
