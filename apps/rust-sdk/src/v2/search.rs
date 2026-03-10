//! Search endpoint for Firecrawl API v2.

use serde::{Deserialize, Serialize};

use super::client::Client;
use super::scrape::ScrapeOptions;
use super::types::{
    Document, SearchCategory, SearchResultImage, SearchResultNews, SearchResultWeb, SearchSource,
};
use crate::FirecrawlError;

/// Options for search requests.
#[serde_with::skip_serializing_none]
#[derive(Deserialize, Serialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SearchOptions {
    /// Maximum number of results to return. Default: 5, Max: 20.
    pub limit: Option<u32>,

    /// Search sources to query (web, news, images).
    pub sources: Option<Vec<SearchSource>>,

    /// Categories to filter results (github, research, pdf).
    pub categories: Option<Vec<SearchCategory>>,

    /// Time-based search filter (e.g., "qdr:d" for past day).
    pub tbs: Option<String>,

    /// Geographic location string for local search results.
    pub location: Option<String>,

    /// Whether to ignore invalid URLs in results.
    pub ignore_invalid_urls: Option<bool>,

    /// Timeout in milliseconds.
    pub timeout: Option<u32>,

    /// Scrape options to apply to each search result.
    pub scrape_options: Option<ScrapeOptions>,

    /// Integration identifier for tracking.
    pub integration: Option<String>,
}

/// Request body for search endpoint.
#[derive(Deserialize, Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
struct SearchRequest {
    query: String,
    #[serde(flatten)]
    options: SearchOptions,
}

/// Search results data structure.
#[serde_with::skip_serializing_none]
#[derive(Deserialize, Serialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SearchData {
    /// Web search results (may include scraped documents).
    pub web: Option<Vec<SearchResultOrDocument>>,
    /// News search results.
    pub news: Option<Vec<SearchResultNews>>,
    /// Image search results.
    pub images: Option<Vec<SearchResultImage>>,
}

/// A search result that may be a simple result or a full document.
///
/// Uses custom deserialization to properly distinguish between web results
/// and scraped documents by checking for document-specific fields.
#[derive(Serialize, Debug, Clone)]
#[serde(untagged)]
pub enum SearchResultOrDocument {
    /// Simple web search result.
    WebResult(SearchResultWeb),
    /// Full scraped document.
    Document(Document),
}

impl<'de> serde::Deserialize<'de> for SearchResultOrDocument {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        use serde_json::Value;

        let value = Value::deserialize(deserializer)?;

        // Check for document-specific fields that indicate scraped content
        // If any of these exist, it's a Document, not a simple WebResult
        let is_document = value.get("markdown").is_some()
            || value.get("html").is_some()
            || value.get("rawHtml").is_some()
            || value.get("metadata").is_some();

        if is_document {
            Document::deserialize(value)
                .map(SearchResultOrDocument::Document)
                .map_err(serde::de::Error::custom)
        } else {
            SearchResultWeb::deserialize(value)
                .map(SearchResultOrDocument::WebResult)
                .map_err(serde::de::Error::custom)
        }
    }
}

/// Response from search endpoint.
#[derive(Deserialize, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SearchResponse {
    /// Whether the request was successful.
    pub success: bool,
    /// Search results data.
    pub data: SearchData,
    /// Warning message if any.
    pub warning: Option<String>,
}

