//! A loopback SOCKS5 proxy that the local Chrome is forced through.
//!
//! The plain fetcher resolves and checks every address itself. A browser does
//! its own networking, so checking only the URL we navigate to would miss
//! redirects, subresources, scripts' own requests and WebSockets. Routing
//! Chrome through this proxy puts every connection it makes through the same
//! network policy, applied to the address that is actually dialled.
//!
//! When `HTTPS_PROXY`, `HTTP_PROXY` or `ALL_PROXY` is set, the plain fetcher
//! leaves through that proxy. The guard picks a proxy with the same rules,
//! `NO_PROXY` included, and reaches each allowed address through it with an
//! HTTP CONNECT, so a rendered page leaves from the same place. Those rules
//! depend on the URL's scheme, which SOCKS does not carry, so the guard
//! listens twice: Chrome sends plain HTTP to one listener and everything else
//! to the other.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use hyper_util::client::proxy::matcher::{Intercept, Matcher};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use url::Url;

use crate::guard::{self, NetworkPolicy};

const REPLY_OK: u8 = 0;
const REPLY_FAILURE: u8 = 1;
const REPLY_NOT_ALLOWED: u8 = 2;
const REPLY_HOST_UNREACHABLE: u8 = 4;
const REPLY_COMMAND_NOT_SUPPORTED: u8 = 7;
const REPLY_ADDRESS_NOT_SUPPORTED: u8 = 8;

pub struct GuardProxy {
  /// Where Chrome sends `http://` URLs.
  http: SocketAddr,
  /// Where Chrome sends every other URL: `https://` and WebSockets.
  https: SocketAddr,
  tasks: [tokio::task::JoinHandle<()>; 2],
}

impl GuardProxy {
  /// Listen on free loopback ports and start serving.
  pub async fn start(policy: NetworkPolicy) -> std::io::Result<Self> {
    Self::listen(policy, proxy_rules()?).await
  }

  /// `proxies` decides which connections go through an upstream proxy.
  async fn listen(policy: NetworkPolicy, proxies: Matcher) -> std::io::Result<Self> {
    let http = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await?;
    let https = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await?;
    let (http_addr, https_addr) = (http.local_addr()?, https.local_addr()?);
    let proxies = Arc::new(proxies);
    Ok(Self {
      http: http_addr,
      https: https_addr,
      tasks: [
        accept_loop(http, "http", policy, proxies.clone()),
        accept_loop(https, "https", policy, proxies),
      ],
    })
  }

  /// The Chrome switches that send every connection through this proxy:
  /// loopback included, no QUIC or other UDP path around it, and no DNS
  /// lookups of its own. `socks=` is the fallback for every scheme other
  /// than `http`, so no URL is left to go direct.
  pub fn chrome_args(&self) -> Vec<String> {
    vec![
      format!(
        "proxy-server=http=socks5://{};socks=socks5://{}",
        self.http, self.https
      ),
      "proxy-bypass-list=<-loopback>".to_string(),
      "disable-quic".to_string(),
      "force-webrtc-ip-handling-policy=disable_non_proxied_udp".to_string(),
      format!(
        "host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE {}",
        self.https.ip()
      ),
    ]
  }
}

impl Drop for GuardProxy {
  fn drop(&mut self) {
    for task in &self.tasks {
      task.abort();
    }
  }
}

/// Serve the connections Chrome sends to `listener`, all for `scheme` URLs.
fn accept_loop(
  listener: TcpListener,
  scheme: &'static str,
  policy: NetworkPolicy,
  proxies: Arc<Matcher>,
) -> tokio::task::JoinHandle<()> {
  tokio::spawn(async move {
    loop {
      // A failed accept (too many open files, say) is not a reason to
      // stop: Chrome would lose its only way out for the rest of the run.
      let Ok((client, _)) = listener.accept().await else {
        tokio::time::sleep(Duration::from_millis(50)).await;
        continue;
      };
      let proxies = proxies.clone();
      tokio::spawn(async move {
        let _ = serve(client, scheme, policy, &proxies).await;
      });
    }
  })
}

