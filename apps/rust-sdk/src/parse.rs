use std::path::Path;

use reqwest::multipart::Form;
use serde::{Deserialize, Serialize};

use crate::{document::Document, FirecrawlApp, FirecrawlError, API_VERSION_V2};

#[derive(Deserialize, Serialize, Debug, Clone)]
pub enum ParseFormats {
    #[serde(rename = "markdown")]
    Markdown,

    #[serde(rename = "html")]
    HTML,

    #[serde(rename = "rawHtml")]
    RawHTML,

    #[serde(rename = "links")]
    Links,

    #[serde(rename = "images")]
    Images,

    #[serde(rename = "summary")]
    Summary,

    #[serde(rename = "json")]
    Json,

    #[serde(rename = "attributes")]
    Attributes,
}

#[serde_with::skip_serializing_none]
#[derive(Deserialize, Serialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ParseOptions {
    pub formats: Option<Vec<ParseFormats>>,
    pub include_tags: Option<Vec<String>>,
    pub exclude_tags: Option<Vec<String>>,
    pub only_main_content: Option<bool>,
    pub timeout: Option<u32>,
    pub parsers: Option<Vec<String>>,
    pub remove_base64_images: Option<bool>,
}

#[derive(Deserialize, Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
struct ParseResponse {
    success: bool,
    data: Document,
}

impl FirecrawlApp {
    /// Parse a local file via multipart upload.
    pub async fn parse_file(
        &self,
        file_path: impl AsRef<Path>,
        options: impl Into<Option<ParseOptions>>,
    ) -> Result<Document, FirecrawlError> {
        let file_path = file_path.as_ref();
        let mut form = Form::new().file("file", file_path).map_err(|e| {
            FirecrawlError::HttpError("Preparing parse file upload".to_string(), e)
        })?;

        if let Some(opts) = options.into() {
            let options_json = serde_json::to_string(&opts).map_err(|e| {
                FirecrawlError::JsonError("Serializing parse options".to_string(), e)
            })?;
            form = form.text("options", options_json);
        }

        let mut headers = self.prepare_headers(None);
        headers.remove("Content-Type");

        let response = self
            .client
            .post(&format!("{}{}/parse", self.api_url, API_VERSION_V2))
            .headers(headers)
            .multipart(form)
            .send()
            .await
            .map_err(|e| FirecrawlError::HttpError("Parsing file".to_string(), e))?;

        let response = self
            .handle_response::<ParseResponse>(response, "parse file")
            .await?;

        Ok(response.data)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;

    #[tokio::test]
    async fn test_parse_with_mock() {
        let mut server = mockito::Server::new_async().await;
        let mock = server
            .mock("POST", "/v2/parse")
            .match_header(
                "content-type",
                mockito::Matcher::Regex("multipart/form-data; boundary=.+".into()),
            )
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                json!({
                    "success": true,
                    "data": {
                        "markdown": "ok",
                        "metadata": { "statusCode": 200 }
                    }
                })
                .to_string(),
            )
            .create();

        let app = FirecrawlApp::new_selfhosted(server.url(), Some("test_key")).unwrap();

        let temp_path = std::env::temp_dir().join("firecrawl-parse-test.md");
        fs::write(&temp_path, "# parse test").unwrap();

        let options = ParseOptions {
            formats: Some(vec![ParseFormats::Markdown]),
            ..Default::default()
        };

        let response = app.parse_file(&temp_path, Some(options)).await.unwrap();
        assert_eq!(response.markdown.unwrap(), "ok");

        mock.assert();
        let _ = fs::remove_file(temp_path);
    }
}
