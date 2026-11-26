//! DuckDuckGo HTML search result and pagination parser.

use std::borrow::Cow;
use std::collections::HashSet;

use kuchikiki::{NodeRef, parse_html, traits::TendrilSink};
use serde::{Deserialize, Serialize};
use url::Url;

use crate::text::{decode_uri_component, js_trim};

const HTML_NS: &str = "http://www.w3.org/1999/xhtml";
const DDG_BASE_URL: &str = "https://duckduckgo.com";
const ABOUT_BLANK_URL: &str = "about:blank";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DdgSearchResult {
  pub url: String,
  pub title: String,
  pub description: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DdgParseResult {
  pub anomaly_detected: bool,
  pub results: Vec<DdgSearchResult>,
  pub next_page_params: Option<Vec<(String, String)>>,
}

/// Unwraps DuckDuckGo redirect URLs carrying a `uddg=` query parameter.
pub fn clean_ddg_url(href: &str) -> String {
  if !href.contains("uddg=") {
    return href.to_string();
  }
  let Ok(base) = Url::parse(DDG_BASE_URL) else {
    return href.to_string();
  };
  let Ok(parsed) = base.join(href) else {
    return href.to_string();
  };
  let Some((_, uddg)) = parsed.query_pairs().find(|(k, _)| k == "uddg") else {
    return href.to_string();
  };
  if uddg.is_empty() {
    return href.to_string();
  }
  decode_uri_component(&uddg).unwrap_or_else(|| uddg.into_owned())
}

/// Parses a DuckDuckGo HTML search page, extracting deduplicated results,
/// anomaly modal detection, and next-page form parameters.
pub fn parse_ddg_html(html: &str, seen_urls: &[String]) -> DdgParseResult {
  let document = parse_html().one(html).document_node;

  let mut base_url = Url::parse(ABOUT_BLANK_URL).ok();
  let mut has_base = false;
  let mut result_blocks: Vec<NodeRef> = Vec::new();
  let mut next_button: Option<NodeRef> = None;

  for node in document.descendants() {
    let Some(elem) = node.as_element() else {
      continue;
    };
    let attrs = elem.attributes.borrow();

    if let Some(classes) = attrs.get("class") {
      if has_class_token(classes, "anomaly-modal__modal") {
        return DdgParseResult {
          anomaly_detected: true,
          results: Vec::new(),
          next_page_params: None,
        };
      }
      if has_class_token(classes, "result") && has_class_token(classes, "web-result") {
        result_blocks.push(node.clone());
      }
    }

    let is_html = elem.name.ns.as_ref() == HTML_NS;
    let tag = elem.name.local.as_ref();

    if !has_base
      && is_html
      && tag == "base"
      && let Some(href) = attrs.get("href")
    {
      has_base = true;
      if let Some(ref current) = base_url
        && let Ok(resolved) = current.join(href)
      {
        base_url = Some(resolved);
      }
    }

    if next_button.is_none()
      && is_html
      && tag == "input"
      && attrs
        .get("type")
        .is_some_and(|v| v.eq_ignore_ascii_case("submit"))
      && attrs.get("class") == Some("btn btn--alt")
      && attrs.get("value") == Some("Next")
    {
      next_button = Some(node.clone());
    }
  }

  let results = extract_results(&result_blocks, base_url.as_ref(), seen_urls);
  let next_page_params = next_button.as_ref().and_then(extract_next_page_params);

  DdgParseResult {
    anomaly_detected: false,
    results,
    next_page_params,
  }
}

fn has_class_token(class_attr: &str, token: &str) -> bool {
  class_attr
    .split(|c: char| c.is_ascii_whitespace())
    .any(|part| part == token)
}

fn find_first_descendant_with_class(root: &NodeRef, token: &str) -> Option<NodeRef> {
  for node in root.descendants() {
    if let Some(elem) = node.as_element()
      && elem
        .attributes
        .borrow()
        .get("class")
        .is_some_and(|classes| has_class_token(classes, token))
    {
      return Some(node);
    }
  }
  None
}

/// Resolves the `.href` IDL property for HTML hyperlink/resource elements,
/// falling back to the raw `href` attribute when resolution against the
/// document base URL fails (matching HTML/JSDOM `HTMLAnchorElement.href`).
fn extract_element_href(node: &NodeRef, base_url: Option<&Url>) -> Option<String> {
  let elem = node.as_element()?;
  if elem.name.ns.as_ref() != HTML_NS {
    return None;
  }
  let tag = elem.name.local.as_ref();
  if !matches!(tag, "a" | "area" | "link" | "base") {
    return None;
  }
  let attrs = elem.attributes.borrow();
  let raw_attr = attrs.get("href")?;
  if let Some(base) = base_url
    && let Ok(resolved) = base.join(raw_attr)
  {
    return Some(resolved.to_string());
  }
  Some(raw_attr.to_string())
}

fn extract_results(
  blocks: &[NodeRef],
  base_url: Option<&Url>,
  seen_urls: &[String],
) -> Vec<DdgSearchResult> {
  let mut seen: HashSet<Cow<'_, str>> = seen_urls
    .iter()
    .map(|url| Cow::Borrowed(url.as_str()))
    .collect();
  let mut results = Vec::new();

  for block in blocks {
    let Some(title_link) = find_first_descendant_with_class(block, "result__a") else {
      continue;
    };
    let Some(snippet) = find_first_descendant_with_class(block, "result__snippet") else {
      continue;
    };

    let Some(href_value) = extract_element_href(&title_link, base_url) else {
      continue;
    };
    let raw_url = js_trim(&href_value);
    if raw_url.is_empty() {
      continue;
    }

    let title_text = title_link.text_contents();
    let title = js_trim(&title_text);
    if title.is_empty() {
      continue;
    }

    let desc_text = snippet.text_contents();
    let description = js_trim(&desc_text);
    if description.is_empty() {
      continue;
    }

    let url = clean_ddg_url(raw_url);
    if !seen.contains(url.as_str()) {
      seen.insert(Cow::Owned(url.clone()));
      results.push(DdgSearchResult {
        url,
        title: title.to_string(),
        description: description.to_string(),
      });
    }
  }

  results
}

fn extract_next_page_params(next_button: &NodeRef) -> Option<Vec<(String, String)>> {
  let form = next_button.ancestors().find(|ancestor| {
    ancestor
      .as_element()
      .is_some_and(|elem| elem.name.ns.as_ref() == HTML_NS && elem.name.local.as_ref() == "form")
  })?;

  let mut params: Vec<(String, String)> = Vec::new();
  for node in form.descendants() {
    let Some(elem) = node.as_element() else {
      continue;
    };
    if elem.name.ns.as_ref() != HTML_NS || elem.name.local.as_ref() != "input" {
      continue;
    }
    let attrs = elem.attributes.borrow();
    let (Some(name), Some(value)) = (attrs.get("name"), attrs.get("value")) else {
      continue;
    };
    if name.is_empty() {
      continue;
    }

    if let Some((_, existing_val)) = params.iter_mut().find(|(k, _)| k == name) {
      *existing_val = value.to_string();
    } else {
      params.push((name.to_string(), value.to_string()));
    }
  }

  Some(params)
}
