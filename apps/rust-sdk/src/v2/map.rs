//! Map endpoint for Firecrawl API v2.

use serde::{Deserialize, Serialize};

use super::client::Client;
use super::types::{LocationConfig, SearchResultWeb, SitemapMode};
use crate::FirecrawlError;

/// Options for mapping a URL.
#[serde_with::skip_serializing_none]
#[derive(Deserialize, Serialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MapOptions {
    /// Search query to filter discovered links.
    pub search: Option<String>,

    /// How to handle the sitemap.
    pub sitemap: Option<SitemapMode>,

    /// Include subdomains in the mapping.
    pub include_subdomains: Option<bool>,

    /// Ignore query parameters when deduplicating URLs.
    pub ignore_query_parameters: Option<bool>,

    /// Maximum number of links to return.
    pub limit: Option<u32>,

    /// Timeout in milliseconds.
    pub timeout: Option<u32>,

    /// Integration identifier for tracking.
    pub integration: Option<String>,

    /// Location configuration for proxy routing.
    pub location: Option<LocationConfig>,
}

/// Request body for map endpoint.
#[derive(Deserialize, Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
struct MapRequest {
    url: String,
    #[serde(flatten)]
    options: MapOptions,
}

/// Response from map endpoint.
#[derive(Deserialize, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MapResponse {
    /// Whether the request was successful.
    pub success: bool,
    /// Discovered links with metadata.
    pub links: Vec<SearchResultWeb>,
    /// Warning message if any.
    pub warning: Option<String>,
}

impl Client {
    /// Maps a URL to discover all associated links.
    ///
    /// This endpoint discovers links from a website's sitemap, page content,
    /// and other sources without fully scraping each page.
    ///
    /// # Arguments
    ///
    /// * `url` - The URL to map.
    /// * `options` - Optional mapping configuration.
    ///
    /// # Returns
    ///
    /// A `MapResponse` containing the discovered links.
    ///
    /// # Example
    ///
    /// ```no_run
    /// use firecrawl::v2::{Client, MapOptions, SitemapMode};
    ///
    /// #[tokio::main]
    /// async fn main() -> Result<(), Box<dyn std::error::Error>> {
    ///     let client = Client::new("your-api-key")?;
    ///
    ///     // Simple map
    ///     let response = client.map("https://example.com", None).await?;
    ///     println!("Found {} links", response.links.len());
    ///
    ///     // Map with options
    ///     let options = MapOptions {
    ///         sitemap: Some(SitemapMode::Include),
    ///         include_subdomains: Some(true),
    ///         limit: Some(1000),
    ///         ..Default::default()
    ///     };
    ///     let response = client.map("https://example.com", options).await?;
    ///
    ///     for link in response.links {
    ///         println!("URL: {}, Title: {:?}", link.url, link.title);
    ///     }
    ///
    ///     Ok(())
    /// }
    /// ```
    pub async fn map(
        &self,
        url: impl AsRef<str>,
        options: impl Into<Option<MapOptions>>,
    ) -> Result<MapResponse, FirecrawlError> {
        let body = MapRequest {
            url: url.as_ref().to_string(),
            options: options.into().unwrap_or_default(),
        };

        let headers = self.prepare_headers(None);

        let response = self
            .client
            .post(self.url("/map"))
            .headers(headers)
            .json(&body)
            .send()
            .await
            .map_err(|e| FirecrawlError::HttpError(format!("Mapping {:?}", url.as_ref()), e))?;

        self.handle_response(response, "map").await
    }

