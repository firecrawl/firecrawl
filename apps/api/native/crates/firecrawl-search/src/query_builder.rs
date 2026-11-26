//! Search query builder for category and domain filters.

use serde::{Deserialize, Serialize};
use url::Url;

use crate::text::to_lowercase_cow;

const PDF_MARKER: &str = "__pdf__";

pub const DEFAULT_RESEARCH_SITES: &[&str] = &[
  "arxiv.org",
  "scholar.google.com",
  "pubmed.ncbi.nlm.nih.gov",
  "researchgate.net",
  "nature.com",
  "science.org",
  "ieee.org",
  "acm.org",
  "springer.com",
  "wiley.com",
  "sciencedirect.com",
  "plos.org",
  "biorxiv.org",
  "medrxiv.org",
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SearchCategoryInput {
  pub category_type: String,
  pub sites: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SearchCategoryEntry {
  pub site: String,
  pub category: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SearchQueryBuildResult {
  pub query: String,
  pub category_entries: Vec<SearchCategoryEntry>,
}

/// Returns the default research domains list.
pub fn get_default_research_sites() -> Vec<String> {
  DEFAULT_RESEARCH_SITES
    .iter()
    .map(|site| (*site).to_string())
    .collect()
}

fn upsert_category_entry(entries: &mut Vec<SearchCategoryEntry>, site: &str, category: &str) {
  if let Some(existing) = entries.iter_mut().find(|entry| entry.site == site) {
    existing.category = category.to_string();
  } else {
    entries.push(SearchCategoryEntry {
      site: site.to_string(),
      category: category.to_string(),
    });
  }
}

/// Builds a search query string with category and domain filters plus the
/// ordered site-to-category mapping.
pub fn build_search_query(
  base_query: &str,
  categories: &[SearchCategoryInput],
  include_domains: &[String],
  exclude_domains: &[String],
) -> SearchQueryBuildResult {
  let mut category_entries: Vec<SearchCategoryEntry> = Vec::new();
  let mut site_filters: Vec<String> = Vec::new();
  let mut has_pdf_filter = false;

  for category in categories {
    match category.category_type.as_str() {
      "research" => match category.sites.as_ref() {
        Some(custom_sites) => {
          for site in custom_sites {
            site_filters.push(format!("site:{site}"));
            upsert_category_entry(&mut category_entries, site, "research");
          }
        }
        None => {
          for site in DEFAULT_RESEARCH_SITES {
            site_filters.push(format!("site:{site}"));
            upsert_category_entry(&mut category_entries, site, "research");
          }
        }
      },
      "pdf" => {
        has_pdf_filter = true;
        upsert_category_entry(&mut category_entries, PDF_MARKER, "pdf");
      }
      _ => {}
    }
  }

  let mut query = String::from(base_query);

  if !site_filters.is_empty() {
    query.push_str(" (");
    query.push_str(&site_filters.join(" OR "));
    query.push(')');
  }

  if has_pdf_filter {
    query.push_str(" filetype:pdf");
  }

  // Bare `site:` operators without wrapping parentheses so search backends do
  // not drop the filter group.
  if !include_domains.is_empty() {
    query.push(' ');
    for (idx, domain) in include_domains.iter().enumerate() {
      if idx > 0 {
        query.push_str(" OR ");
      }
      query.push_str("site:");
      query.push_str(domain);
    }
  }

  if !exclude_domains.is_empty() {
    for domain in exclude_domains {
      query.push_str(" -site:");
      query.push_str(domain);
    }
  }

  SearchQueryBuildResult {
    query,
    category_entries,
  }
}

fn ends_with_pdf(pathname: &str) -> bool {
  pathname
    .len()
    .checked_sub(4)
    .and_then(|start| pathname.get(start..))
    .is_some_and(|tail| tail.eq_ignore_ascii_case(".pdf"))
}

/// Determines the category for a URL given an ordered site-to-category mapping.
pub fn get_category_from_url(
  url: &str,
  category_entries: &[SearchCategoryEntry],
) -> Option<String> {
  let parsed = Url::parse(url).ok()?;
  let hostname = to_lowercase_cow(parsed.host_str().unwrap_or(""));

  if ends_with_pdf(parsed.path()) && category_entries.iter().any(|e| e.site == PDF_MARKER) {
    return Some("pdf".to_string());
  }

  if hostname.as_ref() == "github.com" || hostname.ends_with(".github.com") {
    return Some("github".to_string());
  }

  for entry in category_entries {
    if entry.site == PDF_MARKER {
      continue;
    }
    let site_lower = to_lowercase_cow(&entry.site);
    if hostname.as_ref() == site_lower.as_ref()
      || hostname
        .strip_suffix(site_lower.as_ref())
        .is_some_and(|prefix| prefix.ends_with('.'))
    {
      return Some(entry.category.clone());
    }
  }

  None
}
