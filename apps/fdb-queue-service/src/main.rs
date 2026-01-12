mod fdb;
mod handlers;
mod models;

use axum::{
    routing::{get, post, delete},
    Router,
};
use std::sync::Arc;
use tower_http::trace::TraceLayer;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

use crate::fdb::FdbQueue;

#[derive(Clone)]
pub struct AppState {
    pub fdb: Arc<FdbQueue>,
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Boot FDB network BEFORE tokio runtime starts
    // Safety: This must only be called once per process
    let network = unsafe { foundationdb::boot() };

    // Now start tokio runtime
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?
        .block_on(async_main(network))
}

async fn async_main(_network: foundationdb::api::NetworkAutoStop) -> Result<(), Box<dyn std::error::Error>> {
    // Initialize tracing
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "fdb_queue_service=info,tower_http=debug".into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();

    // Get cluster file path from environment
    let cluster_file = std::env::var("FDB_CLUSTER_FILE")
        .unwrap_or_else(|_| "/etc/foundationdb/fdb.cluster".to_string());

    let port = std::env::var("PORT")
        .unwrap_or_else(|_| "3100".to_string())
        .parse::<u16>()
        .expect("PORT must be a valid u16");

    // Initialize FDB
    tracing::info!("Initializing FoundationDB with cluster file: {}", cluster_file);
    let fdb = FdbQueue::new_with_cluster_file(&cluster_file)?;

    let state = AppState {
        fdb: Arc::new(fdb),
    };

    // Build router
    let app = Router::new()
        // Health check
        .route("/health", get(handlers::health))

        // Queue operations
        .route("/queue/push", post(handlers::push_job))
        .route("/queue/pop/:team_id", post(handlers::pop_next_job))
        .route("/queue/complete", post(handlers::complete_job))
        .route("/queue/release", post(handlers::release_job))
        .route("/queue/count/team/:team_id", get(handlers::get_team_queue_count))
        .route("/queue/count/crawl/:crawl_id", get(handlers::get_crawl_queue_count))
        .route("/queue/jobs/team/:team_id", get(handlers::get_team_queued_job_ids))

        // Active job operations
        .route("/active/push", post(handlers::push_active_job))
        .route("/active/remove", delete(handlers::remove_active_job))
        .route("/active/count/:team_id", get(handlers::get_active_job_count))
        .route("/active/jobs/:team_id", get(handlers::get_active_jobs))

        // Crawl active job operations
        .route("/active/crawl/push", post(handlers::push_crawl_active_job))
        .route("/active/crawl/remove", delete(handlers::remove_crawl_active_job))
        .route("/active/crawl/jobs/:crawl_id", get(handlers::get_crawl_active_jobs))

        // Cleanup and maintenance
        .route("/cleanup/expired-jobs", post(handlers::clean_expired_jobs))
        .route("/cleanup/expired-active-jobs", post(handlers::clean_expired_active_jobs))
        .route("/cleanup/stale-counters", post(handlers::clean_stale_counters))
        .route("/cleanup/orphaned-claims", post(handlers::clean_orphaned_claims))

        // Counter reconciliation
        .route("/reconcile/team/queue/:team_id", post(handlers::reconcile_team_queue_counter))
        .route("/reconcile/team/active/:team_id", post(handlers::reconcile_team_active_counter))
        .route("/reconcile/crawl/queue/:crawl_id", post(handlers::reconcile_crawl_queue_counter))
        .route("/reconcile/crawl/active/:crawl_id", post(handlers::reconcile_crawl_active_counter))

        // Counter sampling
        .route("/sample/teams", get(handlers::sample_team_counters))
        .route("/sample/crawls", get(handlers::sample_crawl_counters))

        // HTTP tracing for debugging
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{}", port)).await?;
    tracing::info!("FDB Queue Service listening on port {}", port);

    // Configure TCP settings for high concurrency
    let tcp_nodelay = std::env::var("TCP_NODELAY")
        .map(|v| v == "1" || v.to_lowercase() == "true")
        .unwrap_or(true); // Enable by default for lower latency

    axum::serve(listener, app)
        .tcp_nodelay(tcp_nodelay)
        .await?;

    Ok(())
}
