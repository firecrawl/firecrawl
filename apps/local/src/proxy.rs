//! Outbound proxy for the plain fetcher.
//!
//! A proxy set with `HTTPS_PROXY`, `HTTP_PROXY` or `ALL_PROXY` resolves the
//! names it is asked for itself, so the fetcher's guarded DNS resolver would
//! only see the proxy's own address. Instead, reqwest sends every proxied
//! request to a loopback relay in this process. The relay resolves and checks
//! the target with the network policy, then asks the upstream proxy for the
//! address it checked, never for the name. So neither the proxy nor a second
//! DNS answer can take the request to an address the policy refuses.
//!
//! `https://` targets reach the upstream proxy as an HTTP CONNECT to the
//! checked address. `http://` targets are forwarded with the checked address
//! in the request line and the name in the `Host` header.

use std::{
  net::{IpAddr, Ipv4Addr, SocketAddr},
  sync::Arc,
  time::Duration,
};

use futures::future::BoxFuture;
use hyper_util::client::proxy::matcher::{Intercept, Matcher};
use tokio::{
  io::{AsyncRead, AsyncReadExt, AsyncWriteExt, BufReader},
  net::{TcpListener, TcpStream},
};
use url::{Host, Url};

use crate::{
  fetch::FetchError,
  guard::{self, NetworkPolicy},
};

const MAX_HEAD_BYTES: usize = 64 * 1024;
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(15);

type Lookup = fn(String, u16) -> BoxFuture<'static, std::io::Result<Vec<SocketAddr>>>;

fn system_lookup(host: String, port: u16) -> BoxFuture<'static, std::io::Result<Vec<SocketAddr>>> {
  Box::pin(async move {
    Ok(
      tokio::net::lookup_host((host.as_str(), port))
        .await?
        .collect(),
    )
  })
}

struct Shared {
  policy: NetworkPolicy,
  proxies: Matcher,
  lookup: Lookup,
}

pub(crate) struct Relay {
  addr: SocketAddr,
  shared: Arc<Shared>,
  task: tokio::task::JoinHandle<()>,
}

impl Drop for Relay {
  fn drop(&mut self) {
    self.task.abort();
  }
}

impl Relay {
  /// Start a relay for the proxies the environment sets, or `None` when no
  /// proxy applies.
  pub(crate) fn from_env(policy: NetworkPolicy) -> Result<Option<Arc<Self>>, String> {
    Self::start(policy, Matcher::from_system(), system_lookup)
  }

  fn start(
    policy: NetworkPolicy,
    proxies: Matcher,
    lookup: Lookup,
  ) -> Result<Option<Arc<Self>>, String> {
    let mut any = false;
    for scheme in ["http", "https"] {
      let probe: http::Uri = format!("{scheme}://firecrawl-local.invalid/")
        .parse()
        .expect("static URI");
      if let Some(proxy) = proxies.intercept(&probe) {
        if proxy.uri().scheme_str() != Some("http") {
          return Err(
            "the outbound proxy (HTTPS_PROXY, HTTP_PROXY or ALL_PROXY) must be an http:// URL"
              .to_string(),
          );
        }
        any = true;
      }
    }
    if !any {
      return Ok(None);
    }

    let runtime = tokio::runtime::Handle::try_current()
      .map_err(|_| "the outbound proxy relay needs an async runtime".to_string())?;
    let listener = std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
      .and_then(|l| l.set_nonblocking(true).map(|()| l))
      .map_err(|e| format!("could not start the outbound proxy relay: {e}"))?;
    let addr = listener
      .local_addr()
      .map_err(|e| format!("could not start the outbound proxy relay: {e}"))?;
    let shared = Arc::new(Shared {
      policy,
      proxies,
      lookup,
    });
    let task = {
      let _guard = runtime.enter();
      let listener = TcpListener::from_std(listener)
        .map_err(|e| format!("could not start the outbound proxy relay: {e}"))?;
      let shared = shared.clone();
      runtime.spawn(async move {
        loop {
          let Ok((client, _)) = listener.accept().await else {
            tokio::time::sleep(Duration::from_millis(50)).await;
            continue;
          };
          let shared = shared.clone();
          tokio::spawn(async move {
            let _ = serve(client, &shared).await;
          });
        }
      })
    };
    Ok(Some(Arc::new(Self { addr, shared, task })))
  }

