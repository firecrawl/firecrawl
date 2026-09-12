use std::fmt::Display;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

/// An out-of-band step the API requires before the request can succeed.
#[derive(Debug, Deserialize, Serialize, Clone, PartialEq)]
pub struct RequiresAction {
    /// Identifies the step, such as `accept_terms`.
    #[serde(rename = "type")]
    pub kind: String,

    /// Names the provider whose terms must be accepted.
    pub terms: Option<String>,

    /// The terms version awaiting acceptance.
    pub version: Option<String>,

    /// Where the step can be completed.
    pub url: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct FirecrawlAPIError {
    /// Always false.
    pub success: bool,

    /// Error message
    pub error: String,

    pub code: Option<String>,

    /// Charge identifier for an exchange execution attempt, when one was created.
    #[serde(rename = "chargeId")]
    pub charge_id: Option<String>,

    /// Set when the API needs an out-of-band step first, such as accepting provider terms.
    #[serde(rename = "requiresAction", default)]
    pub requires_action: Option<RequiresAction>,

    /// Additional details of this error. Schema depends on the error itself.
    pub details: Option<Value>,
}

impl Display for FirecrawlAPIError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if let Some(details) = self.details.as_ref() {
            write!(f, "{} ({})", self.error, details)
        } else {
            write!(f, "{}", self.error)
        }
    }
}

#[derive(Error, Debug)]
pub enum FirecrawlError {
    #[error("{source} (request ID: {request_id})")]
    AlexandriaExecution {
        request_id: String,
        #[source]
        source: Box<FirecrawlError>,
    },
    #[error("{0} failed: HTTP error {1}: {2}")]
    HttpRequestFailed(String, u16, String),
    #[error("{0} failed: HTTP error: {1}")]
    HttpError(String, reqwest::Error),
    #[error("Failed to parse response as text: {0}")]
    ResponseParseErrorText(reqwest::Error),
    #[error("Failed to parse response: {0}")]
    ResponseParseError(serde_json::Error),
    #[error("{0} failed: {1}")]
    APIError(String, FirecrawlAPIError),
    #[error("Job failed: {0} (status: {1:?})")]
    JobFailed(String, crate::types::JobStatus),
    #[error("Misuse: {0}")]
    Misuse(String),
}
