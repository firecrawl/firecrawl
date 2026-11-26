#![allow(
  clippy::unwrap_used,
  clippy::expect_used,
  clippy::indexing_slicing,
  clippy::panic,
  clippy::arithmetic_side_effects,
  reason = "test code: a panic is a failed test or property"
)]

use std::collections::HashSet;

use firecrawl_search::{
  QueryOperators, matches_domains, matches_query_operators, parse_query_operators,
  plan_operator_query, site_hostnames, uses_search_syntax,
};
use hegel::TestCase;
use hegel::generators as gs;

#[test]
fn parse_and_plan_parity_fixtures() {
  assert_eq!(
    parse_query_operators(
      r#""Acme" intitle:"Acme Corp" inurl:earnings -inurl:video site:news.example -site:jobs.news.example"#
    ),
    QueryOperators {
      sites: vec!["news.example".to_string()],
      excluded_sites: vec!["jobs.news.example".to_string()],
      inurl: vec!["earnings".to_string()],
      intitle: vec!["acme corp".to_string()],
      excluded_inurl: vec!["video".to_string()],
      excluded_intitle: vec![],
    }
  );

  let ops = parse_query_operators("(site:a.com OR site:https://b.com/docs/) allintitle:foo");
  assert_eq!(ops.sites, vec!["a.com", "b.com/docs"]);
  assert!(ops.intitle.is_empty());

  let quoted_plan = plan_operator_query(r#""Acme inurl:earnings" site:news.example"#);
  assert!(quoted_plan.operators.inurl.is_empty());
  assert!(!quoted_plan.relaxed);
  assert_eq!(
    quoted_plan.query,
    r#""Acme inurl:earnings" site:news.example"#
  );

  for unsupported in [
    "(site:news.example OR intitle:Acme)",
    "Acme site:news.example OR earnings",
  ] {
    let plan = plan_operator_query(unsupported);
    assert_eq!(plan.query, unsupported);
    assert!(!plan.relaxed);
    assert!(plan.operators.sites.is_empty());
    assert!(matches_query_operators(
      Some("https://other.example/"),
      None,
      &plan
    ));
  }

  let closing_paren = plan_operator_query("site:news.example (Acme -inurl:video)");
  assert_eq!(closing_paren.query, "site:news.example (Acme )");

  let idn_plan = plan_operator_query("Acme site:bücher.example");
  assert_eq!(idn_plan.operators.sites, vec!["xn--bcher-kva.example"]);
  assert!(matches_query_operators(
    Some("https://www.bücher.example/a"),
    None,
    &idn_plan
  ));

  let relaxed = plan_operator_query(r#""Acme" intitle:Acme -intitle:Stadium site:news.example"#);
  assert!(relaxed.relaxed);
  assert_eq!(relaxed.query, r#""Acme" Acme site:news.example"#);
  assert!(matches_query_operators(
    Some("https://www.news.example/a"),
    Some("Acme results"),
    &relaxed
  ));
  assert!(!matches_query_operators(
    Some("https://www.news.example/b"),
    Some("Acme Stadium opens"),
    &relaxed
  ));

  assert_eq!(
    site_hostnames(&[
      "a.com/blog".to_string(),
      "a.com".to_string(),
      "b.com".to_string()
    ]),
    vec!["a.com", "b.com"]
  );
}

#[test]
fn decode_uri_preserves_reserved_escapes_and_handles_malformed() {
  let plan = plan_operator_query("site:example.com inurl:café");
  assert!(matches_query_operators(
    Some("https://example.com/menu/caf%C3%A9"),
    None,
    &plan
  ));

  // `%2F` is reserved in JS `decodeURI`, so it remains `%2f` after lowercasing.
  let slash_plan = plan_operator_query("site:example.com inurl:%2f");
  assert!(matches_query_operators(
    Some("https://example.com/a%2Fb"),
    None,
    &slash_plan
  ));

  // Malformed percent sequence falls back to raw lowercased URL.
  let malformed_plan = plan_operator_query("site:example.com inurl:%zz");
  assert!(matches_query_operators(
    Some("https://example.com/%ZZ"),
    None,
    &malformed_plan
  ));
}

#[test]
fn uses_search_syntax_and_matches_domains_edge_cases() {
  assert!(!uses_search_syntax("plain search query"));
  assert!(!uses_search_syntax("rust or python"));
  assert!(uses_search_syntax("rust OR python"));
  assert!(uses_search_syntax("rust | python"));
  assert!(uses_search_syntax(r#""exact phrase""#));
  assert!(uses_search_syntax("site:example.com"));
  assert!(uses_search_syntax("-site:example.com"));

  assert!(matches_domains(None, &[], &[]));
  assert!(!matches_domains(None, &["example.com".to_string()], &[]));
  assert!(matches_domains(
    Some("https://sub.example.com/path"),
    &["example.com".to_string()],
    &["blocked.example.com".to_string()]
  ));
  assert!(!matches_domains(
    Some("https://blocked.example.com/path"),
    &["example.com".to_string()],
    &["blocked.example.com".to_string()]
  ));
}

#[hegel::test]
fn operators_never_panic_and_hold_structural_invariants(tc: TestCase) {
  let query = tc.draw(gs::text().max_size(200));
  let url = tc.draw(gs::optional(gs::text().max_size(120)));
  let title = tc.draw(gs::optional(gs::text().max_size(120)));

  let _ = uses_search_syntax(&query);
  let ops = parse_query_operators(&query);
  for list in [
    &ops.sites,
    &ops.excluded_sites,
    &ops.inurl,
    &ops.intitle,
    &ops.excluded_inurl,
    &ops.excluded_intitle,
  ] {
    assert!(list.iter().all(|v| !v.is_empty()));
  }

  let plan = plan_operator_query(&query);
  let has_inurl_or_intitle = !plan.operators.inurl.is_empty()
    || !plan.operators.intitle.is_empty()
    || !plan.operators.excluded_inurl.is_empty()
    || !plan.operators.excluded_intitle.is_empty();
  assert_eq!(
    plan.relaxed,
    !plan.operators.sites.is_empty() && has_inurl_or_intitle
  );

  let matched = matches_query_operators(url.as_deref(), title.as_deref(), &plan);
  if plan.operators.sites.is_empty() && plan.operators.excluded_sites.is_empty() && !plan.relaxed {
    assert!(matched);
  }
}

#[hegel::test]
fn site_hostnames_is_unique_clean_and_idempotent(tc: TestCase) {
  let sites = tc.draw(gs::vecs(gs::text().max_size(40)).max_size(12));
  let hosts = site_hostnames(&sites);
  let mut seen = HashSet::new();
  for host in &hosts {
    assert!(!host.is_empty());
    assert!(!host.contains('/'));
    assert!(seen.insert(host.as_str()));
  }
  assert_eq!(site_hostnames(&hosts), hosts);
}

#[hegel::test]
fn matches_domains_exclusion_dominates_inclusion(tc: TestCase) {
  let domain = tc.draw(gs::from_regex("[a-z]{2,8}\\.[a-z]{2,4}"));
  let url = format!("https://sub.{domain}/page");
  assert!(matches_domains(Some(&url), &[], &[]));
  assert!(matches_domains(
    Some(&url),
    std::slice::from_ref(&domain),
    &[]
  ));
  assert!(!matches_domains(
    Some(&url),
    std::slice::from_ref(&domain),
    std::slice::from_ref(&domain)
  ));
}
