//! Firecrawl API v2 client.

use reqwest::Response;
use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::error::{FirecrawlAPIError, FirecrawlError};

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
/// use firecrawl::v2::Client;
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
    /// use firecrawl::v2::Client;
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
    /// use firecrawl::v2::Client;
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

        // Reject empty or missing API key for cloud service
        if url == CLOUD_API_URL {
            match &api_key {
                None => {
                    return Err(FirecrawlError::APIError(
                        "Configuration".to_string(),
                        FirecrawlAPIError {
                            success: false,
                            error: "API key is required for cloud service".to_string(),
                            details: None,
                        },
                    ));
                }
                Some(key) if key.trim().is_empty() => {
                    return Err(FirecrawlError::APIError(
                        "Configuration".to_string(),
                        FirecrawlAPIError {
                            success: false,
                            error: "API key cannot be empty for cloud service".to_string(),
                            details: None,
                        },
                    ));
                }
                _ => {}
            }
        }

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
            // API key is validated at client creation, so this should always succeed.
            // Use if-let to gracefully handle edge cases without panicking.
            if let Ok(value) = format!("Bearer {}", api_key).parse() {
                headers.insert("Authorization", value);
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
                    .inspect(|data| {
                        tracing::debug!("Response JSON: {:#?}", data);
                    })
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
    fn test_new_client_requires_api_key_for_cloud() {
        let result = Client::new_selfhosted(CLOUD_API_URL, None::<&str>);
        assert!(result.is_err());
    }

    #[test]
    fn test_new_client_rejects_empty_api_key_for_cloud() {
        let result = Client::new_selfhosted(CLOUD_API_URL, Some(""));
        assert!(result.is_err());

        let result = Client::new_selfhosted(CLOUD_API_URL, Some("   "));
        assert!(result.is_err());
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
        // Cloud URL with trailing slash should still require API key
        let result = Client::new_selfhosted("https://api.firecrawl.dev/", None::<&str>);
        assert!(result.is_err());

        // Should work with API key
        let client = Client::new_selfhosted("https://api.firecrawl.dev/", Some("key")).unwrap();
        assert_eq!(client.api_url, "https://api.firecrawl.dev");

        // Self-hosted URL normalization
        let client = Client::new_selfhosted("http://localhost:3000/", None::<&str>).unwrap();
        assert_eq!(client.api_url, "http://localhost:3000");
    }
}
