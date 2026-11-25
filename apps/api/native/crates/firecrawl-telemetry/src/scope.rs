//! Worker-thread span propagation helpers for `tokio::task::spawn_blocking`,
//! scoped `rayon` pools, and OS threads so `ZdrLayer` and `in_zdr_span()`
//! remain intact across thread boundaries.

use tracing::{Dispatch, Span};

/// Spawns `f` on Tokio's blocking pool with the caller's active `tracing`
/// subscriber and current [`Span`] entered on the worker thread.
pub fn spawn_blocking_with_span<F, R>(f: F) -> tokio::task::JoinHandle<R>
where
  F: FnOnce() -> R + Send + 'static,
  R: Send + 'static,
{
  spawn_blocking_in_span(Span::current(), f)
}

/// Spawns `f` on Tokio's blocking pool with the caller's active `tracing`
/// subscriber and the supplied `span` entered on the worker thread.
pub fn spawn_blocking_in_span<F, R>(span: Span, f: F) -> tokio::task::JoinHandle<R>
where
  F: FnOnce() -> R + Send + 'static,
  R: Send + 'static,
{
  let dispatch = tracing::dispatcher::get_default(Dispatch::clone);
  tokio::task::spawn_blocking(move || {
    tracing::dispatcher::with_default(&dispatch, || {
      let _guard = span.enter();
      f()
    })
  })
}

/// Runs `f` inside a scoped `rayon` thread pool whose worker threads enter the
/// caller's current [`Span`] and active `tracing` subscriber.
pub fn run_on_scoped_rayon_pool<R: Send>(
  num_threads: usize,
  f: impl FnOnce() -> R + Send,
) -> Result<R, rayon::ThreadPoolBuildError> {
  let span = Span::current();
  run_on_scoped_rayon_pool_in_span(&span, num_threads, f)
}

/// Runs `f` inside a scoped `rayon` thread pool whose worker threads enter
/// `span` and the caller's active `tracing` subscriber.
pub fn run_on_scoped_rayon_pool_in_span<R: Send>(
  span: &Span,
  num_threads: usize,
  f: impl FnOnce() -> R + Send,
) -> Result<R, rayon::ThreadPoolBuildError> {
  let dispatch = tracing::dispatcher::get_default(Dispatch::clone);
  rayon::ThreadPoolBuilder::new()
    .num_threads(num_threads)
    .build_scoped(
      |thread| {
        tracing::dispatcher::with_default(&dispatch, || {
          let _guard = span.enter();
          thread.run();
        });
      },
      |pool| pool.install(f),
    )
}

/// Spawns a named OS thread with the caller's active `tracing` subscriber and
/// current [`Span`] entered before executing `f`.
pub fn spawn_thread_with_span<F, R>(
  name: impl Into<String>,
  f: F,
) -> std::io::Result<std::thread::JoinHandle<R>>
where
  F: FnOnce() -> R + Send + 'static,
  R: Send + 'static,
{
  let span = Span::current();
  let dispatch = tracing::dispatcher::get_default(Dispatch::clone);
  std::thread::Builder::new()
    .name(name.into())
    .spawn(move || {
      tracing::dispatcher::with_default(&dispatch, || {
        let _guard = span.enter();
        f()
      })
    })
}