impl Client {
    /// Searches the web and optionally scrapes the results.
    ///
    /// # Arguments
    ///
    /// * `query` - The search query string.
    /// * `options` - Optional search configuration.
    ///
    /// # Returns
    ///
    /// A `SearchResponse` containing the search results.
    ///
    /// # Example
    ///
    /// ```no_run
    /// use firecrawl::v2::{Client, SearchOptions, SearchSource};
    ///
    /// #[tokio::main]
    /// async fn main() -> Result<(), Box<dyn std::error::Error>> {
    ///     let client = Client::new("your-api-key")?;
    ///
    ///     // Simple search
    ///     let results = client.search("rust programming", None).await?;
    ///     for result in results.data.web.unwrap_or_default() {
    ///         match result {
    ///             firecrawl::v2::SearchResultOrDocument::WebResult(r) => {
    ///                 println!("URL: {}", r.url);
    ///             }
    ///             firecrawl::v2::SearchResultOrDocument::Document(d) => {
    ///                 println!("Content: {:?}", d.markdown);
    ///             }
    ///         }
    ///     }
    ///
    ///     // Search with options
    ///     let options = SearchOptions {
    ///         limit: Some(10),
    ///         sources: Some(vec![SearchSource::Web, SearchSource::News]),
    ///         ..Default::default()
    ///     };
    ///     let results = client.search("rust programming", options).await?;
    ///
    ///     Ok(())
    /// }
    /// ```
    pub async fn search(
        &self,
        query: impl AsRef<str>,
        options: impl Into<Option<SearchOptions>>,
    ) -> Result<SearchResponse, FirecrawlError> {
        let body = SearchRequest {
            query: query.as_ref().to_string(),
            options: options.into().unwrap_or_default(),
        };

        let headers = self.prepare_headers(None);

        let response = self
            .client
            .post(self.url("/search"))
            .headers(headers)
            .json(&body)
            .send()
            .await
            .map_err(|e| {
                FirecrawlError::HttpError(format!("Searching for {:?}", query.as_ref()), e)
            })?;

        self.handle_response(response, "search").await
    }

    /// Searches the web and scrapes the results.
    ///
    /// This is a convenience method that enables scraping for all results.
    ///
    /// # Arguments
    ///
    /// * `query` - The search query string.
    /// * `limit` - Maximum number of results to return.
    ///
    /// # Returns
    ///
    /// A vector of scraped documents.
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
    ///     let documents = client.search_and_scrape("rust programming", 5).await?;
    ///     for doc in documents {
    ///         println!("Title: {:?}", doc.metadata.and_then(|m| m.title));
    ///         println!("Content: {:?}", doc.markdown);
    ///     }
    ///
    ///     Ok(())
    /// }
    /// ```
    pub async fn search_and_scrape(
        &self,
        query: impl AsRef<str>,
        limit: u32,
    ) -> Result<Vec<Document>, FirecrawlError> {
        let options = SearchOptions {
            limit: Some(limit),
            scrape_options: Some(ScrapeOptions::default()),
            ..Default::default()
        };

        let response = self.search(query, options).await?;

        let documents: Vec<Document> = response
            .data
            .web
            .unwrap_or_default()
            .into_iter()
            .filter_map(|result| match result {
                SearchResultOrDocument::Document(doc) => Some(doc),
                SearchResultOrDocument::WebResult(_) => None,
            })
            .collect();

        Ok(documents)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn test_search_with_mock() {
        let mut server = mockito::Server::new_async().await;

        let mock = server
            .mock("POST", "/v2/search")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                json!({
                    "success": true,
                    "data": {
                        "web": [
                            {
                                "url": "https://example.com",
                                "title": "Example Domain",
                                "description": "This domain is for examples"
                            },
                            {
                                "url": "https://example.org",
                                "title": "Another Example",
                                "description": "More examples"
                            }
                        ]
                    }
                })
                .to_string(),
            )
            .create();

        let client = Client::new_selfhosted(server.url(), Some("test_key")).unwrap();
        let response = client.search("test query", None).await.unwrap();

        assert!(response.success);
        let web_results = response.data.web.unwrap();
        assert_eq!(web_results.len(), 2);
        mock.assert();
    }

    #[tokio::test]
    async fn test_search_with_options() {
        let mut server = mockito::Server::new_async().await;

        let mock = server
            .mock("POST", "/v2/search")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                json!({
                    "success": true,
                    "data": {
                        "web": [
                            {
                                "url": "https://example.com",
                                "title": "Test Result",
                                "description": "A test result"
                            }
                        ],
                        "news": [
                            {
                                "title": "Breaking News",
                                "url": "https://news.example.com",
                                "snippet": "Something happened",
                                "date": "2024-01-01"
                            }
                        ]
                    }
                })
                .to_string(),
            )
            .create();

