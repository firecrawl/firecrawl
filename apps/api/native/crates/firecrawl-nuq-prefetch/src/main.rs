//! Standalone `firecrawl-nuq-prefetch` worker binary.

use std::net::SocketAddr;
use std::process::ExitCode;
use std::sync::Arc;

use tokio::sync::watch;

use firecrawl_nuq_prefetch::{
  AmqpPrefetchPublisher, BoundHttpServer, CliCommand, DEFAULT_POLL_INTERVAL, PgStore,
  ReqwestHeartbeatClient, WorkerConfig, parse_cli_args, run_prefetch_loops,
};

// Install jemalloc ONLY in this standalone Linux binary, never in any cdylib.
// `background_threads` returns unused pages to the OS instead of retaining
// arena RSS across prefetch bursts.
#[cfg(target_os = "linux")]
#[global_allocator]
static ALLOCATOR: tikv_jemallocator::Jemalloc = tikv_jemallocator::Jemalloc;

const USAGE: &str = "\
firecrawl-nuq-prefetch - standalone Rust NuQ prefetch worker

USAGE:
  firecrawl-nuq-prefetch [OPTIONS]

OPTIONS:
  --check-config    Validate environment configuration, print a redacted summary, and exit
  -h, --help        Print this help message
  -V, --version     Print version information

ENVIRONMENT:
  NUQ_DATABASE_URL                     PostgreSQL connection URL (required; supports PgBouncer)
  NUQ_RABBITMQ_URL                     Optional RabbitMQ AMQP/AMQPS connection URL
  NUQ_PREFETCH_WORKER_PORT             HTTP server port for /health and /metrics (default: 3011)
  NUQ_PREFETCH_WORKER_HEARTBEAT_URL    Optional heartbeat URL pinged on the scrape prefetch loop
  NUQ_POD_NAME                         Pod instance identifier (default: main)
  OTEL_EXPORTER_OTLP_ENDPOINT          Optional OTLP/HTTP base endpoint for trace export
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT   Optional OTLP/HTTP traces endpoint override
  OTEL_SERVICE_NAME                    Service name for OpenTelemetry resource
  OTEL_TRACES_SAMPLER                  OpenTelemetry sampler name (default: parentbased_always_on)
  OTEL_TRACES_SAMPLER_ARG              OpenTelemetry sampler ratio argument
  RUST_LOG                             Log filter directive (default: info)
";

fn main() -> ExitCode {
  let cmd = match parse_cli_args(std::env::args().skip(1)) {
    Ok(cmd) => cmd,
    Err(err) => {
      eprintln!("error: {err}");
      return ExitCode::from(2);
    }
  };

  match cmd {
    CliCommand::Help => {
      print!("{USAGE}");
      return ExitCode::SUCCESS;
    }
    CliCommand::Version => {
      println!("firecrawl-nuq-prefetch {}", env!("CARGO_PKG_VERSION"));
      return ExitCode::SUCCESS;
    }
    CliCommand::CheckConfig => match WorkerConfig::from_env() {
      Ok(cfg) => {
        println!("{}", cfg.redacted_summary());
        return ExitCode::SUCCESS;
      }
      Err(err) => {
        eprintln!("config check failed: {err}");
        return ExitCode::FAILURE;
      }
    },
    CliCommand::Run => {}
  }

  let config = match WorkerConfig::from_env() {
    Ok(cfg) => cfg,
    Err(err) => {
      eprintln!("startup configuration error: {err}");
      return ExitCode::FAILURE;
    }
  };

  // Initialize telemetry before starting Tokio because the OTLP blocking HTTP
  // client must be constructed and flushed outside async runtime threads.
  // `_flush_guard` is declared before `runtime` so `runtime` drops first.
  firecrawl_core::telemetry::init_telemetry();
  let _flush_guard = firecrawl_core::telemetry::FlushGuard;

  let runtime = match tokio::runtime::Builder::new_multi_thread()
    .enable_all()
    .build()
  {
    Ok(rt) => rt,
    Err(err) => {
      tracing::error!(error = %err, "Failed to initialize Tokio runtime");
      return ExitCode::FAILURE;
    }
  };

  let exit_code = runtime.block_on(run_worker(config));
  drop(runtime);
  exit_code
}

async fn run_worker(config: WorkerConfig) -> ExitCode {
  tracing::info!(
    config = %config.redacted_summary(),
    "firecrawl-nuq-prefetch starting"
  );

  if config.rabbitmq_url.is_none() {
    tracing::warn!(
      module = "nuq/rabbitmq",
      "NUQ_RABBITMQ_URL is unset; prefetched jobs will log a warning without publishing"
    );
  }

  let store = match PgStore::new(&config.pg_settings) {
    Ok(store) => Arc::new(store),
    Err(err) => {
      tracing::error!(error = %err, "Failed to initialize NuQ PostgreSQL pool");
      return ExitCode::FAILURE;
    }
  };

  let heartbeat = match config.heartbeat_url {
    Some(url) => match ReqwestHeartbeatClient::new(url) {
      Ok(client) => Some(Arc::new(client)),
      Err(err) => {
        tracing::error!(error = %err, "Failed to initialize heartbeat HTTP client");
        store.close();
        return ExitCode::FAILURE;
      }
    },
    None => None,
  };

  let bind_addr = SocketAddr::from(([0, 0, 0, 0], config.port));
  let http_server = match BoundHttpServer::bind(bind_addr, Arc::clone(&store)).await {
    Ok(server) => server,
    Err(err) => {
      tracing::error!(
        error = %err,
        port = config.port,
        "Failed to start NuQ prefetch worker metrics server"
      );
      store.close();
      return ExitCode::FAILURE;
    }
  };

  let publisher = Arc::new(AmqpPrefetchPublisher::new(config.rabbitmq_url));
  let (shutdown_tx, shutdown_rx) = watch::channel(false);

  let signal_task = tokio::spawn(wait_for_shutdown_signal(shutdown_tx));
  let http_task = tokio::spawn(http_server.serve(shutdown_rx.clone()));

  run_prefetch_loops(
    Arc::clone(&store),
    Arc::clone(&publisher),
    heartbeat,
    DEFAULT_POLL_INTERVAL,
    shutdown_rx,
  )
  .await;

  tracing::info!("All prefetch loops exited. Shutting down...");
  let _ = http_task.await;
  publisher.shutdown().await;
  store.close();
  signal_task.abort();

  ExitCode::SUCCESS
}

async fn wait_for_shutdown_signal(shutdown_tx: watch::Sender<bool>) {
  #[cfg(unix)]
  {
    let sigint = tokio::signal::ctrl_c();
    let mut sigterm = match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
    {
      Ok(stream) => Some(stream),
      Err(err) => {
        tracing::warn!(error = %err, "Failed to register SIGTERM handler");
        None
      }
    };

    tokio::select! {
      _ = sigint => {
        tracing::info!("Received SIGINT. Shutting down gracefully...");
      }
      _ = async {
        match sigterm.as_mut() {
          Some(stream) => {
            let _ = stream.recv().await;
          }
          None => std::future::pending::<()>().await,
        }
      } => {
        tracing::info!("Received SIGTERM. Shutting down gracefully...");
      }
    }
  }

  #[cfg(not(unix))]
  {
    let _ = tokio::signal::ctrl_c().await;
    tracing::info!("Received SIGINT. Shutting down gracefully...");
  }

  let _ = shutdown_tx.send(true);
}
