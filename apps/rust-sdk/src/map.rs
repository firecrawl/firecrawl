use serde::{Deserialize, Serialize};

use crate::{FirecrawlApp, FirecrawlError, API_VERSION};

#[serde_with::skip_serializing_none]
#[derive(Deserialize, Serialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Location {
    /// Country code (ISO 3166-1 alpha-2)
    pub country: Option<String>,
    
    /// List of language codes
    pub languages: Option<Vec<String>>,
}

#[serde_with::skip_serializing_none]
#[derive(Deserialize, Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct MapOptions {
    /// Search query to use for mapping
    pub search: Option<String>,

    /// Ignore the website sitemap when crawling (default: `true`)
    pub ignore_sitemap: Option<bool>,

    /// Include subdomains of the website (default: `true`)
    pub include_subdomains: Option<bool>,

    /// Maximum number of links to return (default: `5000`)
    pub limit: Option<u32>,

    /// Location configuration for proxy location
    pub location: Option<Location>,
}

#[derive(Deserialize, Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
struct MapRequestBody {
    url: String,

    #[serde(flatten)]
    options: MapOptions,
}

#[derive(Deserialize, Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
struct MapResponse {
    success: bool,

    links: Vec<String>,
}

impl FirecrawlApp {
    /// Returns links from a URL using the Firecrawl API.
    pub async fn map_url(
        &self,
        url: impl AsRef<str>,
        options: impl Into<Option<MapOptions>>,
    ) -> Result<Vec<String>, FirecrawlError> {
        let body = MapRequestBody {
            url: url.as_ref().to_string(),
            options: options.into().unwrap_or_default(),
        };

        let headers = self.prepare_headers(None);

        let response = self
            .client
            .post(&format!("{}{}/map", self.api_url, API_VERSION))
            .headers(headers)
            .json(&body)
            .send()
            .await
            .map_err(|e| FirecrawlError::HttpError(format!("Mapping {:?}", url.as_ref()), e))?;

        let response = self
            .handle_response::<MapResponse>(response, "scrape URL")
            .await?;

        Ok(response.links)
    }
}