    /// Maps a URL and returns just the list of URLs.
    ///
    /// This is a convenience method that returns only the URL strings.
    ///
    /// # Arguments
    ///
    /// * `url` - The URL to map.
    /// * `options` - Optional mapping configuration.
    ///
    /// # Returns
    ///
    /// A vector of discovered URL strings.
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
    ///     let urls = client.map_urls("https://example.com", None).await?;
    ///     for url in urls {
    ///         println!("{}", url);
    ///     }
    ///
    ///     Ok(())
    /// }
    /// ```
    pub async fn map_urls(
        &self,
        url: impl AsRef<str>,
        options: impl Into<Option<MapOptions>>,
    ) -> Result<Vec<String>, FirecrawlError> {
        let response = self.map(url, options).await?;
        Ok(response.links.into_iter().map(|link| link.url).collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn test_map_with_mock() {
        let mut server = mockito::Server::new_async().await;

        let mock = server
            .mock("POST", "/v2/map")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                json!({
                    "success": true,
                    "links": [
                        {
                            "url": "https://example.com/",
                            "title": "Example Domain",
                            "description": "Home page"
                        },
                        {
                            "url": "https://example.com/about",
                            "title": "About Us"
                        },
                        {
                            "url": "https://example.com/contact"
                        }
                    ]
                })
                .to_string(),
            )
            .create();

        let client = Client::new_selfhosted(server.url(), Some("test_key")).unwrap();
        let response = client.map("https://example.com", None).await.unwrap();

        assert!(response.success);
        assert_eq!(response.links.len(), 3);
        assert_eq!(response.links[0].url, "https://example.com/");
        assert_eq!(response.links[0].title, Some("Example Domain".to_string()));
        mock.assert();
    }

    #[tokio::test]
    async fn test_map_with_options() {
        let mut server = mockito::Server::new_async().await;

        let mock = server
            .mock("POST", "/v2/map")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                json!({
                    "success": true,
                    "links": [
                        { "url": "https://example.com/page1" },
                        { "url": "https://example.com/page2" }
                    ]
                })
                .to_string(),
            )
            .create();

        let client = Client::new_selfhosted(server.url(), Some("test_key")).unwrap();
        let options = MapOptions {
            sitemap: Some(SitemapMode::Include),
            include_subdomains: Some(true),
            limit: Some(100),
            ..Default::default()
        };

        let response = client.map("https://example.com", options).await.unwrap();

        assert!(response.success);
        assert_eq!(response.links.len(), 2);
        mock.assert();
    }

    #[tokio::test]
    async fn test_map_urls() {
        let mut server = mockito::Server::new_async().await;

        let mock = server
            .mock("POST", "/v2/map")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                json!({
                    "success": true,
                    "links": [
                        { "url": "https://example.com/page1" },
                        { "url": "https://example.com/page2" },
                        { "url": "https://example.com/page3" }
                    ]
                })
                .to_string(),
            )
            .create();

        let client = Client::new_selfhosted(server.url(), Some("test_key")).unwrap();
        let urls = client.map_urls("https://example.com", None).await.unwrap();

        assert_eq!(urls.len(), 3);
        assert_eq!(urls[0], "https://example.com/page1");
        mock.assert();
    }

    #[tokio::test]
    async fn test_map_with_search_filter() {
        let mut server = mockito::Server::new_async().await;

        let mock = server
            .mock("POST", "/v2/map")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                json!({
                    "success": true,
                    "links": [
                        { "url": "https://example.com/blog/post1" },
                        { "url": "https://example.com/blog/post2" }
                    ]
                })
                .to_string(),
            )
            .create();

        let client = Client::new_selfhosted(server.url(), Some("test_key")).unwrap();
        let options = MapOptions {
            search: Some("blog".to_string()),
            ..Default::default()
        };

        let response = client.map("https://example.com", options).await.unwrap();

        assert!(response.success);
        assert_eq!(response.links.len(), 2);
        mock.assert();
    }

    #[tokio::test]
    async fn test_map_error_response() {
        let mut server = mockito::Server::new_async().await;

        let mock = server
            .mock("POST", "/v2/map")
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
        let result = client.map("invalid-url", None).await;

        assert!(result.is_err());
        mock.assert();
    }
}
