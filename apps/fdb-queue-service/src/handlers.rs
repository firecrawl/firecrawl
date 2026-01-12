use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Json,
};
use std::collections::HashSet;

use crate::models::*;
use crate::AppState;

type ApiResult<T> = Result<Json<T>, (StatusCode, String)>;

fn internal_error(e: impl std::fmt::Display) -> (StatusCode, String) {
    tracing::error!("Internal error: {}", e);
    (StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
}

// === Health ===

pub async fn health(State(state): State<AppState>) -> ApiResult<HealthResponse> {
    let fdb_connected = match state.fdb.health_check().await {
        Ok(connected) => connected,
        Err(e) => {
            tracing::warn!("FDB health check failed: {}", e);
            false
        }
    };
    Ok(Json(HealthResponse {
        status: if fdb_connected { "ok".to_string() } else { "degraded".to_string() },
        fdb_connected,
    }))
}

// === Queue operations ===

pub async fn push_job(
    State(state): State<AppState>,
    Json(req): Json<PushJobRequest>,
) -> ApiResult<SuccessResponse> {
    state.fdb.push_job(
        &req.team_id,
        &req.job.id,
        req.job.data,
        req.job.priority,
        req.job.listenable,
        req.job.listen_channel_id.as_deref(),
        req.timeout,
        req.crawl_id.as_deref(),
    ).await.map_err(internal_error)?;

    Ok(Json(SuccessResponse { success: true }))
}

pub async fn pop_next_job(
    State(state): State<AppState>,
    Path(team_id): Path<String>,
    Json(req): Json<PopJobRequest>,
) -> ApiResult<Option<ClaimedJob>> {
    let blocked_crawl_ids: HashSet<String> = req.blocked_crawl_ids.into_iter().collect();

    let job = state.fdb.pop_next_job(&team_id, &req.worker_id, &blocked_crawl_ids)
        .await
        .map_err(internal_error)?;

    Ok(Json(job))
}

pub async fn complete_job(
    State(state): State<AppState>,
    Json(req): Json<CompleteJobRequest>,
) -> ApiResult<SuccessResponse> {
    let success = state.fdb.complete_job(&req.queue_key)
        .await
        .map_err(internal_error)?;

    Ok(Json(SuccessResponse { success }))
}

pub async fn release_job(
    State(state): State<AppState>,
    Json(req): Json<ReleaseJobRequest>,
) -> ApiResult<SuccessResponse> {
    state.fdb.release_job(&req.job_id)
        .await
        .map_err(internal_error)?;

    Ok(Json(SuccessResponse { success: true }))
}

pub async fn get_team_queue_count(
    State(state): State<AppState>,
    Path(team_id): Path<String>,
) -> ApiResult<CountResponse> {
    let count = state.fdb.get_team_queue_count(&team_id)
        .await
        .map_err(internal_error)?;

    Ok(Json(CountResponse { count }))
}

pub async fn get_crawl_queue_count(
    State(state): State<AppState>,
    Path(crawl_id): Path<String>,
) -> ApiResult<CountResponse> {
    let count = state.fdb.get_crawl_queue_count(&crawl_id)
        .await
        .map_err(internal_error)?;

    Ok(Json(CountResponse { count }))
}

pub async fn get_team_queued_job_ids(
    State(state): State<AppState>,
    Path(team_id): Path<String>,
    Query(query): Query<GetTeamJobIdsQuery>,
) -> ApiResult<JobIdsResponse> {
    let limit = query.limit.unwrap_or(10000);
    let job_ids = state.fdb.get_team_queued_job_ids(&team_id, limit)
        .await
        .map_err(internal_error)?;

    Ok(Json(JobIdsResponse { job_ids }))
}

// === Active job operations ===

pub async fn push_active_job(
    State(state): State<AppState>,
    Json(req): Json<PushActiveJobRequest>,
) -> ApiResult<SuccessResponse> {
    state.fdb.push_active_job(&req.team_id, &req.job_id, req.timeout)
        .await
        .map_err(internal_error)?;

    Ok(Json(SuccessResponse { success: true }))
}

pub async fn remove_active_job(
    State(state): State<AppState>,
    Json(req): Json<RemoveActiveJobRequest>,
) -> ApiResult<SuccessResponse> {
    state.fdb.remove_active_job(&req.team_id, &req.job_id)
        .await
        .map_err(internal_error)?;

    Ok(Json(SuccessResponse { success: true }))
}

pub async fn get_active_job_count(
    State(state): State<AppState>,
    Path(team_id): Path<String>,
) -> ApiResult<CountResponse> {
    let count = state.fdb.get_active_job_count(&team_id)
        .await
        .map_err(internal_error)?;

    Ok(Json(CountResponse { count }))
}

pub async fn get_active_jobs(
    State(state): State<AppState>,
    Path(team_id): Path<String>,
) -> ApiResult<JobIdsResponse> {
    let job_ids = state.fdb.get_active_jobs(&team_id)
        .await
        .map_err(internal_error)?;

    Ok(Json(JobIdsResponse { job_ids }))
}

// === Crawl active job operations ===

pub async fn push_crawl_active_job(
    State(state): State<AppState>,
    Json(req): Json<PushCrawlActiveJobRequest>,
) -> ApiResult<SuccessResponse> {
    state.fdb.push_crawl_active_job(&req.crawl_id, &req.job_id, req.timeout)
        .await
        .map_err(internal_error)?;

    Ok(Json(SuccessResponse { success: true }))
}

pub async fn remove_crawl_active_job(
    State(state): State<AppState>,
    Json(req): Json<RemoveCrawlActiveJobRequest>,
) -> ApiResult<SuccessResponse> {
    state.fdb.remove_crawl_active_job(&req.crawl_id, &req.job_id)
        .await
        .map_err(internal_error)?;

    Ok(Json(SuccessResponse { success: true }))
}

pub async fn get_crawl_active_jobs(
    State(state): State<AppState>,
    Path(crawl_id): Path<String>,
) -> ApiResult<JobIdsResponse> {
    let job_ids = state.fdb.get_crawl_active_jobs(&crawl_id)
        .await
        .map_err(internal_error)?;

    Ok(Json(JobIdsResponse { job_ids }))
}

// === Cleanup operations ===

pub async fn clean_expired_jobs(
    State(state): State<AppState>,
) -> ApiResult<CleanupResponse> {
    let cleaned = state.fdb.clean_expired_jobs()
        .await
        .map_err(internal_error)?;

    Ok(Json(CleanupResponse { cleaned }))
}

pub async fn clean_expired_active_jobs(
    State(state): State<AppState>,
) -> ApiResult<CleanupResponse> {
    let cleaned = state.fdb.clean_expired_active_jobs()
        .await
        .map_err(internal_error)?;

    Ok(Json(CleanupResponse { cleaned }))
}

pub async fn clean_stale_counters(
    State(state): State<AppState>,
) -> ApiResult<CleanupResponse> {
    let cleaned = state.fdb.clean_stale_counters()
        .await
        .map_err(internal_error)?;

    Ok(Json(CleanupResponse { cleaned }))
}

pub async fn clean_orphaned_claims(
    State(state): State<AppState>,
) -> ApiResult<CleanupResponse> {
    let cleaned = state.fdb.clean_orphaned_claims()
        .await
        .map_err(internal_error)?;

    Ok(Json(CleanupResponse { cleaned }))
}

// === Counter reconciliation ===

pub async fn reconcile_team_queue_counter(
    State(state): State<AppState>,
    Path(team_id): Path<String>,
) -> ApiResult<ReconcileResponse> {
    let correction = state.fdb.reconcile_team_queue_counter(&team_id)
        .await
        .map_err(internal_error)?;

    Ok(Json(ReconcileResponse { correction }))
}

pub async fn reconcile_team_active_counter(
    State(state): State<AppState>,
    Path(team_id): Path<String>,
) -> ApiResult<ReconcileResponse> {
    let correction = state.fdb.reconcile_team_active_counter(&team_id)
        .await
        .map_err(internal_error)?;

    Ok(Json(ReconcileResponse { correction }))
}

pub async fn reconcile_crawl_queue_counter(
    State(state): State<AppState>,
    Path(crawl_id): Path<String>,
) -> ApiResult<ReconcileResponse> {
    let correction = state.fdb.reconcile_crawl_queue_counter(&crawl_id)
        .await
        .map_err(internal_error)?;

    Ok(Json(ReconcileResponse { correction }))
}

pub async fn reconcile_crawl_active_counter(
    State(state): State<AppState>,
    Path(crawl_id): Path<String>,
) -> ApiResult<ReconcileResponse> {
    let correction = state.fdb.reconcile_crawl_active_counter(&crawl_id)
        .await
        .map_err(internal_error)?;

    Ok(Json(ReconcileResponse { correction }))
}

// === Counter sampling ===

pub async fn sample_team_counters(
    State(state): State<AppState>,
    Query(query): Query<SampleCountersQuery>,
) -> ApiResult<SampleResponse> {
    let limit = query.limit.unwrap_or(50);
    let ids = state.fdb.sample_team_counters(limit, query.after.as_deref())
        .await
        .map_err(internal_error)?;

    Ok(Json(SampleResponse { ids }))
}

pub async fn sample_crawl_counters(
    State(state): State<AppState>,
    Query(query): Query<SampleCountersQuery>,
) -> ApiResult<SampleResponse> {
    let limit = query.limit.unwrap_or(50);
    let ids = state.fdb.sample_crawl_counters(limit, query.after.as_deref())
        .await
        .map_err(internal_error)?;

    Ok(Json(SampleResponse { ids }))
}