/// The fetcher's proxy rules, read from the environment. They skip a value
/// they cannot read as if it were unset, which would send Chrome out from the
/// address the proxy is there to hide, so such a value stops the guard.
fn proxy_rules() -> std::io::Result<Matcher> {
  for names in [
    ["HTTPS_PROXY", "https_proxy"],
    ["HTTP_PROXY", "http_proxy"],
    ["ALL_PROXY", "all_proxy"],
  ] {
    // The first one set is the one the rules read.
    let Some((name, value)) = names
      .into_iter()
      .find_map(|name| std::env::var(name).ok().map(|value| (name, value)))
    else {
      continue;
    };
    if !is_readable_proxy(&value) {
      return Err(std::io::Error::other(format!("{name} is not a proxy URL")));
    }
  }
  Ok(Matcher::from_env())
}

fn is_readable_proxy(value: &str) -> bool {
  let any = http::Uri::from_static("http://example.com/");
  value.is_empty()
    || Matcher::builder()
      .all(value)
      .build()
      .intercept(&any)
      .is_some()
}

async fn reply(client: &mut TcpStream, code: u8) -> std::io::Result<()> {
  client.write_all(&[5, code, 0, 1, 0, 0, 0, 0, 0, 0]).await
}

/// Why a target is refused: the SOCKS reply code and, when the network
/// policy is the cause, the guard's own explanation.
struct Refused {
  code: u8,
  reason: Option<String>,
}

impl Refused {
  fn policy(reason: String) -> Self {
    Self {
      code: REPLY_NOT_ALLOWED,
      reason: Some(reason),
    }
  }
}

/// The addresses a SOCKS request may connect to, or why it is refused.
async fn allowed_targets(
  host: Target,
  port: u16,
  policy: NetworkPolicy,
) -> Result<Vec<SocketAddr>, Refused> {
  match host {
    Target::Ip(ip) => {
      guard::check_ip(ip, policy).map_err(|e| Refused::policy(e.0))?;
      Ok(vec![SocketAddr::new(ip, port)])
    }
    Target::Name(name) => {
      // Names the guard treats as local ("localhost", "*.internal") are
      // refused before any lookup, the same as for a URL.
      let as_url = Url::parse(&format!("http://{name}:{port}/")).map_err(|_| {
        Refused::policy(format!("'{name}' is not a host Firecrawl Local may reach"))
      })?;
      guard::check_url(&as_url, policy).map_err(|e| Refused::policy(e.0))?;
      let resolved: Vec<SocketAddr> = tokio::net::lookup_host((name.as_str(), port))
        .await
        .map_err(|_| Refused {
          code: REPLY_HOST_UNREACHABLE,
          reason: None,
        })?
        .collect();
      // The reason names the kind of address, never the address itself:
      // what an internal name resolves to is not the caller's to learn.
      let mut never_reachable = false;
      let mut allowed = Vec::new();
      let any = !resolved.is_empty();
      for addr in resolved {
        match guard::check_ip(addr.ip(), policy) {
          Ok(()) => allowed.push(addr),
          Err(_) => never_reachable |= guard::ip_always_blocked(addr.ip()),
        }
      }
      if allowed.is_empty() {
        return Err(Refused::policy(name_refusal(&name, any, never_reachable)));
      }
      Ok(allowed)
    }
  }
}

/// The reason a hostname is refused. It names the kind of address the name
/// resolved to and never the address.
fn name_refusal(name: &str, resolved_any: bool, never_reachable: bool) -> String {
  if !resolved_any {
    format!("'{name}' does not resolve to any address")
  } else if never_reachable {
    format!("'{name}' resolves to a link-local or metadata address, which is never reachable")
  } else {
    format!("'{name}' resolves to a private address; private targets are off")
  }
}

enum Target {
  Ip(IpAddr),
  Name(String),
}

/// Why the proxy would refuse a URL's host, if the network policy is the
/// cause. Chrome reports a refusal only as a failed proxy connection, so the
/// browser asks here to tell "this target is off limits" from an ordinary
/// connection failure.
pub async fn refusal_reason(url: &Url, policy: NetworkPolicy) -> Option<String> {
  let host = url.host_str()?;
  let bare = host.trim_start_matches('[').trim_end_matches(']');
  let target = match bare.parse::<IpAddr>() {
    Ok(ip) => Target::Ip(ip),
    Err(_) => Target::Name(bare.to_string()),
  };
  allowed_targets(target, url.port_or_known_default().unwrap_or(80), policy)
    .await
    .err()
    .and_then(|refused| refused.reason)
}

