//! Agent endpoint for Firecrawl API v2.
//!
//! The Agent endpoint provides autonomous web browsing capabilities using AI
//! to accomplish complex tasks that may require multiple page interactions.

use crate::client::Client;
use crate::types::{AgentEffort, AgentModel, AgentWebhookConfig};
use crate::{AuditMetadata, FirecrawlError};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Options for running an agent task.
#[serde_with::skip_serializing_none]
#[derive(Deserialize, Serialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgentOptions {
    /// Starting URLs for the agent to explore.
    pub urls: Option<Vec<String>>,

    /// The prompt describing what the agent should accomplish.
    pub prompt: String,

    /// JSON schema for the expected output structure.
    pub schema: Option<Value>,

    /// Integration identifier for tracking.
    pub integration: Option<String>,

    /// Origin label for request attribution (e.g., "rust-sdk@2.16.1").
    /// Defaults to `rust-sdk@<version>` when unset.
    pub origin: Option<String>,

    /// Maximum credits the agent can use.
    pub max_credits: Option<u32>,

    /// Strictly constrain the agent to the provided URLs.
    pub strict_constrain_to_urls: Option<bool>,

    /// Agent model to use. Defaults to `spark-1-pro` server-side when unset.
    pub model: Option<AgentModel>,

    /// Reasoning effort for the agent task. Every level runs spark-2.
    pub effort: Option<AgentEffort>,

    /// Webhook configuration for agent notifications.
    pub webhook: Option<AgentWebhookConfig>,

    /// User attribution to include with SIEM logging events.
    pub audit_metadata: Option<AuditMetadata>,

    /// Poll interval for synchronous agent execution (milliseconds).
    #[serde(skip)]
    pub poll_interval: Option<u64>,

    /// Timeout for synchronous agent execution (seconds).
    #[serde(skip)]
    pub timeout: Option<u64>,
}

/// Response from starting an agent task.
#[derive(Deserialize, Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgentResponse {
    /// Whether the request was successful.
    pub success: bool,
    /// The agent task ID.
    pub id: String,
    /// Error message if the request failed.
    pub error: Option<String>,
}

/// Agent task status.
#[derive(Deserialize, Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AgentStatus {
    /// The agent is still processing.
    Processing,
    /// The agent has completed its task.
    Completed,
    /// The agent task failed.
    Failed,
    /// The agent task was cancelled.
    Cancelled,
}

/// Status response from an agent task.
#[serde_with::skip_serializing_none]
#[derive(Deserialize, Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatusResponse {
    /// Whether the status check was successful.
    pub success: bool,
    /// Current status of the agent task.
    pub status: AgentStatus,
    /// Error message if the task failed.
    pub error: Option<String>,
    /// Extracted data (if schema was provided) or task results.
    pub data: Option<Value>,
    /// Model used for the agent task.
    pub model: Option<AgentModel>,
    /// Reasoning effort the task ran with, if one was requested.
    pub effort: Option<AgentEffort>,
    /// Expiry time of the task data.
    pub expires_at: Option<String>,
    /// Credits used by the agent task.
    pub credits_used: Option<u32>,
}

// Agent trace types (GET /v2/agent/:id/trace). These mirror the agent
// service's canonical event schema (schemaVersion 1): usage.recorded events
// are withheld server-side and agent.started carries no model name.

/// Which agent produced a trace event.
#[derive(Deserialize, Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentTraceAgentIdentity {
    pub id: String,
    pub role: AgentTraceAgentRole,
    pub name: String,
    #[serde(default)]
    pub parent_id: Option<String>,
}

/// Role of the agent that produced a trace event.
#[derive(Deserialize, Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AgentTraceAgentRole {
    Orchestrator,
    Subagent,
    Browser,
    System,
}

/// Structured error attached to terminal and error trace events.
#[derive(Deserialize, Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentTraceError {
    pub code: AgentTraceErrorCode,
    pub source: AgentTraceErrorSource,
    pub retryable: bool,
    pub message: String,
}

/// Machine-readable trace error code.
#[derive(Deserialize, Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentTraceErrorCode {
    Cancelled,
    CreditLimitReached,
    ParentFinished,
    Refused,
    Internal,
}

/// Where a trace error originated.
#[derive(Deserialize, Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AgentTraceErrorSource {
    Agent,
    Tool,
    Billing,
    System,
}

