//! Lightweight `hyper` HTTP/1.1 server exposing `/health` and `/metrics` with
//! exact parity to `apps/api/src/services/worker/nuq-prefetch-worker.ts`.

use std::convert::Infallible;
use std::net::SocketAddr;
use std::pin::pin;
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use http::header::{ALLOW, CONTENT_LENGTH, CONTENT_TYPE};
use http::{Method, Request, Response, StatusCode};
use http_body_util::Full;
use hyper::body::Incoming;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper_util::rt::{TokioIo, TokioTimer};
use thiserror::Error;
use tokio::net::TcpListener;
use tokio::sync::{OwnedSemaphorePermit, Semaphore, watch};
use tokio::task::JoinSet;

use crate::pg::format_pool_metrics;
use crate::worker::PrefetchStore;

const TEXT_PLAIN_UTF8: &str = "text/plain; charset=utf-8";
const SHUTDOWN_DRAIN_TIMEOUT: Duration = Duration::from_secs(5);
const HEADER_READ_TIMEOUT: Duration = Duration::from_secs(10);
const ACCEPT_ERROR_BACKOFF: Duration = Duration::from_millis(50);
const MAX_CONCURRENT_CONNECTIONS: usize = 64;

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
    let conn_limit = Arc::new(Semaphore::new(MAX_CONCURRENT_CONNECTIONS));

    loop {
      while connections.try_join_next().is_some() {}

      if *shutdown.borrow() {
        break;
      }

      let permit = tokio::select! {
        res = shutdown.changed() => {
          if res.is_err() || *shutdown.borrow() {
            break;
          }
          continue;
        }
        permit = Arc::clone(&conn_limit).acquire_owned() => {
          match permit {
            Ok(permit) => permit,
            Err(_) => break,
          }
        }
      };

      tokio::select! {
        res = shutdown.changed() => {
          drop(permit);
          if res.is_err() || *shutdown.borrow() {
            break;
          }
        }
        accepted = self.listener.accept() => {
          match accepted {
            Ok((stream, _peer)) => {
              let store = Arc::clone(&self.store);
              let conn_shutdown = shutdown.clone();
              connections.spawn(serve_connection(stream, store, conn_shutdown, permit));
            }
            Err(err) => {
              drop(permit);
              tracing::warn!(error = %err, "HTTP accept failed");
              tokio::select! {
                () = tokio::time::sleep(ACCEPT_ERROR_BACKOFF) => {}
                res = shutdown.changed() => {
                  if res.is_err() || *shutdown.borrow() {
                    break;
                  }
                }
              }
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
  _permit: OwnedSemaphorePermit,
) {
  let io = TokioIo::new(stream);
  let svc = service_fn(move |req: Request<Incoming>| {
    let store = Arc::clone(&store);
    async move { Ok::<_, Infallible>(handle_request(&req, store.as_ref()).await) }
  });

  let mut conn = pin!(
    http1::Builder::new()
      .keep_alive(true)
      .timer(TokioTimer::new())
      .header_read_timeout(HEADER_READ_TIMEOUT)
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
  let body_bytes: Bytes = body.into();
  let content_length = body_bytes.len();
  let transmitted = if empty_body { Bytes::new() } else { body_bytes };
  let mut resp = Response::new(Full::new(transmitted));
  *resp.status_mut() = status;
  let _ = resp.headers_mut().insert(
    CONTENT_TYPE,
    http::HeaderValue::from_static(TEXT_PLAIN_UTF8),
  );
  let _ = resp
    .headers_mut()
    .insert(CONTENT_LENGTH, http::HeaderValue::from(content_length));
  resp
}

fn method_not_allowed() -> Response<Full<Bytes>> {
  let mut resp = text_response(StatusCode::METHOD_NOT_ALLOWED, "Method Not Allowed", false);
  let _ = resp
    .headers_mut()
    .insert(ALLOW, http::HeaderValue::from_static("GET, HEAD"));
  resp
}
