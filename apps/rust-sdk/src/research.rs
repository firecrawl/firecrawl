//! Research endpoints for Firecrawl API v2.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

use crate::client::Client;
use crate::FirecrawlError;

#[serde_with::skip_serializing_none]
#[derive(Deserialize, Serialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PaperResult {
    pub paper_id: Option<String>,
    pub primary_id: Option<String>,
    pub ids: Option<HashMap<String, Value>>,
    pub title: Option<String>,
    #[serde(rename = "abstract")]
    pub abstract_text: Option<String>,
    pub score: Option<f64>,
    pub year: Option<i32>,
    pub authors: Option<Vec<String>>,
    pub venue: Option<String>,
    pub url: Option<String>,
    pub signals: Option<HashMap<String, Value>>,
}

#[serde_with::skip_serializing_none]
#[derive(Deserialize, Serialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PaperMetadata {
    pub paper_id: Option<String>,
    pub ids: Option<HashMap<String, Value>>,
    pub title: Option<String>,
    #[serde(rename = "abstract")]
    pub abstract_text: Option<String>,
    pub authors: Option<String>,
    pub categories: Option<Vec<String>>,
    pub created_date: Option<String>,
    pub update_date: Option<String>,
}

#[serde_with::skip_serializing_none]
#[derive(Deserialize, Serialize, Debug, Default, Clone)]
pub struct Passage {
    pub text: Option<String>,
    pub section: Option<String>,
    pub page: Option<i32>,
    pub score: Option<f64>,
    pub metadata: Option<HashMap<String, Value>>,
}

#[derive(Deserialize, Serialize, Debug, Default, Clone)]
pub struct SearchPapersResponse {
    pub success: bool,
    pub results: Vec<PaperResult>,
}

#[derive(Deserialize, Serialize, Debug, Default, Clone)]
pub struct PaperMetadataResponse {
    pub success: bool,
    pub paper: PaperMetadata,
}

#[derive(Deserialize, Serialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ReadPaperResponse {
    pub success: bool,
    pub paper: PaperMetadata,
    pub paper_id: Option<String>,
    pub query: Option<String>,
    pub passages: Option<Vec<Passage>>,
}

#[derive(Deserialize, Serialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SimilarPapersResponse {
    pub success: bool,
    pub results: Vec<PaperResult>,
    pub pool_size: Option<i32>,
    pub truncated: bool,
    pub note: Option<String>,
}

#[serde_with::skip_serializing_none]
#[derive(Deserialize, Serialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitHubSearchItem {
    pub result_type: Option<String>,
    pub repo: Option<String>,
    pub url: Option<String>,
    pub page_type: Option<String>,
    pub number: Option<i32>,
    pub segment_count: Option<i32>,
    pub readme_url: Option<String>,
    pub title: Option<String>,
    pub snippet: Option<String>,
    pub content_md: Option<String>,
    pub scores: Option<HashMap<String, Value>>,
}

#[derive(Deserialize, Serialize, Debug, Default, Clone)]
pub struct GitHubSearchResponse {
    pub success: bool,
    pub results: Vec<GitHubSearchItem>,
}

#[derive(Debug, Default, Clone)]
pub struct SearchPapersOptions {
    pub k: Option<u32>,
    pub authors: Option<Vec<String>>,
    pub categories: Option<Vec<String>>,
    pub from: Option<String>,
    pub to: Option<String>,
}

#[derive(Debug, Default, Clone)]
pub struct ReadPaperOptions {
    pub k: Option<u32>,
}

#[derive(Debug, Default, Clone)]
pub struct RelatedPapersOptions {
    pub mode: Option<String>,
    pub k: Option<u32>,
    pub rerank: Option<bool>,
    pub anchor: Option<Vec<String>>,
}

#[derive(Debug, Default, Clone)]
pub struct SearchGitHubOptions {
    pub k: Option<u32>,
}

fn push_query(query: &mut Vec<(String, String)>, key: &str, value: impl ToString) {
    query.push((key.to_string(), value.to_string()));
}

fn path_escape(value: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            out.push(byte as char);
        } else {
            out.push('%');
            out.push(HEX[(byte >> 4) as usize] as char);
            out.push(HEX[(byte & 0x0f) as usize] as char);
        }
    }
    out
}

