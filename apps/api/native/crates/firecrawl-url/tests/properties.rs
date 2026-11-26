#![allow(
  clippy::unwrap_used,
  clippy::expect_used,
  clippy::indexing_slicing,
  clippy::panic,
  clippy::arithmetic_side_effects,
  reason = "test code: a panic is a failed property"
)]

use firecrawl_url::{
  EngineForcingMatcher, SerpEngine, detect_serp_page, domain_matches_pattern, extract_base_domain,
  extract_forcing_domain, has_reachable_host, is_base_domain, match_engine_forcing_pattern,
  parse_hostname, parse_url,
};
use hegel::TestCase;
use hegel::generators as gs;

#[hegel::test]
fn arbitrary_utf8_never_panics_and_preserves_invariants(tc: TestCase) {
  let input = tc.draw(gs::text());

  let parsed = parse_hostname(&input);
  assert_eq!(parsed.hostname.as_deref(), Some(input.as_str()));
  assert!(parsed.is_ip.is_some());
  assert!(parsed.is_special_use.is_none());

  if parsed.is_ip == Some(true) {
    assert!(parsed.domain.is_none());
    assert!(parsed.public_suffix.is_none());
    assert!(parsed.subdomain.is_none());
    assert!(parsed.domain_without_suffix.is_none());
    assert!(parsed.is_icann.is_none());
    assert!(parsed.is_private.is_none());
  } else {
    assert!(parsed.public_suffix.is_some());
    assert!(!(parsed.is_icann == Some(true) && parsed.is_private == Some(true)));
  }

  if let (Some(domain), Some(suffix)) = (&parsed.domain, &parsed.public_suffix) {
    assert!(domain.ends_with(suffix));
    assert!(parsed.subdomain.is_some());
    assert!(parsed.domain_without_suffix.is_some());
  } else {
    assert!(parsed.subdomain.is_none());
    assert!(parsed.domain_without_suffix.is_none());
  }

  let parsed_icann = parse_url(&input, false);
  let parsed_priv = parse_url(&input, true);
  assert_eq!(parsed_icann.is_ip, parsed_priv.is_ip);
  assert_ne!(parsed_icann.is_private, Some(true));

  let _ = has_reachable_host(&input);

  let base = extract_base_domain(&input);
  let is_base = is_base_domain(&input);
  if is_base {
    assert!(base.is_some());
  }

  if let Some(serp) = detect_serp_page(&input) {
    assert!(!serp.query.is_empty());
    assert!(serp.query.encode_utf16().count() <= 200);
    let _ = serp.engine.as_str();
  }

  let _ = extract_forcing_domain(&input);
  let _ = domain_matches_pattern(&input, &input);
}

#[hegel::test]
fn engine_forcing_matcher_agrees_with_stateless_helper(tc: TestCase) {
  let url = tc.draw(gs::text());
  let patterns = tc.draw(gs::vecs(gs::text()).max_size(8));

  let matcher = EngineForcingMatcher::new(&patterns);
  assert_eq!(matcher.is_empty(), patterns.is_empty());
  assert_eq!(
    matcher.match_url(&url),
    match_engine_forcing_pattern(&url, &patterns)
  );
}

#[hegel::test]
fn structured_http_urls_maintain_domain_and_serp_invariants(tc: TestCase) {
  let scheme = tc.draw(gs::sampled_from(vec!["http", "https"]));
  let sub = tc.draw(gs::sampled_from(vec![
    "", "www.", "api.", "a.b.", "search.",
  ]));
  let label = tc.draw(gs::sampled_from(vec![
    "example", "google", "bing", "yahoo", "baidu", "yandex", "ecosia", "hello",
  ]));
  let suffix = tc.draw(gs::sampled_from(vec![
    "com",
    "co.uk",
    "com.au",
    "org",
    "ru",
    "vercel.app",
    "github.io",
  ]));
  let path = tc.draw(gs::sampled_from(vec![
    "",
    "/",
    "/search",
    "/search/",
    "/s",
    "/about",
    "/search;_ylt=abc",
  ]));
  let query = tc.draw(gs::text().max_size(260));

  let host = format!("{sub}{label}.{suffix}");
  let encoded_query: String = url::form_urlencoded::Serializer::new(String::new())
    .append_pair("q", &query)
    .append_pair("p", &query)
    .append_pair("wd", &query)
    .append_pair("text", &query)
    .finish();
  let full_url = format!("{scheme}://{host}{path}?{encoded_query}");

  assert!(has_reachable_host(&full_url));

  let expected_domain = format!("{label}.{suffix}");
  assert_eq!(
    extract_base_domain(&full_url).as_deref(),
    Some(expected_domain.as_str())
  );

  let expected_is_base = (sub.is_empty() || sub == "www.") && (path.is_empty() || path == "/");
  assert_eq!(is_base_domain(&full_url), expected_is_base);

  if let Some(serp) = detect_serp_page(&full_url) {
    assert!(!serp.query.is_empty());
    assert!(serp.query.encode_utf16().count() <= 200);
    if label == "google" {
      assert_eq!(serp.engine, SerpEngine::Google);
    }
  }
}