  /// The reqwest proxy rule: send each URL the environment proxies to this
  /// relay, and every other URL direct.
  pub(crate) fn reqwest_proxy(&self) -> reqwest::Proxy {
    let relay = Url::parse(&format!("http://{}", self.addr)).expect("loopback URL");
    let shared = self.shared.clone();
    reqwest::Proxy::custom(move |target| {
      let uri: http::Uri = target.as_str().parse().ok()?;
      shared.proxies.intercept(&uri).map(|_| relay.clone())
    })
  }

  /// Why the relay refused `url`, if it did. The relay can only close the
  /// connection, so the fetcher asks here to tell a refusal from an ordinary
  /// network failure.
  pub(crate) async fn explain(&self, url: &Url) -> Option<FetchError> {
    vet(url, &self.shared).await.err()
  }
}

/// The addresses a request for `url` may reach, or why it may not.
async fn vet(url: &Url, shared: &Shared) -> Result<Vec<SocketAddr>, FetchError> {
  guard::check_url(url, shared.policy).map_err(|e| FetchError::Blocked(e.0))?;
  let port = url
    .port_or_known_default()
    .ok_or_else(|| FetchError::Blocked("URL has no port".to_string()))?;
  let name = match url.host() {
    Some(Host::Domain(name)) => name.to_string(),
    Some(Host::Ipv4(ip)) => return Ok(vec![SocketAddr::new(IpAddr::V4(ip), port)]),
    Some(Host::Ipv6(ip)) => return Ok(vec![SocketAddr::new(IpAddr::V6(ip), port)]),
    None => return Err(FetchError::Blocked("URL has no host".to_string())),
  };
  let resolved = (shared.lookup)(name.clone(), port)
    .await
    .unwrap_or_default();
  if resolved.is_empty() {
    return Err(FetchError::Network(format!(
      "'{name}' does not resolve to any address"
    )));
  }
  let never_reachable = resolved.iter().any(|a| guard::ip_always_blocked(a.ip()));
  let mut allowed: Vec<SocketAddr> = resolved
    .into_iter()
    .filter(|a| guard::check_ip(a.ip(), shared.policy).is_ok())
    .collect();
  if allowed.is_empty() {
    return Err(FetchError::Blocked(crate::netguard::name_refusal(
      &name,
      true,
      never_reachable,
    )));
  }
  // An IPv4 address first: a forwarded request uses only the first address,
  // and a proxy that cannot reach IPv6 is more common than the reverse.
  allowed.sort_by_key(|a| a.is_ipv6());
  Ok(allowed)
}

/// Read up to and including the blank line that ends an HTTP head.
async fn read_head<R: AsyncRead + Unpin>(stream: &mut R) -> std::io::Result<Vec<u8>> {
  let mut head = Vec::new();
  let mut byte = [0u8; 1];
  while !head.ends_with(b"\r\n\r\n") {
    if head.len() > MAX_HEAD_BYTES || stream.read(&mut byte).await? == 0 {
      return Err(std::io::Error::other("incomplete HTTP head"));
    }
    head.push(byte[0]);
  }
  Ok(head)
}

async fn connect_upstream(proxy: &Intercept) -> std::io::Result<TcpStream> {
  let authority = proxy
    .uri()
    .authority()
    .ok_or_else(|| std::io::Error::other("the proxy URL has no host"))?;
  let host = authority
    .host()
    .trim_start_matches('[')
    .trim_end_matches(']');
  // The proxy is the operator's own setting, so its address is not checked.
  TcpStream::connect((host, authority.port_u16().unwrap_or(80))).await
}

fn proxy_auth_line(proxy: &Intercept) -> Vec<u8> {
  let mut line = Vec::new();
  if let Some(credentials) = proxy.basic_auth() {
    line.extend_from_slice(b"Proxy-Authorization: ");
    line.extend_from_slice(credentials.as_bytes());
    line.extend_from_slice(b"\r\n");
  }
  line
}

