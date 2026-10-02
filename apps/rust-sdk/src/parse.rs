//! Parse endpoint for Firecrawl API v2.

use std::path::Path;

use reqwest::multipart::{Form, Part};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use super::client::Client;
use super::scrape::ParserConfig;
use super::types::{AttributeSelector, Document, JsonOptions};
use crate::{AuditMetadata, FirecrawlError};

/// Uploaded file payload for the `/v2/parse` endpoint.
#[derive(Debug, Clone)]
pub struct ParseFile {
    pub filename: String,
    pub bytes: Vec<u8>,
    pub content_type: Option<String>,
}

impl ParseFile {
    /// Build a parse file from in-memory bytes.
    pub fn from_bytes(filename: impl Into<String>, bytes: Vec<u8>) -> Self {
        Self {
            filename: filename.into(),
            bytes,
            content_type: None,
        }
    }

    /// Build a parse file by reading bytes from disk.
    pub fn from_path(path: impl AsRef<Path>) -> Result<Self, FirecrawlError> {
        let path_ref = path.as_ref();
        let bytes = std::fs::read(path_ref).map_err(|e| {
            FirecrawlError::Misuse(format!(
                "Failed to read parse file {}: {}",
                path_ref.display(),
                e
            ))
        })?;
        let filename = path_ref
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| {
                FirecrawlError::Misuse("Could not derive a valid filename from path".to_string())
            })?
            .to_string();

        Ok(Self {
            filename,
            bytes,
            content_type: None,
        })
    }

    /// Attach a content type hint (e.g. `text/html`, `application/pdf`).
    pub fn with_content_type(mut self, content_type: impl Into<String>) -> Self {
        self.content_type = Some(content_type.into());
        self
    }
}

/// Response from parse endpoint.
#[derive(Deserialize, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
struct ParseResponse {
    success: bool,
    data: Document,
    #[serde(skip_serializing_if = "Option::is_none")]
    warning: Option<String>,
}

/// Proxy settings accepted by `/v2/parse`.
#[derive(Deserialize, Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ParseProxyType {
    Basic,
    Auto,
}

/// Output formats accepted by `/v2/parse`.
#[derive(Deserialize, Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ParseFormat {
    Markdown,
    Html,
    RawHtml,
    Links,
    Images,
    Summary,
    Json,
    Attributes,
}

/// Kind of upload a parse format covers.
#[derive(Deserialize, Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ParseFormatKind {
    Document,
    Image,
    /// A kind this SDK release does not know about. Read-only catch-all so new
    /// server-side kinds don't fail the whole response.
    #[serde(other)]
    Unknown,
}

/// One upload format listed by `GET /v2/parse/formats`.
#[derive(Deserialize, Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ParseFormatInfo {
    /// Format name, e.g. `pdf` or `docx`.
    pub format: String,
    /// Whether this is a document or an image format.
    pub kind: ParseFormatKind,
    /// File extensions accepted for this format, e.g. `.pdf`.
    pub extensions: Vec<String>,
    /// MIME types accepted for this format.
    pub mime_types: Vec<String>,
    /// Whether this deployment currently accepts the format.
    pub available: bool,
}

#[derive(Deserialize, Debug)]
struct ParseFormatsData {
    formats: Vec<ParseFormatInfo>,
}

#[derive(Deserialize, Debug)]
struct ParseFormatsResponse {
    data: ParseFormatsData,
}

/// Options accepted by the `/v2/parse` endpoint.
///
/// This intentionally omits scrape-only fields that `/v2/parse` rejects
/// (e.g. actions, waitFor, location, and screenshot/branding/changeTracking options).
#[serde_with::skip_serializing_none]
#[derive(Deserialize, Serialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ParseOptions {
    /// Output formats to include in the response.
    pub formats: Option<Vec<ParseFormat>>,
    /// Additional HTTP headers.
    pub headers: Option<HashMap<String, String>>,
    /// HTML tags to include.
    pub include_tags: Option<Vec<String>>,
    /// HTML tags to exclude.
    pub exclude_tags: Option<Vec<String>>,
    /// Extract only the main content.
    pub only_main_content: Option<bool>,
    /// Timeout in milliseconds.
    pub timeout: Option<u32>,
    /// Parser configurations (e.g. PDF parser).
    pub parsers: Option<Vec<ParserConfig>>,
    /// Skip TLS verification.
    pub skip_tls_verification: Option<bool>,
    /// Remove base64 images.
    pub remove_base64_images: Option<bool>,
    /// Fast mode.
    pub fast_mode: Option<bool>,
    /// Mock fixture id to use.
    pub use_mock: Option<String>,
    /// Block ads.
    pub block_ads: Option<bool>,
    /// Proxy type.
    pub proxy: Option<ParseProxyType>,
    /// Integration identifier.
    pub integration: Option<String>,
    /// Redact personally identifiable information from returned content.
    #[serde(rename = "redactPII")]
    pub redact_pii: Option<bool>,
    /// User attribution to include with SIEM logging events.
    pub audit_metadata: Option<AuditMetadata>,
    /// Origin label for request attribution (e.g., "rust-sdk@2.16.1").
    /// Defaults to `rust-sdk@<version>` when unset.
    pub origin: Option<String>,
    /// Zero data retention mode.
    pub zero_data_retention: Option<bool>,
    /// JSON extraction options.
    pub json_options: Option<JsonOptions>,
    /// Attribute selectors for extraction.
    pub attribute_selectors: Option<Vec<AttributeSelector>>,
}