/// Reference to an artifact snapshot; fetch the content with
/// [`Client::get_agent_snapshot`].
#[derive(Deserialize, Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentTraceArtifactChange {
    pub kind: AgentTraceArtifactKind,
    pub artifact_id: String,
    #[serde(default)]
    pub path: Option<String>,
    pub snapshot_id: String,
    pub change: AgentTraceArtifactChangeKind,
    #[serde(default)]
    pub changed_fields: Option<Vec<String>>,
    #[serde(default)]
    pub item_count: Option<u64>,
    #[serde(default)]
    pub source_tool_call_id: Option<String>,
}

/// Kind of artifact content behind a snapshot.
#[derive(Deserialize, Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AgentTraceArtifactKind {
    Json,
    Markdown,
    Html,
    Screenshot,
    Text,
}

/// How an artifact changed in an artifact.updated event.
#[derive(Deserialize, Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AgentTraceArtifactChangeKind {
    Init,
    Partial,
    Append,
    Modify,
    Update,
}

/// Fields every trace event carries.
#[derive(Deserialize, Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentTraceEventBase {
    /// Canonical event schema version (1 at the time of writing).
    pub schema_version: u32,
    pub event_id: String,
    pub run_id: String,
    /// ISO 8601 timestamp with offset.
    pub occurred_at: String,
    pub producer_sequence: u64,
    pub agent: AgentTraceAgentIdentity,
}

macro_rules! trace_event_struct {
    ($name:ident { $( $(#[$meta:meta])* $field:ident : $ty:ty ),* $(,)? }) => {
        #[derive(Deserialize, Serialize, Clone, Debug, PartialEq)]
        #[serde(rename_all = "camelCase")]
        pub struct $name {
            #[serde(flatten)]
            pub base: AgentTraceEventBase,
            $( $(#[$meta])* pub $field : $ty ),*
        }
    };
    ($name:ident) => {
        #[derive(Deserialize, Serialize, Clone, Debug, PartialEq)]
        #[serde(rename_all = "camelCase")]
        pub struct $name {
            #[serde(flatten)]
            pub base: AgentTraceEventBase,
        }
    };
}

trace_event_struct!(AgentTraceRunStartedEvent);
trace_event_struct!(AgentTraceRunCancelRequestedEvent {
    /// Always "user" at present.
    reason: String
});
trace_event_struct!(AgentTraceRunFinishedEvent {
    outcome: AgentTraceRunOutcome,
    error: Option<AgentTraceError>
});
trace_event_struct!(AgentTraceAgentStartedEvent);
trace_event_struct!(AgentTraceAgentFinishedEvent {
    outcome: AgentTraceAgentOutcome,
    duration_ms: u64,
    error: Option<AgentTraceError>
});
trace_event_struct!(AgentTraceBrowserSessionStartedEvent { session_id: String });
trace_event_struct!(AgentTraceBrowserSessionFinishedEvent {
    session_id: String,
    duration_ms: u64
});
trace_event_struct!(AgentTraceProgressReportedEvent {
    phase: AgentTraceProgressPhase,
    message: String
});
trace_event_struct!(AgentTraceReasoningSummaryEvent { text: String });
trace_event_struct!(AgentTraceToolCallStartedEvent {
    tool_call_id: String,
    tool_name: String,
    parameters: Value
});
trace_event_struct!(AgentTraceToolCallFinishedEvent {
    tool_call_id: String,
    tool_name: String,
    result: Value
});
trace_event_struct!(AgentTraceArtifactUpdatedEvent {
    artifact: AgentTraceArtifactChange
});
trace_event_struct!(AgentTraceErrorOccurredEvent {
    error: AgentTraceError
});

/// Terminal outcome of a run.
#[derive(Deserialize, Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentTraceRunOutcome {
    Succeeded,
    Failed,
    Cancelled,
    Refused,
    CreditLimitReached,
}

/// Terminal outcome of a single agent.
#[derive(Deserialize, Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentTraceAgentOutcome {
    Succeeded,
    Failed,
    Cancelled,
    Refused,
}

/// Phase a progress.reported event belongs to.
#[derive(Deserialize, Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AgentTraceProgressPhase {
    Planning,
    Working,
    Finalizing,
}

/// One event in an agent job's execution trace.
#[derive(Deserialize, Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "type")]
pub enum AgentTraceEvent {
    #[serde(rename = "run.started")]
    RunStarted(AgentTraceRunStartedEvent),
    #[serde(rename = "run.cancel_requested")]
    RunCancelRequested(AgentTraceRunCancelRequestedEvent),
    #[serde(rename = "run.finished")]
    RunFinished(AgentTraceRunFinishedEvent),
    #[serde(rename = "agent.started")]
    AgentStarted(AgentTraceAgentStartedEvent),
    #[serde(rename = "agent.finished")]
    AgentFinished(AgentTraceAgentFinishedEvent),
    #[serde(rename = "browser.session.started")]
    BrowserSessionStarted(AgentTraceBrowserSessionStartedEvent),
    #[serde(rename = "browser.session.finished")]
    BrowserSessionFinished(AgentTraceBrowserSessionFinishedEvent),
    #[serde(rename = "progress.reported")]
    ProgressReported(AgentTraceProgressReportedEvent),
    #[serde(rename = "reasoning.summary")]
    ReasoningSummary(AgentTraceReasoningSummaryEvent),
    #[serde(rename = "tool_call.started")]
    ToolCallStarted(AgentTraceToolCallStartedEvent),
    #[serde(rename = "tool_call.finished")]
    ToolCallFinished(AgentTraceToolCallFinishedEvent),
    #[serde(rename = "artifact.updated")]
    ArtifactUpdated(AgentTraceArtifactUpdatedEvent),
    #[serde(rename = "error.occurred")]
    ErrorOccurred(AgentTraceErrorOccurredEvent),
}

/// Live browser session, present only when the trace is requested with
/// live view enabled.
#[derive(Deserialize, Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentTraceActiveBrowserSession {
    pub id: String,
    pub live_view_url: String,
    pub viewport: AgentTraceViewport,
}

/// Browser viewport dimensions.
#[derive(Deserialize, Serialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct AgentTraceViewport {
    pub width: u32,
    pub height: u32,
}

