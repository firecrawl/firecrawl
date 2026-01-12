use serde::{Deserialize, Serialize};

/// A job in the FDB queue
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FdbQueueJob {
    pub id: String,
    pub data: serde_json::Value,
    pub priority: i32,
    pub listenable: bool,
    pub created_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub times_out_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub listen_channel_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub crawl_id: Option<String>,
    pub team_id: String,
}

/// Response for pop_next_job - includes the queue key for later completion
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimedJob {
    pub job: FdbQueueJob,
    /// Base64-encoded queue key for completing the job
    pub queue_key: String,
}

// === Request types ===

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PushJobRequest {
    pub team_id: String,
    pub job: JobInput,
    /// Timeout in milliseconds. None means no timeout (Infinity in JS becomes null).
    #[serde(default)]
    pub timeout: Option<i64>,
    #[serde(default)]
    pub crawl_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobInput {
    pub id: String,
    pub data: serde_json::Value,
    pub priority: i32,
    pub listenable: bool,
    #[serde(default)]
    pub listen_channel_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PopJobRequest {
    /// Unique worker ID claiming the job
    pub worker_id: String,
    /// List of crawl IDs that are currently at concurrency limit
    /// These crawls should be skipped when popping
    #[serde(default)]
    pub blocked_crawl_ids: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompleteJobRequest {
    /// Base64-encoded queue key
    pub queue_key: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseJobRequest {
    /// The job ID to release claims for
    pub job_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PushActiveJobRequest {
    pub team_id: String,
    pub job_id: String,
    pub timeout: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveActiveJobRequest {
    pub team_id: String,
    pub job_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PushCrawlActiveJobRequest {
    pub crawl_id: String,
    pub job_id: String,
    pub timeout: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveCrawlActiveJobRequest {
    pub crawl_id: String,
    pub job_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SampleCountersQuery {
    #[serde(default)]
    pub limit: Option<u32>,
    #[serde(default)]
    pub after: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetTeamJobIdsQuery {
    #[serde(default)]
    pub limit: Option<u32>,
}

// === Response types ===

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CountResponse {
    pub count: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobIdsResponse {
    pub job_ids: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupResponse {
    pub cleaned: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReconcileResponse {
    pub correction: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SampleResponse {
    pub ids: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthResponse {
    pub status: String,
    pub fdb_connected: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SuccessResponse {
    pub success: bool,
}
