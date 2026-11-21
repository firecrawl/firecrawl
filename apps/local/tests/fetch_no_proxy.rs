use std::sync::{
  atomic::{AtomicBool, Ordering},
  Arc, Mutex,
};
use std::time::Duration;

use firecrawl_local::{
  fetch::{FetchOptions, Fetcher},
  guard::NetworkPolicy,
};
use tokio::io::AsyncWriteExt;
use tokio::net::TcpListener;
use url::Url;

static ENV_LOCK: Mutex<()> = Mutex::new(());

struct ProxyEnvGuard {
  saved: Vec<(&'static str, Option<String>)>,
}

impl ProxyEnvGuard {
  const VARS: &'static [&'static str] = &[
    "HTTP_PROXY",
    "http_proxy",
    "HTTPS_PROXY",
    "https_proxy",
    "ALL_PROXY",
    "all_proxy",
    "NO_PROXY",
    "no_proxy",
  ];

  fn set(pairs: &[(&'static str, &str)]) -> Self {
    let saved = Self::VARS
      .iter()
      .map(|&k| (k, std::env::var(k).ok()))
      .collect();
    for &k in Self::VARS {
      std::env::remove_var(k);
    }
    for &(k, v) in pairs {
      std::env::set_var(k, v);
    }
    Self { saved }
  }
}

impl Drop for ProxyEnvGuard {
  fn drop(&mut self) {
    for &(k, ref v) in &self.saved {
      match v {
        Some(val) => std::env::set_var(k, val),
        None => std::env::remove_var(k),
      }
    }
  }
}

#[tokio::test]
async fn fetcher_ignores_proxy_env_vars_under_all_policies() {
  let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());

  let listener = TcpListener::bind("127.0.0.1:0")
    .await
    .expect("bind loopback stand-in proxy");
  let proxy_addr = listener.local_addr().unwrap();
  let proxy_hit = Arc::new(AtomicBool::new(false));
  let hit_flag = proxy_hit.clone();

  let server = tokio::spawn(async move {
    while let Ok((mut sock, _)) = listener.accept().await {
      hit_flag.store(true, Ordering::SeqCst);
      let _ = sock
        .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok")
        .await;
    }
  });

  let proxy_url = format!("http://{proxy_addr}");
  let _env = ProxyEnvGuard::set(&[
    ("HTTP_PROXY", &proxy_url),
    ("HTTPS_PROXY", &proxy_url),
    ("ALL_PROXY", &proxy_url),
  ]);

  let target = Url::parse("http://target.invalid/").unwrap();
  let opts = FetchOptions {
    headers: Default::default(),
    timeout: Some(Duration::from_secs(2)),
  };

  for policy in [NetworkPolicy::PublicOnly, NetworkPolicy::AllowPrivate] {
    let fetcher = Fetcher::new(policy, None).expect("fetcher builds");
    let res = fetcher.fetch(&target, &opts).await;
    assert!(
      res.is_err(),
      "expected target.invalid to fail without reaching stand-in proxy under {policy:?}"
    );
    assert!(
      !proxy_hit.load(Ordering::SeqCst),
      "proxy environment variable bypassed GuardedResolver under {policy:?}"
    );
  }

  // Process env vars remain intact for Firecrawl Cloud calls
  assert_eq!(
    std::env::var("HTTP_PROXY").ok().as_deref(),
    Some(proxy_url.as_str())
  );
  assert_eq!(
    std::env::var("HTTPS_PROXY").ok().as_deref(),
    Some(proxy_url.as_str())
  );

  server.abort();
}