/// Response from getting an agent job's execution trace.
#[serde_with::skip_serializing_none]
#[derive(Deserialize, Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgentTraceResponse {
    pub success: bool,
    pub id: Option<String>,
    pub events: Option<Vec<AgentTraceEvent>>,
    pub credits_used: Option<u32>,
    pub active_browser_sessions: Option<Vec<AgentTraceActiveBrowserSession>>,
    pub error: Option<String>,
}

/// Response from getting an artifact snapshot of an agent job.
#[serde_with::skip_serializing_none]
#[derive(Deserialize, Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgentSnapshotResponse {
    pub success: bool,
    pub id: Option<String>,
    pub snapshot_id: Option<String>,
    /// Full artifact content as a JSON/string blob.
    pub snapshot: Option<String>,
    pub error: Option<String>,
}

impl Client {
    /// Starts an agent task asynchronously.
    ///
    /// Returns immediately with a task ID that can be used to check status.
    ///
    /// # Arguments
    ///
    /// * `options` - Agent task configuration including the prompt.
    ///
    /// # Returns
    ///
    /// An `AgentResponse` containing the task ID.
    ///
    /// # Example
    ///
    /// ```no_run
    /// use firecrawl::{Client, AgentOptions};
    ///
    /// #[tokio::main]
    /// async fn main() -> Result<(), Box<dyn std::error::Error>> {
    ///     let client = Client::new("your-api-key")?;
    ///
    ///     let options = AgentOptions {
    ///         urls: Some(vec!["https://example.com".to_string()]),
    ///         prompt: "Find the pricing information on this website".to_string(),
    ///         ..Default::default()
    ///     };
    ///
    ///     let response = client.start_agent(options).await?;
    ///     println!("Agent task started: {}", response.id);
    ///
    ///     Ok(())
    /// }
    /// ```
    pub async fn start_agent(
        &self,
        options: AgentOptions,
    ) -> Result<AgentResponse, FirecrawlError> {
        let mut options = options;
        if options.origin.is_none() {
            options.origin = Some(format!("rust-sdk@{}", env!("CARGO_PKG_VERSION")));
        }

        let headers = self.prepare_headers(None);

        let response = self
            .client
            .post(self.url("/agent"))
            .headers(headers)
            .json(&options)
            .send()
            .await
            .map_err(|e| FirecrawlError::HttpError("Starting agent task".to_string(), e))?;

        self.handle_response(response, "start agent").await
    }

    /// Gets the status of an agent task.
    ///
    /// # Arguments
    ///
    /// * `id` - The agent task ID.
    ///
    /// # Returns
    ///
    /// An `AgentStatusResponse` containing the current status and any results.
    ///
    /// # Example
    ///
    /// ```no_run
    /// use firecrawl::Client;
    ///
    /// #[tokio::main]
    /// async fn main() -> Result<(), Box<dyn std::error::Error>> {
    ///     let client = Client::new("your-api-key")?;
    ///
    ///     let status = client.get_agent_status("task-id").await?;
    ///     println!("Status: {:?}", status.status);
    ///
    ///     if let Some(data) = status.data {
    ///         println!("Result: {}", data);
    ///     }
    ///
    ///     Ok(())
    /// }
    /// ```
    pub async fn get_agent_status(
        &self,
        id: impl AsRef<str>,
    ) -> Result<AgentStatusResponse, FirecrawlError> {
        let response = self
            .client
            .get(self.url(&format!("/agent/{}", id.as_ref())))
            .headers(self.prepare_headers(None))
            .send()
            .await
            .map_err(|e| {
                FirecrawlError::HttpError(format!("Getting agent status {}", id.as_ref()), e)
            })?;

        self.handle_response(response, format!("agent status {}", id.as_ref()))
            .await
    }