        let client = Client::new_selfhosted(server.url(), Some("test_key")).unwrap();
        let options = SearchOptions {
            limit: Some(10),
            sources: Some(vec![SearchSource::Web, SearchSource::News]),
            ..Default::default()
        };

        let response = client.search("test", options).await.unwrap();

        assert!(response.success);
        assert!(response.data.web.is_some());
        assert!(response.data.news.is_some());
        mock.assert();
    }

    #[tokio::test]
    async fn test_search_and_scrape() {
        let mut server = mockito::Server::new_async().await;

        let mock = server
            .mock("POST", "/v2/search")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                json!({
                    "success": true,
                    "data": {
                        "web": [
                            {
                                "markdown": "# Example\n\nThis is the scraped content.",
                                "metadata": {
                                    "sourceURL": "https://example.com",
                                    "statusCode": 200,
                                    "title": "Example"
                                }
                            }
                        ]
                    }
                })
                .to_string(),
            )
            .create();

        let client = Client::new_selfhosted(server.url(), Some("test_key")).unwrap();
        let documents = client.search_and_scrape("test", 5).await.unwrap();

        assert_eq!(documents.len(), 1);
        assert!(documents[0].markdown.is_some());
        mock.assert();
    }

    #[tokio::test]
    async fn test_search_error_response() {
        let mut server = mockito::Server::new_async().await;

        let mock = server
            .mock("POST", "/v2/search")
            .with_status(400)
            .with_header("content-type", "application/json")
            .with_body(
                json!({
                    "success": false,
                    "error": "Invalid query"
                })
                .to_string(),
            )
            .create();

        let client = Client::new_selfhosted(server.url(), Some("test_key")).unwrap();
        let result = client.search("", None).await;

        assert!(result.is_err());
        mock.assert();
    }

    #[tokio::test]
    async fn test_search_mixed_results_deserialization() {
        // Test that results with markdown/metadata are correctly identified as Documents
        // and simple results are identified as WebResults
        let mut server = mockito::Server::new_async().await;

        let mock = server
            .mock("POST", "/v2/search")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                json!({
                    "success": true,
                    "data": {
                        "web": [
                            // Simple web result (no markdown/metadata)
                            {
                                "url": "https://example.com/simple",
                                "title": "Simple Result",
                                "description": "Just a search result"
                            },
                            // Scraped document with url AND markdown
                            {
                                "url": "https://example.com/scraped",
                                "markdown": "# Scraped Content\n\nThis has content.",
                                "metadata": {
                                    "sourceURL": "https://example.com/scraped",
                                    "statusCode": 200,
                                    "title": "Scraped Page"
                                }
                            }
                        ]
                    }
                })
                .to_string(),
            )
            .create();

        let client = Client::new_selfhosted(server.url(), Some("test_key")).unwrap();
        let response = client.search("test", None).await.unwrap();

        let web_results = response.data.web.unwrap();
        assert_eq!(web_results.len(), 2);

        // First should be WebResult
        match &web_results[0] {
            SearchResultOrDocument::WebResult(r) => {
                assert_eq!(r.url, "https://example.com/simple");
                assert_eq!(r.title, Some("Simple Result".to_string()));
            }
            SearchResultOrDocument::Document(_) => panic!("Expected WebResult, got Document"),
        }

        // Second should be Document (has markdown)
        match &web_results[1] {
            SearchResultOrDocument::Document(d) => {
                assert!(d.markdown.is_some());
                assert!(d.markdown.as_ref().unwrap().contains("Scraped Content"));
            }
            SearchResultOrDocument::WebResult(_) => panic!("Expected Document, got WebResult"),
        }

        mock.assert();
    }
}
