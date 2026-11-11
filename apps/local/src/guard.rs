//! Private-network guard.
//!
//! Every outbound request passes through here twice: once on the URL (scheme,
//! IP literals, localhost names) and once on the addresses DNS actually
//! returned, so a hostname that resolves to a private address is refused at
//! connect time. That second check is what defeats DNS rebinding.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

use url::{Host, Url};

/// What the caller is allowed to reach.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NetworkPolicy {
  /// Public internet only. The default for `serve`.
  PublicOnly,
  /// Public internet plus loopback and private ranges. Link-local and cloud
  /// metadata addresses stay blocked. Used when a person runs the CLI or MCP
  /// against their own localhost or intranet.
  AllowPrivate,
}

#[derive(Debug)]
pub struct Blocked(pub String);

impl std::fmt::Display for Blocked {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    write!(f, "{}", self.0)
  }
}

impl std::error::Error for Blocked {}

fn v4_is_metadata_or_link_local(ip: Ipv4Addr) -> bool {
  // 169.254.0.0/16 covers link-local and most cloud metadata endpoints.
  // Alibaba Cloud serves its metadata from 100.100.100.200 instead.
  ip.is_link_local() || ip == Ipv4Addr::new(100, 100, 100, 200)
}

fn v4_is_private(ip: Ipv4Addr) -> bool {
  let o = ip.octets();
  ip.is_loopback()
    || ip.is_private()
    || ip.is_unspecified()
    || ip.is_broadcast()
    || ip.is_multicast()
    || ip.is_documentation()
    // 100.64.0.0/10 carrier-grade NAT
    || (o[0] == 100 && (o[1] & 0b1100_0000) == 64)
    // 192.0.0.0/24 IETF protocol assignments
    || (o[0] == 192 && o[1] == 0 && o[2] == 0)
    // 198.18.0.0/15 benchmarking
    || (o[0] == 198 && (o[1] & 0xfe) == 18)
    // 240.0.0.0/4 reserved
    || o[0] >= 240
    || o[0] == 0
}

fn v6_embedded_v4(ip: Ipv6Addr) -> Option<Ipv4Addr> {
  if let Some(v4) = ip.to_ipv4_mapped() {
    return Some(v4);
  }
  let s = ip.segments();
  // 64:ff9b::/96 NAT64, and the deprecated ::a.b.c.d compatible form.
  if (s[0] == 0x64 && s[1] == 0xff9b && s[2..6].iter().all(|x| *x == 0))
    || (s[..6].iter().all(|x| *x == 0) && (s[6] != 0 || s[7] > 1))
  {
    return Some(Ipv4Addr::new(
      (s[6] >> 8) as u8,
      s[6] as u8,
      (s[7] >> 8) as u8,
      s[7] as u8,
    ));
  }
  None
}

fn v6_is_link_local(ip: Ipv6Addr) -> bool {
  (ip.segments()[0] & 0xffc0) == 0xfe80
}

fn v6_is_private(ip: Ipv6Addr) -> bool {
  let s = ip.segments();
  ip.is_loopback()
    || ip.is_unspecified()
    || ip.is_multicast()
    // fc00::/7 unique local
    || (s[0] & 0xfe00) == 0xfc00
    // fec0::/10 site-local (deprecated)
    || (s[0] & 0xffc0) == 0xfec0
    // 2001:db8::/32 documentation
    || (s[0] == 0x2001 && s[1] == 0x0db8)
}

/// Addresses nobody may reach through the engine, whatever the policy.
pub fn ip_always_blocked(ip: IpAddr) -> bool {
  match ip {
    IpAddr::V4(v4) => v4_is_metadata_or_link_local(v4),
    IpAddr::V6(v6) => match v6_embedded_v4(v6) {
      Some(v4) => v4_is_metadata_or_link_local(v4),
      None => v6_is_link_local(v6),
    },
  }
}

/// Addresses that are not on the public internet.
pub fn ip_is_private(ip: IpAddr) -> bool {
  match ip {
    IpAddr::V4(v4) => v4_is_private(v4) || v4_is_metadata_or_link_local(v4),
    IpAddr::V6(v6) => match v6_embedded_v4(v6) {
      Some(v4) => v4_is_private(v4) || v4_is_metadata_or_link_local(v4),
      None => v6_is_private(v6) || v6_is_link_local(v6),
    },
  }
}

pub fn check_ip(ip: IpAddr, policy: NetworkPolicy) -> Result<(), Blocked> {
  if ip_always_blocked(ip) {
    return Err(Blocked(format!(
      "{ip} is a link-local or metadata address and is never reachable"
    )));
  }
  if policy == NetworkPolicy::PublicOnly && ip_is_private(ip) {
    return Err(Blocked(format!(
      "{ip} is a private address; private targets are off"
    )));
  }
  Ok(())
}