    /// Gets the execution trace of an agent task (spark-2 runs only).
    ///
    /// # Arguments
    ///
    /// * `id` - The agent task ID.
    /// * `live_view` - Also include currently active browser sessions with
    ///   live view URLs.
    ///
    /// # Returns
    ///
    /// An `AgentTraceResponse` containing the ordered trace events.
    pub async fn get_agent_trace(
        &self,
        id: impl AsRef<str>,
        live_view: bool,
    ) -> Result<AgentTraceResponse, FirecrawlError> {
        let path = if live_view {
            format!("/agent/{}/trace?liveView=true", id.as_ref())
        } else {
            format!("/agent/{}/trace", id.as_ref())
        };

        let response = self
            .client
            .get(self.url(&path))
            .headers(self.prepare_headers(None))
            .send()
            .await
            .map_err(|e| {
                FirecrawlError::HttpError(format!("Getting agent trace {}", id.as_ref()), e)
            })?;

        self.handle_response(response, format!("agent trace {}", id.as_ref()))
            .await
    }

    /// Gets the full content of an artifact snapshot referenced by a trace
    /// event.
    ///
    /// # Arguments
    ///
    /// * `id` - The agent task ID.
    /// * `snapshot_id` - Snapshot ID from an `artifact.updated` trace event.
    ///
    /// # Returns
    ///
    /// An `AgentSnapshotResponse` containing the snapshot content.
    pub async fn get_agent_snapshot(
        &self,
        id: impl AsRef<str>,
        snapshot_id: impl AsRef<str>,
    ) -> Result<AgentSnapshotResponse, FirecrawlError> {
        let response = self
            .client
            .get(self.url(&format!(
                "/agent/{}/snapshots/{}",
                id.as_ref(),
                snapshot_id.as_ref()
            )))
            .headers(self.prepare_headers(None))
            .send()
            .await
            .map_err(|e| {
                FirecrawlError::HttpError(
                    format!(
                        "Getting agent snapshot {} of {}",
                        snapshot_id.as_ref(),
                        id.as_ref()
                    ),
                    e,
                )
            })?;

        self.handle_response(response, format!("agent snapshot {}", id.as_ref()))
            .await
    }

    /// Runs an agent task and waits for completion.
    ///
    /// This method starts an agent task and polls until it completes, fails, or times out.
    ///
    /// # Arguments
    ///
    /// * `options` - Agent task configuration including the prompt.
    ///
    /// # Returns
    ///
    /// An `AgentStatusResponse` containing the final status and results.
    ///
    /// # Example
    ///
    /// ```no_run
    /// use firecrawl::{Client, AgentOptions, AgentModel};
    /// use serde_json::json;
    ///
    /// #[tokio::main]
    /// async fn main() -> Result<(), Box<dyn std::error::Error>> {
    ///     let client = Client::new("your-api-key")?;
    ///
    ///     let options = AgentOptions {
    ///         urls: Some(vec!["https://example.com/pricing".to_string()]),
    ///         prompt: "Extract the pricing tiers and their features".to_string(),
    ///         schema: Some(json!({
    ///             "type": "object",
    ///             "properties": {
    ///                 "tiers": {
    ///                     "type": "array",
    ///                     "items": {
    ///                         "type": "object",
    ///                         "properties": {
    ///                             "name": { "type": "string" },
    ///                             "price": { "type": "number" },
    ///                             "features": { "type": "array", "items": { "type": "string" } }
    ///                         }
    ///                     }
    ///                 }
    ///             }
    ///         })),
    ///         model: Some(AgentModel::Spark1Pro),
    ///         poll_interval: Some(3000),
    ///         timeout: Some(300),
    ///         ..Default::default()
    ///     };
    ///
    ///     let result = client.agent(options).await?;
    ///
    ///     if let Some(data) = result.data {
    ///         println!("Extracted pricing: {}", serde_json::to_string_pretty(&data)?);
    ///     }
    ///
    ///     Ok(())
    /// }
    /// ```
    pub async fn agent(
        &self,
        options: AgentOptions,
    ) -> Result<AgentStatusResponse, FirecrawlError> {
        let poll_interval = options.poll_interval.unwrap_or(2000);
        let timeout = options.timeout;

        let response = self.start_agent(options).await?;
        self.wait_for_agent(&response.id, poll_interval, timeout)
            .await
    }

