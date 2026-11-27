//! Standalone `firecrawl-nuq-prefetch` worker binary.

use std::fmt::Arguments;
use std::io::{self, Write};
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
  NUQ_POD_NAME                         Optional pod instance identifier for OpenTelemetry
  OTEL_EXPORTER_OTLP_ENDPOINT          Optional OTLP/HTTP base endpoint for trace export
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT   Optional OTLP/HTTP traces endpoint override
  OTEL_SERVICE_NAME                    Service name for OpenTelemetry resource
  OTEL_TRACES_SAMPLER                  OpenTelemetry sampler name (default: parentbased_always_on)
  OTEL_TRACES_SAMPLER_ARG              OpenTelemetry sampler ratio argument
  RUST_LOG                             Log filter directive (default: info)
";

fn main() -> ExitCode {
  let cmd = match parse_cli_args(std::env::args_os().skip(1)) {
    Ok(cmd) => cmd,
    Err(err) => {
      let _ = writeln!(io::stderr().lock(), "error: {err}");
      return ExitCode::from(2);
    }
  };

  match cmd {
    CliCommand::Help => return write_cli_output(format_args!("{USAGE}")),
    CliCommand::Version => {
      return write_cli_output(format_args!(
        "firecrawl-nuq-prefetch {}\n",
        env!("CARGO_PKG_VERSION")
      ));
    }
    CliCommand::CheckConfig => match WorkerConfig::from_env() {
      Ok(cfg) => {
        if let Err(err) = PgStore::new(&cfg.pg_settings) {
          let _ = writeln!(io::stderr().lock(), "config check failed: {err}");
          return ExitCode::FAILURE;
        }
        return write_cli_output(format_args!("{}\n", cfg.redacted_summary()));
      }
      Err(err) => {
        let _ = writeln!(io::stderr().lock(), "config check failed: {err}");
        return ExitCode::FAILURE;
      }
    },
    CliCommand::Run => {}
  }

  let config = match WorkerConfig::from_env() {
    Ok(cfg) => cfg,
    Err(err) => {
      let _ = writeln!(io::stderr().lock(), "startup configuration error: {err}");
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

fn write_cli_output(args: Arguments<'_>) -> ExitCode {
  let mut stdout = io::stdout().lock();
  match stdout.write_fmt(args).and_then(|()| stdout.flush()) {
    Ok(()) => ExitCode::SUCCESS,
    Err(err) if err.kind() == io::ErrorKind::BrokenPipe => ExitCode::SUCCESS,
    Err(err) => {
      let _ = writeln!(io::stderr().lock(), "failed to write output: {err}");
      ExitCode::FAILURE
    }
  }
}

async fn run_worker(config: WorkerConfig) -> ExitCode {
  tracing::info!(
    config = %config.redacted_summary(),
    "firecrawl-nuq-prefetch starting"
  );

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

  let rabbitmq_configured = config.rabbitmq_url.is_some();
  let publisher = Arc::new(AmqpPrefetchPublisher::new(config.rabbitmq_url));
  let (shutdown_tx, mut shutdown_rx) = watch::channel(false);

  let signal_task = tokio::spawn(wait_for_shutdown_signal(shutdown_tx));
  let http_task = tokio::spawn(http_server.serve(shutdown_rx.clone()));

  if rabbitmq_configured {
    run_prefetch_loops(
      Arc::clone(&store),
      Arc::clone(&publisher),
      heartbeat,
      DEFAULT_POLL_INTERVAL,
      shutdown_rx,
    )
    .await;
  } else {
    tracing::warn!(
      module = "nuq/rabbitmq",
      "NUQ_RABBITMQ_URL is unset; serving /health and /metrics without claiming PostgreSQL jobs"
    );
    while !*shutdown_rx.borrow() {
      if shutdown_rx.changed().await.is_err() {
        break;
      }
    }
  }

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
    let mut sigint = match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())
    {
      Ok(stream) => Some(stream),
      Err(err) => {
        tracing::warn!(error = %err, "Failed to register SIGINT handler");
        None
      }
    };
    let mut sigterm = match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
    {
      Ok(stream) => Some(stream),
      Err(err) => {
        tracing::warn!(error = %err, "Failed to register SIGTERM handler");
        None
      }
    };

    tokio::select! {
      _ = async {
        match sigint.as_mut() {
          Some(stream) => {
            let _ = stream.recv().await;
          }
          None => std::future::pending::<()>().await,
        }
      } => {
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
    match tokio::signal::ctrl_c().await {
      Ok(()) => {
        tracing::info!("Received SIGINT. Shutting down gracefully...");
      }
      Err(err) => {
        tracing::warn!(error = %err, "Failed to register Ctrl-C handler");
        std::future::pending::<()>().await;
      }
    }
  }

  let _ = shutdown_tx.send(true);
}