/// The URL the fetcher's proxy rules are matched against for a connection.
fn destination(scheme: &str, host: &Target, port: u16) -> Option<http::Uri> {
  let host = match host {
    Target::Ip(IpAddr::V6(ip)) => format!("[{ip}]"),
    Target::Ip(ip) => ip.to_string(),
    Target::Name(name) => name.clone(),
  };
  format!("{scheme}://{host}:{port}/").parse().ok()
}

async fn dial(target: SocketAddr, proxy: Option<&Intercept>) -> std::io::Result<TcpStream> {
  match proxy {
    Some(proxy) => tunnel(proxy, target).await,
    None => TcpStream::connect(target).await,
  }
}

/// Open an HTTP CONNECT tunnel to `target` through the upstream proxy. The
/// tunnel is asked for the address the guard checked, not the name, so the
/// proxy cannot resolve it to somewhere the policy refuses.
async fn tunnel(proxy: &Intercept, target: SocketAddr) -> std::io::Result<TcpStream> {
  // Going direct when the proxy cannot carry the tunnel would leave from the
  // address the proxy is there to hide.
  let uri = proxy.uri();
  let (Some("http"), Some(authority)) = (uri.scheme_str(), uri.authority()) else {
    return Err(std::io::Error::other(
      "Chrome can only use an http:// proxy",
    ));
  };
  let host = authority
    .host()
    .trim_start_matches('[')
    .trim_end_matches(']');
  let mut stream = TcpStream::connect((host, authority.port_u16().unwrap_or(80))).await?;

  let mut request = format!("CONNECT {target} HTTP/1.1\r\nHost: {target}\r\n").into_bytes();
  if let Some(credentials) = proxy.basic_auth() {
    request.extend_from_slice(b"Proxy-Authorization: ");
    request.extend_from_slice(credentials.as_bytes());
    request.extend_from_slice(b"\r\n");
  }
  request.extend_from_slice(b"\r\n");
  stream.write_all(&request).await?;

  // One byte at a time, so no byte past the response head is taken from the
  // tunnel.
  let mut head = Vec::new();
  let mut byte = [0u8; 1];
  while !head.ends_with(b"\r\n\r\n") {
    if head.len() > 8192 || stream.read(&mut byte).await? == 0 {
      return Err(std::io::Error::other(
        "the proxy did not answer the CONNECT",
      ));
    }
    head.push(byte[0]);
  }
  match head.split(|&b| b == b' ').nth(1) {
    Some([b'2', _, _]) => Ok(stream),
    _ => Err(std::io::Error::other("the proxy refused the CONNECT")),
  }
}