impl Client {
    /// Parse an uploaded file and return the extracted document.
    pub async fn parse(
        &self,
        file: ParseFile,
        options: impl Into<Option<ParseOptions>>,
    ) -> Result<Document, FirecrawlError> {
        let resolved_filename = file.filename.trim().to_string();
        if resolved_filename.is_empty() {
            return Err(FirecrawlError::Misuse(
                "filename cannot be empty".to_string(),
            ));
        }

        if file.bytes.is_empty() {
            return Err(FirecrawlError::Misuse(
                "file content cannot be empty".to_string(),
            ));
        }

        let mut options = options.into().unwrap_or_default();
        if options.origin.is_none() {
            options.origin = Some(format!("rust-sdk@{}", env!("CARGO_PKG_VERSION")));
        }
        let options_json =
            serde_json::to_string(&options).map_err(FirecrawlError::ResponseParseError)?;

        let mut part = Part::bytes(file.bytes).file_name(resolved_filename);
        if let Some(content_type) = file.content_type {
            part = part.mime_str(&content_type).map_err(|e| {
                FirecrawlError::Misuse(format!("Invalid content type for parse file: {}", e))
            })?;
        }

        let form = Form::new().text("options", options_json).part("file", part);
        let headers = self.prepare_multipart_headers(None);

        let response = self
            .client
            .post(self.url("/parse"))
            .headers(headers)
            .multipart(form)
            .send()
            .await
            .map_err(|e| FirecrawlError::HttpError("Parsing uploaded file".to_string(), e))?;

        let response: ParseResponse = self.handle_response(response, "parse").await?;
        Ok(response.data)
    }

    /// Lists the upload formats `/v2/parse` accepts on this deployment.
    pub async fn get_parse_formats(&self) -> Result<Vec<ParseFormatInfo>, FirecrawlError> {
        let response = self
            .client
            .get(self.url("/parse/formats"))
            .headers(self.prepare_headers(None))
            .send()
            .await
            .map_err(|e| FirecrawlError::HttpError("Getting parse formats".to_string(), e))?;

        let response: ParseFormatsResponse =
            self.handle_response(response, "get parse formats").await?;
        Ok(response.data.formats)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mockito::Matcher;
    use serde_json::json;

    #[tokio::test]
    async fn test_parse_with_mock() {
        let mut server = mockito::Server::new_async().await;
        let mock = server
            .mock("POST", "/v2/parse")
            .match_header(
                "content-type",
                Matcher::Regex("multipart/form-data".to_string()),
            )
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                json!({
                    "success": true,
                    "data": {
                        "markdown": "# Parsed File",
                        "metadata": {
                            "sourceURL": "https://parse.firecrawl.dev/uploads/upload.html",
                            "statusCode": 200
                        }
                    }
                })
                .to_string(),
            )
            .create();

        let client = Client::new_selfhosted(server.url(), Some("test_key")).unwrap();
        let file = ParseFile::from_bytes("upload.html", b"<html><body>ok</body></html>".to_vec())
            .with_content_type("text/html");
        let doc = client.parse(file, None).await.unwrap();

        assert!(doc.markdown.is_some());
        assert!(doc.markdown.unwrap().contains("Parsed File"));
        mock.assert();
    }

    #[tokio::test]
    async fn test_parse_injects_sdk_origin() {
        let mut server = mockito::Server::new_async().await;

        // The options travel as a JSON text field inside the multipart body;
        // the mock only matches when that JSON carries the SDK origin, so a
        // regression in the injection fails the request itself.
        let mock = server
            .mock("POST", "/v2/parse")
            .match_body(Matcher::Regex(format!(
                "\"origin\":\"rust-sdk@{}\"",
                env!("CARGO_PKG_VERSION")
            )))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                json!({
                    "success": true,
                    "data": {
                        "markdown": "# Parsed File",
                        "metadata": {
                            "sourceURL": "https://parse.firecrawl.dev/uploads/upload.html",
                            "statusCode": 200
                        }
                    }
                })
                .to_string(),
            )
            .create();

        let client = Client::new_selfhosted(server.url(), Some("test_key")).unwrap();
        let file = ParseFile::from_bytes("upload.html", b"<html><body>ok</body></html>".to_vec())
            .with_content_type("text/html");
        let doc = client.parse(file, None).await.unwrap();

