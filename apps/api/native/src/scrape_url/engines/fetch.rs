use std::{
  net::{IpAddr, SocketAddr},
  str::FromStr,
  sync::Arc,
};

use url::Url;
use wreq::header::{HeaderMap, HeaderName, HeaderValue};

use super::super::{error::ScrapeURLError, feature_flags::ConstFeatureFlags, meta::Meta};
use super::{Engine, EngineScrapeContent, EngineScrapeProxy, EngineScrapeResult};

pub struct FetchEngine;

fn is_ip_private(addr: IpAddr) -> bool {
  match addr {
    IpAddr::V4(v4) => {
      let o = v4.octets();
      v4.is_unspecified()
      || v4.is_loopback()
      || v4.is_private()
      || v4.is_link_local()
      || v4.is_broadcast()
      || v4.is_multicast()
      || v4.is_documentation()
      || (o[0] == 100 && (o[1] & 0xc0) == 64)    // 100.64/10  CGNAT
      || (o[0] == 192 && o[1] == 0 && o[2] == 0) // 192.0.0/24 IETF
      || (o[0] == 198 && (o[1] & 0xfe) == 18)    // 198.18/15  benchmarking
      || o[0] >= 240 // 240/4 reserved
    }
    IpAddr::V6(v6) => {
      if let Some(v4) = v6.to_ipv4_mapped() {
        return is_ip_private(IpAddr::V4(v4));
      }

      let s = v6.segments();
      v6.is_unspecified()
      || v6.is_loopback()
      || v6.is_multicast()
      || v6.is_unique_local()
      || v6.is_unicast_link_local()
      || (s[0] == 0x2001 && s[1] == 0x0db8) // 2001:db8::/32 docs
      || (s[0] == 0x2001 && s[1] == 0x0000) // 2001::/32  Teredo
      || s[0] == 0x2002                     // 2002::/16  6to4
      || (s[0] == 0x0064 && s[1] == 0xff9b) // 64:ff9b::/96 NAT64
    }
  }
}

/// Checks if a literal-IP URL is private or not
pub fn guard_url_with_ip_host(uri: &wreq::Uri) -> Result<(), ScrapeURLError> {
  let host = url::Host::parse(uri.host().ok_or(ScrapeURLError::InvalidURLError)?)
    .map_err(|_| ScrapeURLError::InvalidURLError)?;
  let ip = match host {
    url::Host::Ipv4(v4) => Some(IpAddr::V4(v4)),
    url::Host::Ipv6(v6) => Some(IpAddr::V6(v6)),
    _ => None,
  };

  if let Some(ip) = ip
    && is_ip_private(ip)
  {
    Err(ScrapeURLError::InsecureConnectionError)
  } else {
    Ok(())
  }
}

struct GuardedResolver;

impl wreq::dns::Resolve for GuardedResolver {
  fn resolve(&self, name: wreq::dns::Name) -> wreq::dns::Resolving {
    Box::pin(async move {
      let host = name.as_str().to_owned();
      let addrs: Vec<SocketAddr> = tokio::net::lookup_host((host.as_str(), 0)).await?.collect();

      if addrs.is_empty() {
        Err(Box::new(std::io::Error::new(
          std::io::ErrorKind::NotFound,
          format!("no addresses for {host}"),
        )) as _)
      } else if addrs.iter().any(|a| is_ip_private(a.ip())) {
        Err(Box::new(ScrapeURLError::InsecureConnectionError) as _)
      } else {
        Ok(Box::new(addrs.into_iter()) as wreq::dns::Addrs)
      }
    })
  }
}

fn safe_wreq_builder(skip_tls_verification: bool, cookies: bool) -> wreq::Client {
  let mut builder = wreq::Client::builder()
    .emulation(wreq_util::Emulation::Chrome137)
    .tls_cert_verification(!skip_tls_verification)
    .dns_resolver(Arc::new(GuardedResolver)) // guard against SSRF via DNS filtering
    .redirect(wreq::redirect::Policy::custom(|attempt| {
      if attempt.previous.len() >= 20 {
        attempt.error("too many redirects") // TODO: proper error
      } else if let Some(e) = guard_url_with_ip_host(&attempt.uri).err() {
        // also guard against SSRF via direct IP filtering
        attempt.error(e)
      } else {
        attempt.follow()
      }
    }));

  // TODO: proxy support

  if cookies {
    builder = builder.cookie_store(true);
  }

  builder.build().expect("failed to build client")
}

impl Engine for FetchEngine {
  const NAME: &'static str = "fetch";
  const IS_SPECIAL: bool = false;
  const FEATURES: ConstFeatureFlags = ConstFeatureFlags::EMPTY;

  async fn scrape(
    meta: &Meta,
    proxy: EngineScrapeProxy,
  ) -> Result<EngineScrapeResult, ScrapeURLError> {
    // Not sure how safe or performant it is to construct a new wreq every turn? - mogery
    let client = safe_wreq_builder(meta.options.should_skip_tls_verification(), true);

    let res = client
      .get(meta.get_url().as_str())
      .headers(HeaderMap::from_iter(meta.options.headers.iter().map(|x| {
        (
          HeaderName::from_str(x.0).unwrap(),  // TODO: error handling
          HeaderValue::from_str(x.1).unwrap(), // TODO: error handling
        )
      })))
      .send()
      .await
      .unwrap(); // TODO: error handling

    let url = Url::parse(&res.uri().to_string()).unwrap(); // TODO: error handling
    let status_code = res.status().as_u16();
    let content_type = res
      .headers()
      .get("content-type")
      .map(|x| x.to_str().unwrap().to_string())
      .unwrap_or_else(|| "application/octet-stream".to_string());
    let bytes = res.bytes().await.unwrap(); // TODO: error handling

    Ok(EngineScrapeResult {
      url,
      status_code,
      content: EngineScrapeContent::Bytes(bytes),
      content_type,
      proxy_used: proxy,
      screenshot: None,
      actions: None,
      timezone: None,
      filename: None, // TODO: get out of header maybe?
      cached_at: None,
    })
  }
}