fn hostname_is_local(host: &str) -> bool {
  let h = host.trim_end_matches('.').to_ascii_lowercase();
  h == "localhost"
    || h.ends_with(".localhost")
    || h.ends_with(".local")
    || h.ends_with(".internal")
    || h == "metadata"
    || h == "metadata.google.internal"
}

/// Check a URL before any network activity. Called on the first URL and on
/// every redirect hop.
pub fn check_url(url: &Url, policy: NetworkPolicy) -> Result<(), Blocked> {
  match url.scheme() {
    "http" | "https" => {}
    other => {
      return Err(Blocked(format!(
        "unsupported URL scheme '{other}': only http and https are fetched"
      )))
    }
  }
  if !url.username().is_empty() || url.password().is_some() {
    return Err(Blocked(
      "URLs with embedded credentials are not fetched".to_string(),
    ));
  }
  match url.host() {
    None => Err(Blocked("URL has no host".to_string())),
    Some(Host::Ipv4(ip)) => check_ip(IpAddr::V4(ip), policy),
    Some(Host::Ipv6(ip)) => check_ip(IpAddr::V6(ip), policy),
    Some(Host::Domain(name)) => {
      if policy == NetworkPolicy::PublicOnly && hostname_is_local(name) {
        return Err(Blocked(format!(
          "'{name}' is a local hostname; private targets are off"
        )));
      }
      if name.eq_ignore_ascii_case("metadata.google.internal") {
        return Err(Blocked(
          "cloud metadata endpoints are never reachable".to_string(),
        ));
      }
      Ok(())
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn alibaba_metadata_is_blocked_in_every_mode() {
    let ip: IpAddr = "100.100.100.200".parse().unwrap();
    assert!(check_ip(ip, NetworkPolicy::AllowPrivate).is_err());
    assert!(check_ip(ip, NetworkPolicy::PublicOnly).is_err());
    // The rest of the carrier-grade NAT range is only private.
    let neighbour: IpAddr = "100.100.100.201".parse().unwrap();
    assert!(check_ip(neighbour, NetworkPolicy::AllowPrivate).is_ok());
  }

  fn u(s: &str) -> Url {
    Url::parse(s).unwrap()
  }

  #[test]
  fn public_urls_pass() {
    assert!(check_url(&u("https://example.com/a"), NetworkPolicy::PublicOnly).is_ok());
    assert!(check_url(&u("http://93.184.216.34/"), NetworkPolicy::PublicOnly).is_ok());
  }

  #[test]
  fn private_literals_blocked_when_public_only() {
    for s in [
      "http://127.0.0.1/",
      "http://10.0.0.5/",
      "http://192.168.1.1/",
      "http://172.16.0.1/",
      "http://[::1]/",
      "http://[fd00::1]/",
      "http://[::ffff:127.0.0.1]/",
      "http://0.0.0.0/",
      "http://100.64.0.1/",
      "http://localhost:3000/",
      "http://foo.localhost/",
      "http://printer.local/",
    ] {
      assert!(
        check_url(&u(s), NetworkPolicy::PublicOnly).is_err(),
        "{s} should be blocked"
      );
    }
  }

  #[test]
  fn private_allowed_when_opted_in_but_metadata_never() {
    assert!(check_url(&u("http://127.0.0.1:3000/"), NetworkPolicy::AllowPrivate).is_ok());
    assert!(check_url(&u("http://localhost:3000/"), NetworkPolicy::AllowPrivate).is_ok());
    assert!(check_url(&u("http://192.168.1.10/"), NetworkPolicy::AllowPrivate).is_ok());
    for s in [
      "http://169.254.169.254/latest/meta-data/",
      "http://[fe80::1]/",
      "http://[::ffff:169.254.169.254]/",
      "http://metadata.google.internal/",
    ] {
      assert!(
        check_url(&u(s), NetworkPolicy::AllowPrivate).is_err(),
        "{s} should always be blocked"
      );
    }
  }

  #[test]
  fn schemes_and_credentials() {
    assert!(check_url(&u("file:///etc/passwd"), NetworkPolicy::AllowPrivate).is_err());
    assert!(check_url(&u("ftp://example.com/"), NetworkPolicy::PublicOnly).is_err());
    assert!(check_url(
      &u("https://user:pw@example.com/"),
      NetworkPolicy::PublicOnly
    )
    .is_err());
  }
}
