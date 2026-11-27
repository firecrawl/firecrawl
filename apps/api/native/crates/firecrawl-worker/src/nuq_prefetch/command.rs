use std::ffi::OsString;
use std::fmt::Arguments;
use std::io::{self, Write};
use std::net::SocketAddr;
use std::process::ExitCode;
use std::sync::Arc;

use tokio::sync::watch;

use super::{
  AmqpPrefetchPublisher, BoundHttpServer, CliCommand, DEFAULT_POLL_INTERVAL, PgStore,
  ReqwestHeartbeatClient, WorkerConfig, parse_cli_args, run_prefetch_loops,
};

const USAGE: &str = "\
NuQ prefetch worker

USAGE:
  firecrawl-worker nuq-prefetch [OPTIONS]

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

/// Handles NuQ prefetch arguments after the role name and runs the selected command.
/// Call outside a Tokio runtime. Embedders with a runtime can call [`run`] instead.
pub fn run_cli(args: impl IntoIterator<Item = impl Into<OsString>>) -> ExitCode {
  let cmd = match parse_cli_args(args) {
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
        "firecrawl-worker nuq-prefetch {}\n",
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

  if tokio::runtime::Handle::try_current().is_ok() {
    let _ = writeln!(
      io::stderr().lock(),
      "cannot start the worker CLI inside a Tokio runtime; use the async worker entry point"
    );
    return ExitCode::FAILURE;
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

  let (shutdown_tx, shutdown) = watch::channel(false);
  let exit_code = runtime.block_on(async {
    tokio::select! {
      code = run(config, shutdown) => code,
      code = wait_for_shutdown_signals(shutdown_tx) => code,
    }
  });
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

/// Runs the NuQ prefetch role until shutdown is requested or startup fails.
/// The caller manages telemetry and sends `true` on the shutdown channel.
pub async fn run(config: WorkerConfig, mut shutdown: watch::Receiver<bool>) -> ExitCode {
  tracing::info!(
    config = %config.redacted_summary(),
    "NuQ prefetch worker starting"
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
  let http_task = tokio::spawn(http_server.serve(shutdown.clone()));

  if rabbitmq_configured {
    run_prefetch_loops(
      Arc::clone(&store),
      Arc::clone(&publisher),
      heartbeat,
      DEFAULT_POLL_INTERVAL,
      shutdown,
    )
    .await;
  } else {
    tracing::warn!(
      module = "nuq/rabbitmq",
      "NUQ_RABBITMQ_URL is unset; serving /health and /metrics without claiming PostgreSQL jobs"
    );
    while !*shutdown.borrow() {
      if shutdown.changed().await.is_err() {
        break;
      }
    }
  }

  tracing::info!("All prefetch loops exited. Shutting down...");
  let _ = http_task.await;
  publisher.shutdown().await;
  store.close();
  ExitCode::SUCCESS
}

async fn wait_for_shutdown_signals(shutdown_tx: watch::Sender<bool>) -> ExitCode {
  #[cfg(unix)]
  let mut sigint = register_signal(tokio::signal::unix::SignalKind::interrupt(), "SIGINT");
  #[cfg(unix)]
  let mut sigterm = register_signal(tokio::signal::unix::SignalKind::terminate(), "SIGTERM");

  loop {
    #[cfg(unix)]
    let (signal, code) = tokio::select! {
      () = receive_signal(&mut sigint) => ("SIGINT", 130),
      () = receive_signal(&mut sigterm) => ("SIGTERM", 143),
    };
    #[cfg(not(unix))]
    let (signal, code) = match tokio::signal::ctrl_c().await {
      Ok(()) => ("SIGINT", 130),
      Err(err) => {
        tracing::warn!(error = %err, "Failed to register Ctrl-C handler");
        return std::future::pending().await;
      }
    };

    if *shutdown_tx.borrow() {
      tracing::warn!(
        signal,
        "Received a second signal; interrupting worker shutdown"
      );
      return ExitCode::from(code);
    }

    tracing::info!(signal, "Shutting down the worker gracefully");
    let _ = shutdown_tx.send(true);
  }
}

#[cfg(unix)]
fn register_signal(
  kind: tokio::signal::unix::SignalKind,
  name: &'static str,
) -> Option<tokio::signal::unix::Signal> {
  match tokio::signal::unix::signal(kind) {
    Ok(stream) => Some(stream),
    Err(err) => {
      tracing::warn!(signal = name, error = %err, "Failed to register shutdown signal");
      None
    }
  }
}

#[cfg(unix)]
async fn receive_signal(stream: &mut Option<tokio::signal::unix::Signal>) {
  if let Some(stream) = stream
    && stream.recv().await.is_some()
  {
    return;
  }
  std::future::pending().await
}