async fn serve(
  mut client: TcpStream,
  scheme: &str,
  policy: NetworkPolicy,
  proxies: &Matcher,
) -> std::io::Result<()> {
  // Greeting: version, then the auth methods the client offers. No auth is
  // needed on a loopback listener only this process's Chrome is told about.
  let mut head = [0u8; 2];
  client.read_exact(&mut head).await?;
  if head[0] != 5 {
    return Ok(());
  }
  let mut methods = vec![0u8; head[1] as usize];
  client.read_exact(&mut methods).await?;
  client.write_all(&[5, 0]).await?;

  // Request: version, command, reserved, address type.
  let mut request = [0u8; 4];
  client.read_exact(&mut request).await?;
  if request[0] != 5 || request[1] != 1 {
    return reply(&mut client, REPLY_COMMAND_NOT_SUPPORTED).await;
  }
  let host = match request[3] {
    1 => {
      let mut raw = [0u8; 4];
      client.read_exact(&mut raw).await?;
      Target::Ip(IpAddr::V4(Ipv4Addr::from(raw)))
    }
    4 => {
      let mut raw = [0u8; 16];
      client.read_exact(&mut raw).await?;
      Target::Ip(IpAddr::V6(Ipv6Addr::from(raw)))
    }
    3 => {
      let mut len = [0u8; 1];
      client.read_exact(&mut len).await?;
      let mut raw = vec![0u8; len[0] as usize];
      client.read_exact(&mut raw).await?;
      let name = String::from_utf8_lossy(&raw).to_string();
      // Chrome sends IP literals as names when a page uses one.
      match name
        .trim_start_matches('[')
        .trim_end_matches(']')
        .parse::<IpAddr>()
      {
        Ok(ip) => Target::Ip(ip),
        Err(_) => Target::Name(name),
      }
    }
    _ => return reply(&mut client, REPLY_ADDRESS_NOT_SUPPORTED).await,
  };
  let mut port = [0u8; 2];
  client.read_exact(&mut port).await?;
  let port = u16::from_be_bytes(port);

  let proxy = destination(scheme, &host, port).and_then(|uri| proxies.intercept(&uri));
  let targets = match allowed_targets(host, port, policy).await {
    Ok(t) => t,
    Err(refused) => return reply(&mut client, refused.code).await,
  };
  let mut upstream = None;
  for target in targets {
    if let Ok(Ok(stream)) =
      tokio::time::timeout(Duration::from_secs(15), dial(target, proxy.as_ref())).await
    {
      upstream = Some(stream);
      break;
    }
  }
  let Some(mut upstream) = upstream else {
    return reply(&mut client, REPLY_FAILURE).await;
  };
  reply(&mut client, REPLY_OK).await?;
  let _ = tokio::io::copy_bidirectional(&mut client, &mut upstream).await;
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;

  /// Speak just enough SOCKS5 to ask the proxy for one connection, and
  /// return its reply code and the stream.
  async fn ask(proxy: SocketAddr, address: &[u8], port: u16) -> (u8, TcpStream) {
    let mut stream = TcpStream::connect(proxy).await.unwrap();
    stream.write_all(&[5, 1, 0]).await.unwrap();
    let mut chosen = [0u8; 2];
    stream.read_exact(&mut chosen).await.unwrap();
    assert_eq!(chosen, [5, 0]);
    let mut request = vec![5, 1, 0];
    request.extend_from_slice(address);
    request.extend_from_slice(&port.to_be_bytes());
    stream.write_all(&request).await.unwrap();
    let mut answer = [0u8; 10];
    stream.read_exact(&mut answer).await.unwrap();
    (answer[1], stream)
  }

  fn name(host: &str) -> Vec<u8> {
    let mut v = vec![3, host.len() as u8];
    v.extend_from_slice(host.as_bytes());
    v
  }

  async fn echo_server() -> u16 {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
      while let Ok((mut s, _)) = listener.accept().await {
        tokio::spawn(async move {
          let mut buf = [0u8; 5];
          if s.read_exact(&mut buf).await.is_ok() {
            let _ = s.write_all(&buf).await;
          }
        });
      }
    });
    port
  }

  /// A plain HTTP proxy that reports the head of each CONNECT it accepts,
  /// then echoes what comes through the tunnel.
  async fn upstream_proxy() -> (u16, tokio::sync::mpsc::UnboundedReceiver<String>) {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let (heads, received) = tokio::sync::mpsc::unbounded_channel();
    tokio::spawn(async move {
      while let Ok((mut s, _)) = listener.accept().await {
        let heads = heads.clone();
        tokio::spawn(async move {
          let mut head = Vec::new();
          let mut byte = [0u8; 1];
          while !head.ends_with(b"\r\n\r\n") {
            if s.read(&mut byte).await.unwrap_or(0) == 0 {
              return;
            }
            head.push(byte[0]);
          }
          let _ = heads.send(String::from_utf8_lossy(&head).into_owned());
          let _ = s
            .write_all(b"HTTP/1.1 200 Connection established\r\n\r\n")
            .await;
          let mut buf = [0u8; 5];
          if s.read_exact(&mut buf).await.is_ok() {
            let _ = s.write_all(&buf).await;
          }
        });
      }
    });
    (port, received)
  }

  #[tokio::test]
  async fn allowed_connections_go_through_the_upstream_proxy() {
    let (port, mut heads) = upstream_proxy().await;
    let proxies = Matcher::builder()
      .all(format!("http://us%40er:pass@127.0.0.1:{port}"))
      .build();
    let proxy = GuardProxy::listen(NetworkPolicy::AllowPrivate, proxies)
      .await
      .unwrap();

    let (code, mut stream) = ask(proxy.https, &[1, 127, 0, 0, 1], 443).await;
    assert_eq!(code, REPLY_OK);
    stream.write_all(b"hello").await.unwrap();
    let mut back = [0u8; 5];
    stream.read_exact(&mut back).await.unwrap();
    assert_eq!(&back, b"hello");

    let head = heads.recv().await.unwrap();
    assert!(
      head.starts_with("CONNECT 127.0.0.1:443 HTTP/1.1\r\n"),
      "{head}"
    );
    // "us@er:pass": the credentials are decoded as the fetcher decodes them.
    assert!(
      head.contains("Proxy-Authorization: Basic dXNAZXI6cGFzcw==\r\n"),
      "{head}"
    );
  }

  #[tokio::test]
  async fn refused_targets_never_reach_the_upstream_proxy() {
    let (port, mut heads) = upstream_proxy().await;
    let proxies = Matcher::builder()
      .all(format!("http://127.0.0.1:{port}"))
      .build();
    let proxy = GuardProxy::listen(NetworkPolicy::PublicOnly, proxies)
      .await
      .unwrap();
    for address in [
      vec![1, 127, 0, 0, 1],
      vec![1, 169, 254, 169, 254],
      name("localhost"),
    ] {
      let (code, _) = ask(proxy.https, &address, 443).await;
      assert_eq!(code, REPLY_NOT_ALLOWED, "{address:?} should be refused");
    }
    assert!(heads.try_recv().is_err());
  }

  #[tokio::test]
  async fn no_proxy_targets_are_dialled_directly() {
    let echo = echo_server().await;
    let (port, mut heads) = upstream_proxy().await;
    let proxies = Matcher::builder()
      .all(format!("http://127.0.0.1:{port}"))
      .no("127.0.0.1")
      .build();
    let proxy = GuardProxy::listen(NetworkPolicy::AllowPrivate, proxies)
      .await
      .unwrap();

    let (code, mut stream) = ask(proxy.https, &[1, 127, 0, 0, 1], echo).await;
    assert_eq!(code, REPLY_OK);
    stream.write_all(b"hello").await.unwrap();
    let mut back = [0u8; 5];
    stream.read_exact(&mut back).await.unwrap();
    assert_eq!(&back, b"hello");
    assert!(heads.try_recv().is_err());
  }

  #[tokio::test]
  async fn the_scheme_comes_from_the_listener_not_the_port() {
    let echo = echo_server().await;
    let (port, mut heads) = upstream_proxy().await;
    let proxies = Matcher::builder()
      .http(format!("http://127.0.0.1:{port}"))
      .build();
    let proxy = GuardProxy::listen(NetworkPolicy::AllowPrivate, proxies)
      .await
      .unwrap();

    let (code, _) = ask(proxy.http, &[1, 127, 0, 0, 1], 8443).await;
    assert_eq!(code, REPLY_OK);
    let head = heads.recv().await.unwrap();
    assert!(
      head.starts_with("CONNECT 127.0.0.1:8443 HTTP/1.1\r\n"),
      "{head}"
    );

    let (code, mut stream) = ask(proxy.https, &[1, 127, 0, 0, 1], echo).await;
    assert_eq!(code, REPLY_OK);
    stream.write_all(b"hello").await.unwrap();
    let mut back = [0u8; 5];
    stream.read_exact(&mut back).await.unwrap();
    assert_eq!(&back, b"hello");
    assert!(heads.try_recv().is_err());
  }

  #[test]
  fn a_proxy_value_the_rules_would_skip_is_caught() {
    for readable in [
      "",
      "http://127.0.0.1:3128",
      "127.0.0.1:3128",
      "socks5://127.0.0.1:1080",
    ] {
      assert!(is_readable_proxy(readable), "{readable}");
    }
    for unreadable in ["ftp://127.0.0.1:21", "not a proxy"] {
      assert!(!is_readable_proxy(unreadable), "{unreadable}");
    }
  }

  #[tokio::test]
  async fn a_proxy_chrome_cannot_use_is_not_bypassed() {
    let echo = echo_server().await;
    let proxies = Matcher::builder().all("socks5://127.0.0.1:1080").build();
    let proxy = GuardProxy::listen(NetworkPolicy::AllowPrivate, proxies)
      .await
      .unwrap();
    let (code, _) = ask(proxy.https, &[1, 127, 0, 0, 1], echo).await;
    assert_eq!(code, REPLY_FAILURE);
  }

  #[tokio::test]
  async fn public_only_refuses_loopback_private_and_local_names() {
    let port = echo_server().await;
    let proxy = GuardProxy::start(NetworkPolicy::PublicOnly).await.unwrap();
    for address in [
      vec![1, 127, 0, 0, 1],
      vec![1, 10, 0, 0, 5],
      vec![1, 192, 168, 1, 1],
      vec![1, 169, 254, 169, 254],
      name("localhost"),
      name("127.0.0.1"),
      name("[::1]"),
      name("metadata.google.internal"),
    ] {
      let (code, _) = ask(proxy.https, &address, port).await;
      assert_eq!(code, REPLY_NOT_ALLOWED, "{address:?} should be refused");
    }
  }

  #[tokio::test]
  async fn allow_private_reaches_loopback_but_never_metadata() {
    let port = echo_server().await;
    let proxy = GuardProxy::start(NetworkPolicy::AllowPrivate)
      .await
      .unwrap();

    let (code, mut stream) = ask(proxy.https, &[1, 127, 0, 0, 1], port).await;
    assert_eq!(code, REPLY_OK);
    stream.write_all(b"hello").await.unwrap();
    let mut back = [0u8; 5];
    stream.read_exact(&mut back).await.unwrap();
    assert_eq!(&back, b"hello");

    let (code, _) = ask(proxy.https, &[1, 169, 254, 169, 254], 80).await;
    assert_eq!(code, REPLY_NOT_ALLOWED);
  }

  #[tokio::test]
  async fn refusals_are_explained() {
    let local = Url::parse("http://127.0.0.1:8080/").unwrap();
    assert!(refusal_reason(&local, NetworkPolicy::PublicOnly)
      .await
      .is_some_and(|m| m.contains("private")));
    assert!(refusal_reason(&local, NetworkPolicy::AllowPrivate)
      .await
      .is_none());
    // With private targets on, the reason is the metadata rule, not
    // "private targets are off".
    let metadata = Url::parse("http://169.254.169.254/latest/").unwrap();
    let why = refusal_reason(&metadata, NetworkPolicy::AllowPrivate)
      .await
      .unwrap();
    assert!(
      why.contains("never reachable") && !why.contains("are off"),
      "{why}"
    );
  }

  #[test]
  fn a_named_refusal_does_not_reveal_the_address() {
    let private = name_refusal("intranet.example", true, false);
    assert!(
      private.contains("private") && private.contains("intranet.example"),
      "{private}"
    );
    let metadata = name_refusal("meta.example", true, true);
    assert!(metadata.contains("never reachable"), "{metadata}");
    for message in [
      private,
      metadata,
      name_refusal("gone.example", false, false),
    ] {
      assert!(!message.chars().any(|c| c.is_ascii_digit()), "{message}");
    }
  }

  #[tokio::test]
  async fn only_connect_is_supported() {
    let proxy = GuardProxy::start(NetworkPolicy::AllowPrivate)
      .await
      .unwrap();
    let mut stream = TcpStream::connect(proxy.https).await.unwrap();
    stream.write_all(&[5, 1, 0]).await.unwrap();
    let mut chosen = [0u8; 2];
    stream.read_exact(&mut chosen).await.unwrap();
    // Command 3 is UDP associate.
    stream
      .write_all(&[5, 3, 0, 1, 127, 0, 0, 1, 0, 53])
      .await
      .unwrap();
    let mut answer = [0u8; 10];
    stream.read_exact(&mut answer).await.unwrap();
    assert_eq!(answer[1], REPLY_COMMAND_NOT_SUPPORTED);
  }
}