fn is_success(head: &[u8]) -> bool {
  matches!(head.split(|&b| b == b' ').nth(1), Some([b'2', _, _]))
}

/// CONNECT to `target` through the upstream proxy. Returns the open tunnel,
/// or the proxy's response head when it refused.
async fn tunnel(
  proxy: &Intercept,
  target: SocketAddr,
) -> std::io::Result<Result<TcpStream, Vec<u8>>> {
  let mut stream = connect_upstream(proxy).await?;
  let mut request = format!("CONNECT {target} HTTP/1.1\r\nHost: {target}\r\n").into_bytes();
  request.extend_from_slice(&proxy_auth_line(proxy));
  request.extend_from_slice(b"\r\n");
  stream.write_all(&request).await?;
  // One byte at a time, so no byte past the head is taken from the tunnel.
  let head = read_head(&mut stream).await?;
  Ok(if is_success(&head) {
    Ok(stream)
  } else {
    Err(head)
  })
}

async fn serve(client: TcpStream, shared: &Shared) -> std::io::Result<()> {
  let mut client = BufReader::new(client);
  let head = tokio::time::timeout(HANDSHAKE_TIMEOUT, read_head(&mut client))
    .await
    .map_err(|_| std::io::Error::other("timed out"))??;
  let text = String::from_utf8_lossy(&head).into_owned();
  let mut lines = text.split("\r\n");
  let mut request_line = lines.next().unwrap_or("").split(' ');
  let (Some(method), Some(target), Some(version)) = (
    request_line.next(),
    request_line.next(),
    request_line.next(),
  ) else {
    return Ok(());
  };

  if method.eq_ignore_ascii_case("CONNECT") {
    let Ok(url) = Url::parse(&format!("https://{target}/")) else {
      return Ok(());
    };
    // A refusal closes the connection; the fetcher asks `explain` why.
    let Ok(addrs) = vet(&url, shared).await else {
      return Ok(());
    };
    let Some(proxy) = intercept(shared, &url) else {
      return Ok(());
    };
    let mut refusal = b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n".to_vec();
    for addr in addrs {
      match tokio::time::timeout(HANDSHAKE_TIMEOUT, tunnel(&proxy, addr)).await {
        Ok(Ok(Ok(mut upstream))) => {
          client
            .write_all(b"HTTP/1.1 200 Connection established\r\n\r\n")
            .await?;
          let _ = tokio::io::copy_bidirectional(&mut client, &mut upstream).await;
          return Ok(());
        }
        Ok(Ok(Err(head))) => refusal = head,
        _ => {}
      }
    }
    return client.write_all(&refusal).await;
  }

  // A forwarded plain-HTTP request: `GET http://host/path HTTP/1.1`.
  let Ok(url) = Url::parse(target) else {
    return Ok(());
  };
  if url.scheme() != "http" {
    return Ok(());
  }
  let Ok(addrs) = vet(&url, shared).await else {
    return Ok(());
  };
  let Some(proxy) = intercept(shared, &url) else {
    return Ok(());
  };
  let after_scheme = &target["http://".len().min(target.len())..];
  let path = &after_scheme[after_scheme.find(['/', '?']).unwrap_or(after_scheme.len())..];
  let path = if path.is_empty() { "/" } else { path };

  let mut request = format!("{method} http://{}{path} {version}\r\n", addrs[0]).into_bytes();
  for line in lines.take_while(|l| !l.is_empty()) {
    let name = line.split(':').next().unwrap_or("").trim();
    if ["connection", "proxy-connection", "proxy-authorization"]
      .iter()
      .any(|h| name.eq_ignore_ascii_case(h))
    {
      continue;
    }
    request.extend_from_slice(line.as_bytes());
    request.extend_from_slice(b"\r\n");
  }
  request.extend_from_slice(&proxy_auth_line(&proxy));
  // One request per upstream connection: a second request on this one would
  // reach the proxy with a name that was never checked.
  request.extend_from_slice(b"Connection: close\r\n\r\n");

  let mut upstream = tokio::time::timeout(HANDSHAKE_TIMEOUT, connect_upstream(&proxy))
    .await
    .map_err(|_| std::io::Error::other("timed out"))??;
  upstream.write_all(&request).await?;
  let (mut from_upstream, _) = upstream.split();
  let (mut from_client, mut to_client) = tokio::io::split(client);
  tokio::select! {
    _ = tokio::io::copy(&mut from_upstream, &mut to_client) => {}
    _ = until_closed(&mut from_client) => {}
  }
  Ok(())
}