    /// Waits for an agent task to complete.
    async fn wait_for_agent(
        &self,
        id: &str,
        poll_interval: u64,
        timeout: Option<u64>,
    ) -> Result<AgentStatusResponse, FirecrawlError> {
        let start = std::time::Instant::now();

        loop {
            let status = self.get_agent_status(id).await?;

            match status.status {
                AgentStatus::Completed | AgentStatus::Failed | AgentStatus::Cancelled => {
                    return Ok(status);
                }
                AgentStatus::Processing => {
                    // Check timeout
                    if let Some(timeout_secs) = timeout {
                        if start.elapsed().as_secs() > timeout_secs {
                            return Ok(status);
                        }
                    }

                    tokio::time::sleep(tokio::time::Duration::from_millis(poll_interval)).await;
                }
            }
        }
    }

    /// Cancels a running agent task.
    ///
    /// # Arguments
    ///
    /// * `id` - The agent task ID to cancel.
    ///
    /// # Returns
    ///
    /// `true` if the cancellation was successful.
    ///
    /// # Example
    ///
    /// ```no_run
    /// use firecrawl::Client;
    ///
    /// #[tokio::main]
    /// async fn main() -> Result<(), Box<dyn std::error::Error>> {
    ///     let client = Client::new("your-api-key")?;
    ///
    ///     let cancelled = client.cancel_agent("task-id").await?;
    ///     println!("Cancelled: {}", cancelled);
    ///
    ///     Ok(())
    /// }
    /// ```
    pub async fn cancel_agent(&self, id: impl AsRef<str>) -> Result<bool, FirecrawlError> {
        let response = self
            .client
            .delete(self.url(&format!("/agent/{}", id.as_ref())))
            .headers(self.prepare_headers(None))
            .send()
            .await
            .map_err(|e| {
                FirecrawlError::HttpError(format!("Cancelling agent {}", id.as_ref()), e)
            })?;

        #[derive(Deserialize)]
        struct CancelResponse {
            success: bool,
        }

        let result: CancelResponse = self
            .handle_response(response, format!("cancel agent {}", id.as_ref()))
            .await?;

        Ok(result.success)
    }

