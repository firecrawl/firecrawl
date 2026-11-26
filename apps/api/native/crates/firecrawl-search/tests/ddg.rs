#![allow(
  clippy::unwrap_used,
  clippy::expect_used,
  clippy::indexing_slicing,
  clippy::panic,
  clippy::arithmetic_side_effects,
  reason = "test code: a panic is a failed test or property"
)]

use std::collections::HashSet;

use firecrawl_search::{DdgSearchResult, clean_ddg_url, parse_ddg_html};
use hegel::TestCase;
use hegel::generators as gs;

#[test]
fn parses_standard_results_uddg_and_pagination_form() {
  let html = r#"<!DOCTYPE html>
<html>
<body>
  <div class="result results_links results_links_deep web-result">
    <h2 class="result__title">
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa%2520b&amp;rut=123">
        First <b>Title</b>
      </a>
    </h2>
    <a class="result__snippet">  First snippet text.  </a>
  </div>
  <div class="result web-result">
    <a class="result__a" href="https://example.org">Direct Link</a>
    <div class="result__snippet">Direct description</div>
  </div>
  <div class="result web-result">
    <a class="result__a" href="https://example.org/">Duplicate Direct Link</a>
    <div class="result__snippet">Should be deduplicated</div>
  </div>
  <div class="result web-result">
    <a class="result__a" href="https://missing-snippet.example">No snippet</a>
  </div>
  <div class="result web-result">
    <div class="result__a" href="https://not-an-anchor.example">Div link</div>
    <div class="result__snippet">Ignored because div has no .href</div>
  </div>
  <div class="result web-result">
    <a class="result__a" href="">Empty href</a>
    <div class="result__snippet">Ignored</div>
  </div>
  <div class="nav-link">
    <form action="/html/" method="post">
      <input type="submit" class="btn btn--alt" value="Next" />
      <input type="hidden" name="q" value="rust parser" />
      <input type="hidden" name="s" value="30" />
      <input type="hidden" name="dc" value="31" />
      <input type="hidden" name="empty_val" value="" />
      <input type="hidden" name="" value="ignored_empty_name" />
      <input type="hidden" name="no_value_attr" />
      <input type="hidden" name="s" value="60" />
    </form>
  </div>
</body>
</html>"#;

  let parsed = parse_ddg_html(html, &[]);
  assert!(!parsed.anomaly_detected);
  assert_eq!(
    parsed.results,
    vec![
      DdgSearchResult {
        url: "https://example.com/a b".to_string(),
        title: "First Title".to_string(),
        description: "First snippet text.".to_string(),
      },
      DdgSearchResult {
        url: "https://example.org/".to_string(),
        title: "Direct Link".to_string(),
        description: "Direct description".to_string(),
      },
    ]
  );
  assert_eq!(
    parsed.next_page_params,
    Some(vec![
      ("q".to_string(), "rust parser".to_string()),
      ("s".to_string(), "60".to_string()),
      ("dc".to_string(), "31".to_string()),
      ("empty_val".to_string(), String::new()),
    ])
  );
}

#[test]
fn detects_anomaly_modal_even_with_results_present() {
  let html = r#"
    <div class="result web-result">
      <a class="result__a" href="https://example.com/ok">Title</a>
      <span class="result__snippet">Snippet</span>
    </div>
    <div class="anomaly-modal__modal">Please verify</div>
  "#;
  let parsed = parse_ddg_html(html, &[]);
  assert!(parsed.anomaly_detected);
  assert!(parsed.results.is_empty());
  assert!(parsed.next_page_params.is_none());
}

#[test]
fn respects_strict_descendant_semantics_and_seen_urls() {
  let html = r#"
    <a class="result web-result result__a" href="https://self.example">
      Self
      <span class="result__snippet">Should not match self as .result__a</span>
    </a>
    <div class="result web-result">
      <a class="result__a" href="https://seen.example/page">Seen</a>
      <span class="result__snippet">Already seen</span>
    </div>
    <div class="result web-result">
      <a class="result__a" href="https://fresh.example/page">Fresh</a>
      <span class="result__snippet">Brand new</span>
    </div>
  "#;
  let seen = vec!["https://seen.example/page".to_string()];
  let parsed = parse_ddg_html(html, &seen);
  assert!(!parsed.anomaly_detected);
  assert_eq!(parsed.results.len(), 1);
  assert_eq!(parsed.results[0].url, "https://fresh.example/page");
  assert!(parsed.next_page_params.is_none());
}

#[test]
fn clean_ddg_url_handles_empty_missing_and_malformed_uddg() {
  assert_eq!(
    clean_ddg_url("//duckduckgo.com/l/?uddg=https%3A%2F%2Fdocs.rs%2Furl"),
    "https://docs.rs/url"
  );
  assert_eq!(
    clean_ddg_url("//duckduckgo.com/l/?uddg="),
    "//duckduckgo.com/l/?uddg="
  );
  assert_eq!(
    clean_ddg_url("https://example.com/uddg=not-query"),
    "https://example.com/uddg=not-query"
  );
  assert_eq!(
    clean_ddg_url("https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2F100%25"),
    "https://example.com/100%"
  );
}

#[hegel::test]
fn parse_ddg_html_never_panics_and_preserves_invariants(tc: TestCase) {
  let html = tc.draw(gs::text().max_size(400));
  let seen_urls = tc.draw(gs::vecs(gs::text().max_size(64)).max_size(8));
  let seen_set: HashSet<&str> = seen_urls.iter().map(String::as_str).collect();

  let parsed = parse_ddg_html(&html, &seen_urls);
  if parsed.anomaly_detected {
    assert!(parsed.results.is_empty());
    assert!(parsed.next_page_params.is_none());
  }

  let mut returned_urls = HashSet::new();
  for item in &parsed.results {
    assert!(!item.url.is_empty());
    assert!(!item.title.is_empty());
    assert!(!item.description.is_empty());
    assert!(!seen_set.contains(item.url.as_str()));
    assert!(returned_urls.insert(item.url.as_str()));
  }

  // Idempotence: feeding back all seen + newly discovered URLs yields no new results.
  let mut combined = seen_urls.clone();
  combined.extend(parsed.results.iter().map(|r| r.url.clone()));
  let second = parse_ddg_html(&html, &combined);
  assert_eq!(second.anomaly_detected, parsed.anomaly_detected);
  assert!(second.results.is_empty());
  assert_eq!(second.next_page_params, parsed.next_page_params);
}

#[hegel::test]
fn clean_ddg_url_never_panics_on_arbitrary_input(tc: TestCase) {
  let raw = tc.draw(gs::text().max_size(256));
  let _ = clean_ddg_url(&raw);
}
