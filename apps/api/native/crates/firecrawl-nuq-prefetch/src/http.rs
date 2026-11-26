//! Lightweight `hyper` HTTP/1.1 server exposing `/health` and `/metrics` with
//! exact parity to `apps/api/src/services/worker/nuq-prefetch-worker.ts`.

use std::convert::Infallible;
use std::net::SocketAddr;
use std::pin::pin;
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use http::header::{ALLOW, CONTENT_TYPE};
use http::{Method, Request, Response, StatusCode};
use http_body_util::Full;
use hyper::body::Incoming;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper_util::rt::TokioIo;
use thiserror::Error;
use tokio::net::TcpListener;
use tokio::sync::watch;
use tokio::task::JoinSet;

use crate::pg::format_pool_metrics;
use crate::worker::PrefetchStore;

const TEXT_PLAIN_UTF8: &str = "text/plain; charset=utf-8";
const SHUTDOWN_DRAIN_TIMEOUT: Duration = Duration::from_secs(5);

/// Errors returned when binding the HTTP server socket.
#[derive(Debug, Error)]
pub enum HttpServerError {
  #[error("failed to bind HTTP server on {addr}: {source}")]
  Bind {
    addr: SocketAddr,
    source: std::io::Error,
  },
}

/// Bound HTTP server exposing `/health` and `/metrics`.
#[derive(Debug)]
pub struct BoundHttpServer<S> {
  listener: TcpListener,
  local_addr: SocketAddr,
  store: Arc<S>,
}

impl<S: PrefetchStore> BoundHttpServer<S> {
  /// Binds the TCP listener on `addr`.
  pub async fn bind(addr: SocketAddr, store: Arc<S>) -> Result<Self, HttpServerError> {
    let listener = TcpListener::bind(addr)
      .await
      .map_err(|source| HttpServerError::Bind { addr, source })?;
    let local_addr = listener
      .local_addr()
      .map_err(|source| HttpServerError::Bind { addr, source })?;
    Ok(Self {
      listener,
      local_addr,
      store,
    })
  }

  /// Returns the bound local socket address (useful with ephemeral port `0`).
  #[must_use]
  pub const fn local_addr(&self) -> SocketAddr {
    self.local_addr
  }

  /// Serves incoming connections until `shutdown` flips to `true`, then drains
  /// active connections up to [`SHUTDOWN_DRAIN_TIMEOUT`].
  pub async fn serve(self, mut shutdown: watch::Receiver<bool>) {
    tracing::info!(
      port = self.local_addr.port(),
      "NuQ prefetch worker metrics server started"
    );

    let mut connections: JoinSet<()> = JoinSet::new();

    loop {
      while connections.try_join_next().is_some() {}

      if *shutdown.borrow() {
        break;
      }

      tokio::select! {
        _ = shutdown.changed() => {
          if *shutdown.borrow() {
            break;
          }
        }
        accepted = self.listener.accept() => {
          match accepted {
            Ok((stream, _peer)) => {
              let store = Arc::clone(&self.store);
              let conn_shutdown = shutdown.clone();
              connections.spawn(serve_connection(stream, store, conn_shutdown));
            }
            Err(err) => {
              tracing::warn!(error = %err, "HTTP accept failed");
            }
          }
        }
      }
    }

    let drain = async { while connections.join_next().await.is_some() {} };
    if tokio::time::timeout(SHUTDOWN_DRAIN_TIMEOUT, drain)
      .await
      .is_err()
    {
      connections.abort_all();
    }
  }
}

async fn serve_connection<S: PrefetchStore>(
  stream: tokio::net::TcpStream,
  store: Arc<S>,
  mut shutdown: watch::Receiver<bool>,
) {
  let io = TokioIo::new(stream);
  let svc = service_fn(move |req: Request<Incoming>| {
    let store = Arc::clone(&store);
    async move { Ok::<_, Infallible>(handle_request(&req, store.as_ref()).await) }
  });

  let mut conn = pin!(
    http1::Builder::new()
      .keep_alive(true)
      .serve_connection(io, svc)
  );

  tokio::select! {
    res = conn.as_mut() => {
      if let Err(err) = res {
        tracing::debug!(error = %err, "HTTP connection ended");
      }
    }
    _ = async {
      while !*shutdown.borrow() {
        if shutdown.changed().await.is_err() {
          break;
        }
      }
    } => {
      conn.as_mut().graceful_shutdown();
      let _ = conn.await;
    }
  }
}

async fn handle_request<S: PrefetchStore>(
  req: &Request<Incoming>,
  store: &S,
) -> Response<Full<Bytes>> {
  let method = req.method();
  let path = req.uri().path();
  let is_head = method == Method::HEAD;

  if method != Method::GET && !is_head {
    return match path {
      "/health" | "/metrics" => method_not_allowed(),
      _ => text_response(StatusCode::NOT_FOUND, "Not Found", is_head),
    };
  }

  match path {
    "/metrics" => {
      let body = format_pool_metrics(store.pool_metrics());
      text_response(StatusCode::OK, body, is_head)
    }
    "/health" => match store.health_check().await {
      Ok(true) => text_response(StatusCode::OK, "OK", is_head),
      Ok(false) => text_response(StatusCode::INTERNAL_SERVER_ERROR, "Not OK", is_head),
      Err(err) => {
        tracing::warn!(
          module = "nuq",
          error = %err,
          "NuQ health check failed"
        );
        text_response(StatusCode::INTERNAL_SERVER_ERROR, "Not OK", is_head)
      }
    },
    _ => text_response(StatusCode::NOT_FOUND, "Not Found", is_head),
  }
}

fn text_response(
  status: StatusCode,
  body: impl Into<Bytes>,
  empty_body: bool,
) -> Response<Full<Bytes>> {
  let bytes = if empty_body {
    Bytes::new()
  } else {
    body.into()
  };
  let mut resp = Response::new(Full::new(bytes));
  *resp.status_mut() = status;
  let _ = resp.headers_mut().insert(
    CONTENT_TYPE,
    http::HeaderValue::from_static(TEXT_PLAIN_UTF8),
  );
  resp
}

fn method_not_allowed() -> Response<Full<Bytes>> {
  let mut resp = text_response(StatusCode::METHOD_NOT_ALLOWED, "Method Not Allowed", false);
  let _ = resp
    .headers_mut()
    .insert(ALLOW, http::HeaderValue::from_static("GET, HEAD"));
  resp
}