impl Client {
    pub async fn search_papers(
        &self,
        query_text: impl AsRef<str>,
        options: impl Into<Option<SearchPapersOptions>>,
    ) -> Result<SearchPapersResponse, FirecrawlError> {
        let mut query = vec![
            ("query".to_string(), query_text.as_ref().to_string()),
            (
                "origin".to_string(),
                format!("rust-sdk@{}", env!("CARGO_PKG_VERSION")),
            ),
        ];
        if let Some(options) = options.into() {
            if let Some(k) = options.k {
                push_query(&mut query, "k", k);
            }
            for author in options.authors.unwrap_or_default() {
                push_query(&mut query, "authors", author);
            }
            for category in options.categories.unwrap_or_default() {
                push_query(&mut query, "categories", category);
            }
            if let Some(from) = options.from {
                push_query(&mut query, "from", from);
            }
            if let Some(to) = options.to {
                push_query(&mut query, "to", to);
            }
        }

        let response = self
            .client
            .get(self.url("/search/research/papers"))
            .headers(self.prepare_headers(None))
            .query(&query)
            .send()
            .await
            .map_err(|e| FirecrawlError::HttpError("search papers".to_string(), e))?;

        self.handle_response(response, "search papers").await
    }

    pub async fn inspect_paper(
        &self,
        paper_id: impl AsRef<str>,
    ) -> Result<PaperMetadataResponse, FirecrawlError> {
        let response = self
            .client
            .get(self.url(&format!(
                "/search/research/papers/{}",
                path_escape(paper_id.as_ref())
            )))
            .headers(self.prepare_headers(None))
            .send()
            .await
            .map_err(|e| FirecrawlError::HttpError("inspect paper".to_string(), e))?;

        self.handle_response(response, "inspect paper").await
    }

    pub async fn read_paper(
        &self,
        paper_id: impl AsRef<str>,
        query_text: impl AsRef<str>,
        options: impl Into<Option<ReadPaperOptions>>,
    ) -> Result<ReadPaperResponse, FirecrawlError> {
        let mut query = vec![
            ("query".to_string(), query_text.as_ref().to_string()),
            (
                "origin".to_string(),
                format!("rust-sdk@{}", env!("CARGO_PKG_VERSION")),
            ),
        ];
        if let Some(options) = options.into() {
            if let Some(k) = options.k {
                push_query(&mut query, "k", k);
            }
        }

        let response = self
            .client
            .get(self.url(&format!(
                "/search/research/papers/{}",
                path_escape(paper_id.as_ref())
            )))
            .headers(self.prepare_headers(None))
            .query(&query)
            .send()
            .await
            .map_err(|e| FirecrawlError::HttpError("read paper".to_string(), e))?;

        self.handle_response(response, "read paper").await
    }

    pub async fn related_papers(
        &self,
        paper_id: impl AsRef<str>,
        intent: impl AsRef<str>,
        options: impl Into<Option<RelatedPapersOptions>>,
    ) -> Result<SimilarPapersResponse, FirecrawlError> {
        let mut query = vec![
            ("intent".to_string(), intent.as_ref().to_string()),
            (
                "origin".to_string(),
                format!("rust-sdk@{}", env!("CARGO_PKG_VERSION")),
            ),
        ];
        if let Some(options) = options.into() {
            if let Some(mode) = options.mode {
                push_query(&mut query, "mode", mode);
            }
            if let Some(k) = options.k {
                push_query(&mut query, "k", k);
            }
            if let Some(rerank) = options.rerank {
                push_query(&mut query, "rerank", rerank);
            }
            for anchor in options.anchor.unwrap_or_default() {
                push_query(&mut query, "anchor", anchor);
            }
        }

        let response = self
            .client
            .get(self.url(&format!(
                "/search/research/papers/{}/similar",
                path_escape(paper_id.as_ref())
            )))
            .headers(self.prepare_headers(None))
            .query(&query)
            .send()
            .await
            .map_err(|e| FirecrawlError::HttpError("related papers".to_string(), e))?;

        self.handle_response(response, "related papers").await
    }

    pub async fn search_github(
        &self,
        query_text: impl AsRef<str>,
        options: impl Into<Option<SearchGitHubOptions>>,
    ) -> Result<GitHubSearchResponse, FirecrawlError> {
        let mut query = vec![
            ("query".to_string(), query_text.as_ref().to_string()),
            (
                "origin".to_string(),
                format!("rust-sdk@{}", env!("CARGO_PKG_VERSION")),
            ),
        ];
        if let Some(options) = options.into() {
            if let Some(k) = options.k {
                push_query(&mut query, "k", k);
            }
        }

        let response = self
            .client
            .get(self.url("/search/research/github"))
            .headers(self.prepare_headers(None))
            .query(&query)
            .send()
            .await
            .map_err(|e| FirecrawlError::HttpError("search github".to_string(), e))?;

        self.handle_response(response, "search github").await
    }
}
