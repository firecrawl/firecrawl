//! Agent endpoint for Firecrawl API v2.
//!
//! The Agent endpoint provides autonomous web browsing capabilities using AI
//! to accomplish complex tasks that may require multiple page interactions.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::client::Client;
use super::types::{AgentModel, AgentWebhookConfig};
use crate::FirecrawlError;

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

    /// Maximum credits the agent can use.
    pub max_credits: Option<u32>,

    /// Strictly constrain the agent to the provided URLs.
    pub strict_constrain_to_urls: Option<bool>,

    /// Agent model to use.
    pub model: Option<AgentModel>,

    /// Webhook configuration for agent notifications.
    pub webhook: Option<AgentWebhookConfig>,

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
    /// Expiry time of the task data.
    pub expires_at: Option<String>,
    /// Credits used by the agent task.
    pub credits_used: Option<u32>,
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
    /// use firecrawl::v2::{Client, AgentOptions};
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
    /// use firecrawl::v2::Client;
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
    /// use firecrawl::v2::{Client, AgentOptions, AgentModel};
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
    /// use firecrawl::v2::Client;
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
    /// use firecrawl::v2::Client;
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