/// The upstream proxy for `url`, when it is one the relay can use.
fn intercept(shared: &Shared, url: &Url) -> Option<Intercept> {
  let uri: http::Uri = url.as_str().parse().ok()?;
  shared
    .proxies
    .intercept(&uri)
    .filter(|p| p.uri().scheme_str() == Some("http"))
}

/// Wait for the client to close, dropping anything else it sends: only the
/// one request already checked goes upstream.
async fn until_closed<R: AsyncRead + Unpin>(reader: &mut R) {
  let mut sink = [0u8; 4096];
  while let Ok(n) = reader.read(&mut sink).await {
    if n == 0 {
      break;
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::fetch::{FetchOptions, Fetcher};

  /// Names that resolve without DNS: two blocked addresses and one public.
  fn fake_lookup(host: String, port: u16) -> BoxFuture<'static, std::io::Result<Vec<SocketAddr>>> {
    Box::pin(async move {
      let ip: IpAddr = match host.as_str() {
        "loopback.test" => "127.0.0.1".parse().unwrap(),
        "metadata.test" => "169.254.169.254".parse().unwrap(),
        "public.test" => "93.184.216.34".parse().unwrap(),
        _ => return Err(std::io::Error::other("unknown name")),
      };
      Ok(vec![SocketAddr::new(ip, port)])
    })
  }

  /// A fake HTTP proxy that reports the head of each request it gets. It
  /// answers a CONNECT with 200 and then echoes, and a forwarded request with
  /// a short page.
  async fn upstream_proxy() -> (u16, tokio::sync::mpsc::UnboundedReceiver<String>) {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let (heads, received) = tokio::sync::mpsc::unbounded_channel();
    tokio::spawn(async move {
      while let Ok((mut s, _)) = listener.accept().await {
        let heads = heads.clone();
        tokio::spawn(async move {
          let Ok(head) = read_head(&mut s).await else {
            return;
          };
          let head = String::from_utf8_lossy(&head).into_owned();
          let connect = head.starts_with("CONNECT ");
          let _ = heads.send(head);
          if connect {
            let _ = s
              .write_all(b"HTTP/1.1 200 Connection established\r\n\r\n")
              .await;
            let mut buf = [0u8; 5];
            if s.read_exact(&mut buf).await.is_ok() {
              let _ = s.write_all(&buf).await;
            }
          } else {
            let _ = s
              .write_all(
                b"HTTP/1.1 200 OK\r\nContent-Length: 7\r\nConnection: close\r\n\r\nproxied",
              )
              .await;
          }
        });
      }
    });
    (port, received)
  }

  fn relay(policy: NetworkPolicy, proxy_port: u16) -> Arc<Relay> {
    let proxies = Matcher::builder()
      .all(format!("http://us%40er:pass@127.0.0.1:{proxy_port}"))
      .build();
    Relay::start(policy, proxies, fake_lookup).unwrap().unwrap()
  }

  fn fetcher(policy: NetworkPolicy, relay: Arc<Relay>) -> Fetcher {
    Fetcher::with_relay(policy, None, Some(relay)).unwrap()
  }

  fn u(s: &str) -> Url {
    Url::parse(s).unwrap()
  }

  #[tokio::test]
  async fn a_public_name_is_forwarded_to_its_checked_address() {
    let (port, mut heads) = upstream_proxy().await;
    let fetcher = fetcher(
      NetworkPolicy::PublicOnly,
      relay(NetworkPolicy::PublicOnly, port),
    );
    let res = fetcher
      .fetch(&u("http://public.test/page?q=1"), &FetchOptions::default())
      .await
      .unwrap();
    assert_eq!(res.status, 200);
    assert_eq!(&res.body[..], b"proxied");

    let head = heads.recv().await.unwrap();
    assert!(
      head.starts_with("GET http://93.184.216.34:80/page?q=1 HTTP/1.1\r\n"),
      "{head}"
    );
    let lower = head.to_ascii_lowercase();
    assert!(lower.contains("\r\nhost: public.test\r\n"), "{head}");
    assert!(lower.contains("\r\nconnection: close\r\n"), "{head}");
    // "us@er:pass": the credentials are decoded the way reqwest decodes them.
    assert!(
      head.contains("Proxy-Authorization: Basic dXNAZXI6cGFzcw==\r\n"),
      "{head}"
    );
  }

  #[tokio::test]
  async fn a_connect_tunnels_to_the_checked_address() {
    let (port, mut heads) = upstream_proxy().await;
    let relay = relay(NetworkPolicy::PublicOnly, port);
    let mut stream = TcpStream::connect(relay.addr).await.unwrap();
    stream
      .write_all(b"CONNECT public.test:443 HTTP/1.1\r\nHost: public.test:443\r\n\r\n")
      .await
      .unwrap();
    let answer = read_head(&mut stream).await.unwrap();
    assert!(is_success(&answer), "{}", String::from_utf8_lossy(&answer));
    stream.write_all(b"hello").await.unwrap();
    let mut back = [0u8; 5];
    stream.read_exact(&mut back).await.unwrap();
    assert_eq!(&back, b"hello");

    let head = heads.recv().await.unwrap();
    assert!(
      head.starts_with("CONNECT 93.184.216.34:443 HTTP/1.1\r\n"),
      "{head}"
    );
  }

  #[tokio::test]
  async fn names_that_resolve_to_blocked_addresses_are_refused() {
    let (port, mut heads) = upstream_proxy().await;
    let public_only = fetcher(
      NetworkPolicy::PublicOnly,
      relay(NetworkPolicy::PublicOnly, port),
    );
    for target in [
      "http://loopback.test/",
      "https://loopback.test/",
      "http://metadata.test/latest/meta-data/",
      "https://metadata.test/",
    ] {
      let err = public_only
        .fetch(&u(target), &FetchOptions::default())
        .await
        .err();
      assert!(
        matches!(err, Some(FetchError::Blocked(_))),
        "{target}: {err:?}"
      );
    }

    // With private targets on, loopback goes through but metadata never does.
    let allow_private = fetcher(
      NetworkPolicy::AllowPrivate,
      relay(NetworkPolicy::AllowPrivate, port),
    );
    let err = allow_private
      .fetch(&u("http://metadata.test/"), &FetchOptions::default())
      .await
      .err();
    match err {
      Some(FetchError::Blocked(m)) => assert!(m.contains("never reachable"), "{m}"),
      other => panic!("metadata.test: {other:?}"),
    }
    assert!(
      heads.try_recv().is_err(),
      "a refused target reached the proxy"
    );

    let res = allow_private
      .fetch(&u("http://loopback.test/"), &FetchOptions::default())
      .await
      .unwrap();
    assert_eq!(res.status, 200);
    let head = heads.recv().await.unwrap();
    assert!(
      head.starts_with("GET http://127.0.0.1:80/ HTTP/1.1\r\n"),
      "{head}"
    );
  }

  #[tokio::test]
  async fn no_proxy_means_no_relay() {
    let none = Relay::start(
      NetworkPolicy::PublicOnly,
      Matcher::builder().build(),
      fake_lookup,
    )
    .unwrap();
    assert!(none.is_none());
  }

  #[tokio::test]
  async fn a_proxy_the_relay_cannot_use_is_an_error() {
    for proxy in ["socks5://127.0.0.1:1080", "https://127.0.0.1:3128"] {
      let proxies = Matcher::builder().all(proxy.to_string()).build();
      assert!(
        Relay::start(NetworkPolicy::PublicOnly, proxies, fake_lookup).is_err(),
        "{proxy}"
      );
    }
  }
}
