use crate::error::FirecrawlAPIError;
use crate::{Client, AlexandriaCall, FirecrawlError};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[serde_with::skip_serializing_none]
#[derive(Serialize, Deserialize, Default, Debug, Clone)]
pub struct FindToolsOptions {
    pub urls: Option<Vec<String>>,
    pub providers: Option<Vec<String>>,
    pub categories: Option<Vec<String>>,
    pub groups: Option<Vec<String>>,
    pub capabilities: Option<Vec<String>>,
    pub level: Option<String>,
    pub expand: Option<Vec<String>>,
    pub limit: Option<u32>,
    pub offset: Option<u32>,
}
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct FindToolsData {
    pub level: String,
    pub items: Vec<Value>,
    pub total: u32,
    pub next: Option<AlexandriaCall>,
}
impl Client {
    pub async fn find_tools(
        &self,
        options: impl Into<Option<FindToolsOptions>>,
    ) -> Result<FindToolsData, FirecrawlError> {
        let options = serde_json::to_value(options.into().unwrap_or_default())
            .map_err(FirecrawlError::ResponseParseError)?;
        let result = self
            .scrape_alexandria(
                vec![AlexandriaCall {
                    provider: "firecrawl".into(),
                    capability: "find-tools".into(),
                    options: options.as_object().cloned(),
                }],
                None,
            )
            .await?;
        let request_id = result.request_id;
        let fail = |source| FirecrawlError::AlexandriaExecution {
            request_id: request_id.clone(),
            source: Box::new(source),
        };
        let item = result
            .alexandria
            .into_iter()
            .next()
            .ok_or_else(|| fail(FirecrawlError::Misuse("Missing Find Tools result".into())))?;
        if let Some(error) = item.error {
            return Err(fail(FirecrawlError::APIError(
                "find tools".into(),
                FirecrawlAPIError {
                    success: false,
                    error: error.message,
                    code: Some(error.code),
                    charge_id: error.charge_id,
                    details: None,
                },
            )));
        }
        serde_json::from_value(item.data.unwrap_or(Value::Null))
            .map_err(|error| fail(FirecrawlError::ResponseParseError(error)))
    }
}
