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
  DEFAULT_RESEARCH_SITES, SearchCategoryEntry, SearchCategoryInput, build_search_query,
  get_category_from_url, get_default_research_sites,
};
use hegel::TestCase;
use hegel::generators as gs;

#[test]
fn query_builder_parity_fixtures() {
  assert_eq!(get_default_research_sites().len(), 14);
  assert_eq!(
    get_default_research_sites(),
    DEFAULT_RESEARCH_SITES
      .iter()
      .map(|s| (*s).to_string())
      .collect::<Vec<_>>()
  );

  let empty = build_search_query("machine learning", &[], &[], &[]);
  assert_eq!(empty.query, "machine learning");
  assert!(empty.category_entries.is_empty());

  let mixed = build_search_query(
    "AI research",
    &[
      SearchCategoryInput {
        category_type: "pdf".to_string(),
        sites: None,
      },
      SearchCategoryInput {
        category_type: "research".to_string(),
        sites: Some(vec!["arxiv.org".to_string()]),
      },
    ],
    &[
      "firecrawl.dev".to_string(),
      "docs.firecrawl.dev".to_string(),
    ],
    &["spam.example.com".to_string()],
  );
  assert_eq!(
    mixed.query,
    "AI research (site:arxiv.org) filetype:pdf site:firecrawl.dev OR site:docs.firecrawl.dev -site:spam.example.com"
  );
  assert_eq!(
    mixed.category_entries,
    vec![
      SearchCategoryEntry {
        site: "__pdf__".to_string(),
        category: "pdf".to_string(),
      },
      SearchCategoryEntry {
        site: "arxiv.org".to_string(),
        category: "research".to_string(),
      },
    ]
  );

  // Explicit empty custom sites array stays empty (does not fall back to defaults).
  let empty_sites = build_search_query(
    "test",
    &[SearchCategoryInput {
      category_type: "research".to_string(),
      sites: Some(vec![]),
    }],
    &[],
    &[],
  );
  assert_eq!(empty_sites.query, "test");
  assert!(empty_sites.category_entries.is_empty());

  // Precedence: PDF with __pdf__ beats github.com, github.com works on empty map.
  assert_eq!(
    get_category_from_url(
      "https://github.com/org/repo/paper.pdf",
      &mixed.category_entries
    ),
    Some("pdf".to_string())
  );
  assert_eq!(
    get_category_from_url("https://api.github.com/user/repo", &[]),
    Some("github".to_string())
  );
  assert_eq!(
    get_category_from_url(
      "https://export.ArXiv.org/abs/2024.12345",
      &mixed.category_entries
    ),
    Some("research".to_string())
  );
  assert_eq!(
    get_category_from_url("https://notarxiv.org/abs/1", &mixed.category_entries),
    None
  );
  assert_eq!(
    get_category_from_url("not-a-url", &mixed.category_entries),
    None
  );
}

#[hegel::test]
fn query_builder_never_panics_and_preserves_invariants(tc: TestCase) {
  let base_query = tc.draw(gs::text().max_size(80));
  let include_domains = tc.draw(gs::vecs(gs::text().max_size(32)).max_size(4));
  let exclude_domains = tc.draw(gs::vecs(gs::text().max_size(32)).max_size(4));
  let cat_count = tc.draw(gs::integers::<usize>().min_value(0).max_value(4));
  let mut categories = Vec::with_capacity(cat_count);
  for _ in 0..cat_count {
    let category_type = tc
      .draw(gs::sampled_from(
        &["research", "pdf", "developer", "gov", "other"][..],
      ))
      .to_string();
    let sites = tc.draw(gs::optional(gs::vecs(gs::text().max_size(24)).max_size(3)));
    categories.push(SearchCategoryInput {
      category_type,
      sites,
    });
  }

  let built = build_search_query(&base_query, &categories, &include_domains, &exclude_domains);
  assert!(built.query.starts_with(&base_query));

  let mut unique_sites = HashSet::new();
  for entry in &built.category_entries {
    assert!(unique_sites.insert(entry.site.as_str()));
  }

  let arbitrary_url = tc.draw(gs::text().max_size(120));
  let _ = get_category_from_url(&arbitrary_url, &built.category_entries);
}

#[hegel::test]
fn custom_research_domain_roundtrips_through_get_category(tc: TestCase) {
  let domain = tc.draw(gs::from_regex("[a-z]{3,10}\\.(org|edu)"));
  let built = build_search_query(
    "query",
    &[SearchCategoryInput {
      category_type: "research".to_string(),
      sites: Some(vec![domain.clone()]),
    }],
    &[],
    &[],
  );
  let url = format!("https://sub.{domain}/paper/123");
  assert_eq!(
    get_category_from_url(&url, &built.category_entries),
    Some("research".to_string())
  );
}