    /// Runs an agent with a typed schema for structured output.
    ///
    /// This is a convenience method that automatically converts the result
    /// to the specified type.
    ///
    /// # Arguments
    ///
    /// * `urls` - Starting URLs for the agent.
    /// * `prompt` - The task description.
    /// * `schema` - JSON schema for the expected output.
    ///
    /// # Returns
    ///
    /// The extracted data as the specified type, or `None` if extraction failed.
    ///
    /// # Example
    ///
    /// ```no_run
    /// use firecrawl::Client;
    /// use serde::Deserialize;
    /// use serde_json::json;
    ///
    /// #[derive(Debug, Deserialize)]
    /// struct ProductInfo {
    ///     name: String,
    ///     price: f64,
    ///     description: Option<String>,
    /// }
    ///
    /// #[tokio::main]
    /// async fn main() -> Result<(), Box<dyn std::error::Error>> {
    ///     let client = Client::new("your-api-key")?;
    ///
    ///     let schema = json!({
    ///         "type": "object",
    ///         "properties": {
    ///             "name": { "type": "string" },
    ///             "price": { "type": "number" },
    ///             "description": { "type": "string" }
    ///         },
    ///         "required": ["name", "price"]
    ///     });
    ///
    ///     let result: Option<ProductInfo> = client.agent_with_schema(
    ///         vec!["https://example.com/product".to_string()],
    ///         "Extract the product information",
    ///         schema,
    ///     ).await?;
    ///
    ///     if let Some(product) = result {
    ///         println!("Product: {} - ${}", product.name, product.price);
    ///     }
    ///
    ///     Ok(())
    /// }
    /// ```
    pub async fn agent_with_schema<T: serde::de::DeserializeOwned>(
        &self,
        urls: Vec<String>,
        prompt: impl AsRef<str>,
        schema: Value,
    ) -> Result<Option<T>, FirecrawlError> {
        let options = AgentOptions {
            urls: Some(urls),
            prompt: prompt.as_ref().to_string(),
            schema: Some(schema),
            ..Default::default()
        };

        let result = self.agent(options).await?;

        if result.status != AgentStatus::Completed {
            return Ok(None);
        }

        match result.data {
            Some(data) => {
                let typed: T =
                    serde_json::from_value(data).map_err(FirecrawlError::ResponseParseError)?;
                Ok(Some(typed))
            }
            None => Ok(None),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mockito::Matcher;
    use serde_json::json;

    #[tokio::test]
    async fn test_start_agent_with_mock() {
        let mut server = mockito::Server::new_async().await;

        let mock = server
            .mock("POST", "/v2/agent")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                json!({
                    "success": true,
                    "id": "agent-123"
                })
                .to_string(),
            )
            .create();

        let client = Client::new_selfhosted(server.url(), Some("test_key")).unwrap();
        let options = AgentOptions {
            urls: Some(vec!["https://example.com".to_string()]),
            prompt: "Find the contact information".to_string(),
            ..Default::default()
        };

        let response = client.start_agent(options).await.unwrap();

        assert!(response.success);
        assert_eq!(response.id, "agent-123");
        mock.assert();
    }

    #[tokio::test]
    async fn test_start_agent_injects_sdk_origin() {
        let mut server = mockito::Server::new_async().await;

        // The mock only matches when the request body carries the SDK origin,
        // so a regression in the injection fails the request itself.
        let mock = server
            .mock("POST", "/v2/agent")
            .match_body(Matcher::PartialJson(json!({
                "origin": format!("rust-sdk@{}", env!("CARGO_PKG_VERSION"))
            })))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(json!({"success": true, "id": "agent-123"}).to_string())
            .create();

        let client = Client::new_selfhosted(server.url(), Some("test_key")).unwrap();
        let options = AgentOptions {
            prompt: "Find the contact information".to_string(),
            ..Default::default()
        };

        let response = client.start_agent(options).await.unwrap();

        assert!(response.success);
        mock.assert();
    }

    #[tokio::test]
    async fn test_start_agent_preserves_custom_origin() {
        let mut server = mockito::Server::new_async().await;

        let mock = server
            .mock("POST", "/v2/agent")
            .match_body(Matcher::PartialJson(json!({"origin": "my-app@1.0"})))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(json!({"success": true, "id": "agent-123"}).to_string())
            .create();

        let client = Client::new_selfhosted(server.url(), Some("test_key")).unwrap();
        let options = AgentOptions {
            prompt: "Find the contact information".to_string(),
            origin: Some("my-app@1.0".to_string()),
            ..Default::default()
        };

        let response = client.start_agent(options).await.unwrap();

        assert!(response.success);
        mock.assert();
    }

    #[test]
    fn test_trace_events_deserialize_every_type() {
        let base = json!({
            "schemaVersion": 1,
            "eventId": "018f3c5e-0000-7000-8000-000000000000",
            "runId": "018f3c5e-0000-7000-8000-000000000001",
            "occurredAt": "2026-08-26T12:00:00+00:00",
            "producerSequence": 1,
            "agent": {
                "id": "018f3c5e-0000-7000-8000-000000000002",
                "role": "orchestrator",
                "name": "main"
            }
        });
        let cases = [
            ("run.started", json!({})),
            ("run.cancel_requested", json!({"reason": "user"})),
            (
                "run.finished",
                json!({"outcome": "credit_limit_reached", "error": {
                    "code": "credit_limit_reached",
                    "source": "billing",
                    "retryable": false,
                    "message": "out of credits"
                }}),
            ),
            ("agent.started", json!({})),
            (
                "agent.finished",
                json!({"outcome": "succeeded", "durationMs": 1234, "error": null}),
            ),
            ("browser.session.started", json!({"sessionId": "sess-1"})),
            (
                "browser.session.finished",
                json!({"sessionId": "sess-1", "durationMs": 42}),
            ),
            (
                "progress.reported",
                json!({"phase": "working", "message": "reading page"}),
            ),
            ("reasoning.summary", json!({"text": "thinking"})),
            (
                "tool_call.started",
                json!({"toolCallId": "tc-1", "toolName": "scrape", "parameters": {"url": "https://example.com"}}),
            ),
            (
                "tool_call.finished",
                json!({"toolCallId": "tc-1", "toolName": "scrape", "result": {"ok": true}}),
            ),
            (
                "artifact.updated",
                json!({"artifact": {
                    "kind": "json",
                    "artifactId": "result",
                    "path": "/workspace/data.json",
                    "snapshotId": "018f3c5e-0000-7000-8000-000000000003",
                    "change": "partial",
                    "changedFields": ["price"],
                    "itemCount": 3,
                    "sourceToolCallId": "tc-1"
                }}),
            ),
            (
                "error.occurred",
                json!({"error": {
                    "code": "internal",
                    "source": "system",
                    "retryable": true,
                    "message": "boom"
                }}),
            ),
        ];

        for (event_type, extra) in cases {
            let mut value = base.clone();
            value
                .as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            value["type"] = json!(event_type);

            let event: AgentTraceEvent = serde_json::from_value(value.clone())
                .unwrap_or_else(|e| panic!("{event_type} should deserialize: {e}"));
            let round_tripped = serde_json::to_value(&event).unwrap();
            assert_eq!(round_tripped["type"], json!(event_type));
        }
    }

    #[tokio::test]
    async fn test_get_agent_trace_with_mock() {
        let mut server = mockito::Server::new_async().await;

        let mock = server
            .mock("GET", "/v2/agent/agent-123/trace")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                json!({
                    "success": true,
                    "id": "agent-123",
                    "events": [{
                        "schemaVersion": 1,
                        "eventId": "018f3c5e-0000-7000-8000-000000000000",
                        "runId": "018f3c5e-0000-7000-8000-000000000001",
                        "occurredAt": "2026-08-26T12:00:00+00:00",
                        "producerSequence": 1,
                        "agent": {
                            "id": "018f3c5e-0000-7000-8000-000000000002",
                            "role": "orchestrator",
                            "name": "main"
                        },
                        "type": "run.started"
                    }],
                    "creditsUsed": 5
                })
                .to_string(),
            )
            .create();

        let client = Client::new_selfhosted(server.url(), Some("test_key")).unwrap();
        let trace = client.get_agent_trace("agent-123", false).await.unwrap();

        assert!(trace.success);
        let events = trace.events.unwrap();
        assert_eq!(events.len(), 1);
        assert!(matches!(events[0], AgentTraceEvent::RunStarted(_)));
        assert_eq!(trace.credits_used, Some(5));
        assert!(trace.active_browser_sessions.is_none());
        mock.assert();
    }