        assert!(doc.markdown.is_some());
        mock.assert();
    }

    #[tokio::test]
    async fn test_get_parse_formats() -> Result<(), FirecrawlError> {
        let mut server = mockito::Server::new_async().await;
        let mock = server
            .mock("GET", "/v2/parse/formats")
            .match_header("authorization", "Bearer test_key")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                json!({
                    "success": true,
                    "data": {
                        "formats": [
                            {
                                "format": "pdf",
                                "kind": "document",
                                "extensions": [".pdf"],
                                "mimeTypes": ["application/pdf"],
                                "available": true
                            },
                            {
                                "format": "png",
                                "kind": "image",
                                "extensions": [".png"],
                                "mimeTypes": ["image/png"],
                                "available": false
                            }
                        ]
                    }
                })
                .to_string(),
            )
            .create();

        let client = Client::new_selfhosted(server.url(), Some("test_key"))?;
        let formats = client.get_parse_formats().await?;

        assert_eq!(
            formats,
            vec![
                ParseFormatInfo {
                    format: "pdf".to_string(),
                    kind: ParseFormatKind::Document,
                    extensions: vec![".pdf".to_string()],
                    mime_types: vec!["application/pdf".to_string()],
                    available: true,
                },
                ParseFormatInfo {
                    format: "png".to_string(),
                    kind: ParseFormatKind::Image,
                    extensions: vec![".png".to_string()],
                    mime_types: vec!["image/png".to_string()],
                    available: false,
                },
            ]
        );
        mock.assert();
        Ok(())
    }

    #[tokio::test]
    async fn test_get_parse_formats_tolerates_unknown_kind_and_fields() -> Result<(), FirecrawlError>
    {
        let mut server = mockito::Server::new_async().await;
        let mock = server
            .mock("GET", "/v2/parse/formats")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                json!({
                    "success": true,
                    "data": {
                        "formats": [
                            {
                                "format": "glb",
                                "kind": "model",
                                "extensions": [".glb"],
                                "mimeTypes": ["model/gltf-binary"],
                                "available": true,
                                "maxBytes": 1048576
                            }
                        ],
                        "version": 2
                    }
                })
                .to_string(),
            )
            .create();

        let client = Client::new_selfhosted(server.url(), Some("test_key"))?;
        let formats = client.get_parse_formats().await?;

        assert_eq!(formats.len(), 1);
        assert_eq!(formats[0].format, "glb");
        assert_eq!(formats[0].kind, ParseFormatKind::Unknown);
        assert_eq!(formats[0].mime_types, vec!["model/gltf-binary"]);
        assert!(formats[0].available);
        mock.assert();
        Ok(())
    }

    #[tokio::test]
    async fn test_get_parse_formats_unauthorized() -> Result<(), FirecrawlError> {
        let mut server = mockito::Server::new_async().await;
        let mock = server
            .mock("GET", "/v2/parse/formats")
            .with_status(401)
            .with_header("content-type", "application/json")
            .with_body(
                json!({
                    "success": false,
                    "error": "Unauthorized: Invalid token"
                })
                .to_string(),
            )
            .create();

        let client = Client::new_selfhosted(server.url(), Some("bad_key"))?;
        let result = client.get_parse_formats().await;

        assert!(
            matches!(
                &result,
                Err(FirecrawlError::APIError(_, api_error))
                    if api_error.error == "Unauthorized: Invalid token"
            ),
            "Expected APIError, got: {:?}",
            result
        );
        mock.assert();
        Ok(())
    }

    #[tokio::test]
    async fn test_get_parse_formats_server_error() -> Result<(), FirecrawlError> {
        let mut server = mockito::Server::new_async().await;
        let mock = server
            .mock("GET", "/v2/parse/formats")
            .with_status(500)
            .with_body("Internal Server Error")
            .create();

        let client = Client::new_selfhosted(server.url(), Some("test_key"))?;
        let result = client.get_parse_formats().await;

        assert!(
            matches!(&result, Err(FirecrawlError::HttpRequestFailed(_, 500, _))),
            "Expected HttpRequestFailed with 500, got: {:?}",
            result
        );
        mock.assert();
        Ok(())
    }

    #[test]
    fn test_parse_file_from_missing_path() {
        let result = ParseFile::from_path("/tmp/this-file-should-not-exist-for-parse-sdk-test");
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_parse_error_response() {
        let mut server = mockito::Server::new_async().await;

        let mock = server
            .mock("POST", "/v2/parse")
            .match_header(
                "content-type",
                Matcher::Regex("multipart/form-data".to_string()),
            )
            .with_status(400)
            .with_header("content-type", "application/json")
            .with_body(
                json!({
                    "success": false,
                    "error": "Unsupported upload type."
                })
                .to_string(),
            )
            .create();

        let client = Client::new_selfhosted(server.url(), Some("test_key")).unwrap();
        let file = ParseFile::from_bytes("upload.xyz", b"not a real file".to_vec());
        let result = client.parse(file, None).await;

        assert!(result.is_err());
        mock.assert();
    }

    #[test]
    fn test_parse_rejects_empty_bytes() {
        let file = ParseFile::from_bytes("empty.html", vec![]);
        let rt = tokio::runtime::Runtime::new().unwrap();
        let result = rt.block_on(async {
            let client = Client::new_selfhosted("http://localhost:9999", Some("k")).unwrap();
            client.parse(file, None).await
        });

        assert!(result.is_err());
        let err_msg = format!("{}", result.unwrap_err());
        assert!(
            err_msg.contains("empty"),
            "Expected empty file error, got: {}",
            err_msg
        );
    }
}
