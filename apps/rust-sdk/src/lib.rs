use reqwest::{Client, Response};
use serde::de::DeserializeOwned;
use serde_json::Value;

pub mod batch_scrape;
pub mod crawl;
pub mod document;
mod error;
pub mod extract;
pub mod llmstxt;
pub mod map;
pub mod parse;
pub mod scrape;
pub mod search;

use error::FirecrawlAPIError;
pub use error::FirecrawlError;

#[derive(Clone, Debug)]
pub struct FirecrawlApp {
    api_key: Option<String>,
    api_url: String,
    client: Client,
}

pub(crate) const API_VERSION: &str = "/v1";
pub(crate) const API_VERSION_V2: &str = "/v2";
const CLOUD_API_URL: &str = "https://api.firecrawl.dev";

impl FirecrawlApp {
    pub fn new(api_key: impl AsRef<str>) -> Result<Self, FirecrawlError> {
        FirecrawlApp::new_selfhosted(CLOUD_API_URL, Some(api_key))
    }

    pub fn new_selfhosted(
        api_url: impl AsRef<str>,
        api_key: Option<impl AsRef<str>>,
    ) -> Result<Self, FirecrawlError> {
        let url = api_url.as_ref().to_string();

        if url == CLOUD_API_URL && api_key.is_none() {
            return Err(FirecrawlError::APIError(
                "Configuration".to_string(),
                FirecrawlAPIError {
                    success: false,
                    error: "API key is required for cloud service".to_string(),
                    details: None,
                },
            ));
        }

        Ok(FirecrawlApp {
            api_key: api_key.map(|x| x.as_ref().to_string()),
            api_url: url,
            client: Client::new(),
        })
    }

    fn prepare_headers(&self, idempotency_key: Option<&String>) -> reqwest::header::HeaderMap {
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert("Content-Type", "application/json".parse().unwrap());
        if let Some(api_key) = self.api_key.as_ref() {
            headers.insert(
                "Authorization",
                format!("Bearer {}", api_key).parse().unwrap(),
            );
        }
        if let Some(key) = idempotency_key {
            headers.insert("x-idempotency-key", key.parse().unwrap());
        }
        headers
    }

    async fn handle_response<'a, T: DeserializeOwned>(
        &self,
        response: Response,
        action: impl AsRef<str>,
    ) -> Result<T, FirecrawlError> {
        let (is_success, status) = (response.status().is_success(), response.status());

        let response = response
            .text()
            .await
            .map_err(|e| FirecrawlError::ResponseParseErrorText(e))
            .and_then(|response_json| {
                serde_json::from_str::<Value>(&response_json)
                    .map_err(|e| FirecrawlError::ResponseParseError(e))
                    .inspect(|data| {
                        tracing::debug!("Response JSON: {:#?}", data);
                    })
            })
            .and_then(|response_value| {
                if action.as_ref().starts_with("crawl_") // no success in check/cancel crawl responses
                    || response_value["success"].as_bool().unwrap_or(false)
                {
                    Ok(serde_json::from_value::<T>(response_value)
                        .map_err(|e| FirecrawlError::ResponseParseError(e))?)
                } else {
                    Err(FirecrawlError::APIError(
                        action.as_ref().to_string(),
                        serde_json::from_value(response_value)
                            .map_err(|e| FirecrawlError::ResponseParseError(e))?,
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
}