    #[tokio::test]
    async fn test_get_agent_trace_with_live_view() {
        let mut server = mockito::Server::new_async().await;

        let mock = server
            .mock("GET", "/v2/agent/agent-123/trace")
            .match_query(Matcher::UrlEncoded("liveView".into(), "true".into()))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                json!({
                    "success": true,
                    "id": "agent-123",
                    "events": [],
                    "creditsUsed": 0,
                    "activeBrowserSessions": [{
                        "id": "sess-1",
                        "liveViewUrl": "https://browser.example.com/sess-1",
                        "viewport": {"width": 1280, "height": 720}
                    }]
                })
                .to_string(),
            )
            .create();

        let client = Client::new_selfhosted(server.url(), Some("test_key")).unwrap();
        let trace = client.get_agent_trace("agent-123", true).await.unwrap();

        let sessions = trace.active_browser_sessions.unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].viewport.width, 1280);
        mock.assert();
    }

    #[tokio::test]
    async fn test_get_agent_snapshot_with_mock() {
        let mut server = mockito::Server::new_async().await;

        let mock = server
            .mock(
                "GET",
                "/v2/agent/agent-123/snapshots/018f3c5e-0000-7000-8000-000000000003",
            )
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                json!({
                    "success": true,
                    "id": "agent-123",
                    "snapshotId": "018f3c5e-0000-7000-8000-000000000003",
                    "snapshot": "{\"price\": 42}"
                })
                .to_string(),
            )
            .create();

        let client = Client::new_selfhosted(server.url(), Some("test_key")).unwrap();
        let snapshot = client
            .get_agent_snapshot("agent-123", "018f3c5e-0000-7000-8000-000000000003")
            .await
            .unwrap();

        assert!(snapshot.success);
        assert_eq!(snapshot.snapshot.unwrap(), "{\"price\": 42}");
        mock.assert();
    }

    #[tokio::test]
    async fn test_start_agent_sends_effort() {
        let mut server = mockito::Server::new_async().await;

        let mock = server
            .mock("POST", "/v2/agent")
            .match_body(Matcher::PartialJson(json!({"effort": "high"})))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(json!({"success": true, "id": "agent-123"}).to_string())
            .create();

        let client = Client::new_selfhosted(server.url(), Some("test_key")).unwrap();
        let options = AgentOptions {
            prompt: "Find the contact information".to_string(),
            effort: Some(AgentEffort::High),
            ..Default::default()
        };

        let response = client.start_agent(options).await.unwrap();

        assert!(response.success);
        mock.assert();
    }

    #[tokio::test]
    async fn test_get_agent_status_with_mock() {
        let mut server = mockito::Server::new_async().await;

        let mock = server
            .mock("GET", "/v2/agent/agent-123")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                json!({
                    "success": true,
                    "status": "completed",
                    "data": {
                        "email": "contact@example.com",
                        "phone": "555-1234"
                    },
                    "creditsUsed": 5,
                    "expiresAt": "2024-12-31T23:59:59Z"
                })
                .to_string(),
            )
            .create();

        let client = Client::new_selfhosted(server.url(), Some("test_key")).unwrap();
        let status = client.get_agent_status("agent-123").await.unwrap();

        assert!(status.success);
        assert_eq!(status.status, AgentStatus::Completed);
        assert!(status.data.is_some());
        assert_eq!(status.credits_used, Some(5));
        mock.assert();
    }

    #[tokio::test]
    async fn test_agent_sync_with_mock() {
        let mut server = mockito::Server::new_async().await;

        // Mock the start endpoint
        let start_mock = server
            .mock("POST", "/v2/agent")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                json!({
                    "success": true,
                    "id": "agent-456"
                })
                .to_string(),
            )
            .create();

        // Mock the status endpoint (completed immediately)
        let status_mock = server
            .mock("GET", "/v2/agent/agent-456")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                json!({
                    "success": true,
                    "status": "completed",
                    "data": {
                        "result": "Task completed successfully"
                    }
                })
                .to_string(),
            )
            .create();

        let client = Client::new_selfhosted(server.url(), Some("test_key")).unwrap();
        let options = AgentOptions {
            urls: Some(vec!["https://example.com".to_string()]),
            prompt: "Test task".to_string(),
            ..Default::default()
        };

        let result = client.agent(options).await.unwrap();

        assert_eq!(result.status, AgentStatus::Completed);
        assert!(result.data.is_some());
        start_mock.assert();
        status_mock.assert();
    }

    #[tokio::test]
    async fn test_cancel_agent_with_mock() {
        let mut server = mockito::Server::new_async().await;

        let mock = server
            .mock("DELETE", "/v2/agent/agent-789")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                json!({
                    "success": true
                })
                .to_string(),
            )
            .create();

        let client = Client::new_selfhosted(server.url(), Some("test_key")).unwrap();
        let cancelled = client.cancel_agent("agent-789").await.unwrap();

        assert!(cancelled);
        mock.assert();
    }

    #[tokio::test]
    async fn test_agent_with_schema() {
        let mut server = mockito::Server::new_async().await;

        // Mock the start endpoint
        let start_mock = server
            .mock("POST", "/v2/agent")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                json!({
                    "success": true,
                    "id": "agent-schema"
                })
                .to_string(),
            )
            .create();

        // Mock the status endpoint
        let status_mock = server
            .mock("GET", "/v2/agent/agent-schema")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                json!({
                    "success": true,
                    "status": "completed",
                    "data": {
                        "name": "Test Product",
                        "price": 29.99
                    }
                })
                .to_string(),
            )
            .create();

        #[derive(Debug, serde::Deserialize, PartialEq)]
        struct Product {
            name: String,
            price: f64,
        }

        let client = Client::new_selfhosted(server.url(), Some("test_key")).unwrap();

        let schema = json!({
            "type": "object",
            "properties": {
                "name": { "type": "string" },
                "price": { "type": "number" }
            }
        });

        let result: Option<Product> = client
            .agent_with_schema(
                vec!["https://example.com".to_string()],
                "Extract product info",
                schema,
            )
            .await
            .unwrap();

        assert_eq!(
            result,
            Some(Product {
                name: "Test Product".to_string(),
                price: 29.99
            })
        );
        start_mock.assert();
        status_mock.assert();
    }

    #[tokio::test]
    async fn test_agent_with_model_option() {
        let mut server = mockito::Server::new_async().await;

        let mock = server
            .mock("POST", "/v2/agent")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                json!({
                    "success": true,
                    "id": "agent-model"
                })
                .to_string(),
            )
            .create();

        let client = Client::new_selfhosted(server.url(), Some("test_key")).unwrap();
        let options = AgentOptions {
            urls: Some(vec!["https://example.com".to_string()]),
            prompt: "Task with specific model".to_string(),
            model: Some(AgentModel::Spark1Pro),
            max_credits: Some(100),
            ..Default::default()
        };

        let response = client.start_agent(options).await.unwrap();

        assert!(response.success);
        mock.assert();
    }
}
