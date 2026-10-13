use std::collections::{HashMap, HashSet};

use std::sync::LazyLock;

use kuchikiki::{iter::NodeEdge, parse_html, traits::TendrilSink, NodeRef};
use napi_derive::napi;
use nodesig::{get_node_signature, SignatureMode};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::task;
use url::Url;

static URL_REGEX: LazyLock<Regex> = LazyLock::new(|| {
  Regex::new(r#"url\(['"]?([^'")]+)['"]?\)"#).expect("URL_REGEX is a valid static regex pattern")
});

static ATTRIBUTION_TEXT_REGEX: LazyLock<Regex> = LazyLock::new(|| {
  Regex::new(
    r"(?i)(\u{00A9}|©|\(c\)\s*\d{4}|Copyright\s+(\(c\)|\d{4})|All\s+Rights\s+Reserved|Creative\s+Commons|creativecommons\.org|CC[\s\-]BY([\s\-](SA|NC|ND|NC[\s\-]SA|NC[\s\-]ND))?|CC0|Licensed\s+under|Photo\s+by|Photo\s+credit|Image\s+credit)",
  )
  .expect("ATTRIBUTION_TEXT_REGEX is a valid static regex pattern")
});

const ATTRIBUTION_SELECTORS: &[&str] = &[
  "a[rel=\"license\"]",
  "a[href*=\"creativecommons.org\"]",
  "[itemprop=\"copyrightHolder\"]",
  "[itemprop=\"copyrightYear\"]",
  "[itemprop=\"author\"]",
  "[itemprop=\"creator\"]",
  "[class*=\"copyright\"]",
  "[class*=\"license\"]",
];

fn contains_attribution(node: &NodeRef) -> bool {
  let text = node.text_contents();
  if ATTRIBUTION_TEXT_REGEX.is_match(&text) {
    return true;
  }

  for selector in ATTRIBUTION_SELECTORS {
    if node.select(selector).is_ok_and(|mut x| x.next().is_some()) {
      return true;
    }
  }

  // Also check the node itself for attribute matches
  if let Some(element) = node.as_element() {
    let attrs = element.attributes.borrow();
    if let Some(class) = attrs.get("class") {
      let class_lower = class.to_lowercase();
      if class_lower.contains("copyright") || class_lower.contains("license") {
        return true;
      }
    }
  }

  false
}

/// Given a node that contains attribution content, recursively remove
/// child elements that do NOT carry attribution, keeping only text nodes
/// and attribution-bearing elements.
fn strip_non_attribution_children(node: &NodeRef) {
  let children: Vec<NodeRef> = node.children().collect();
  for child in children {
    if child.as_element().is_some() {
      if contains_attribution(&child) {
        strip_non_attribution_children(&child);
      } else {
        child.detach();
      }
    }
    // text nodes, comments, etc. are kept as-is
  }
}

use crate::utils::to_napi_err;

fn _extract_base_href_from_document(
  document: &NodeRef,
  url: &Url,
) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
  if let Some(base) = document
    .select("base[href]")
    .map_err(|_| "Failed to select base href".to_string())?
    .next()
    .and_then(|base| base.attributes.borrow().get("href").map(|x| x.to_string()))
  {
    if let Ok(base) = url.join(&base) {
      return Ok(base.to_string());
    }
  }

  Ok(url.to_string())
}

fn _extract_base_href(
  html: &str,
  url: &str,
) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
  let document = parse_html().one(html);
  let url = Url::parse(url)?;
  _extract_base_href_from_document(&document, &url)
}

/// Extract the base href from HTML document.
#[napi]
pub async fn extract_base_href(html: String, url: String) -> napi::Result<String> {
  let res = task::spawn_blocking(move || _extract_base_href(&html, &url))
    .await
    .map_err(|e| {
      napi::Error::new(
        napi::Status::GenericFailure,
        format!("extract_base_href join error: {e}"),
      )
    })?;

  res.map_err(to_napi_err)
}

/// Extract all links from HTML document.
#[napi]
pub async fn extract_links(html: Option<String>) -> napi::Result<Vec<String>> {
  task::spawn_blocking(move || {
    let html = match html {
      Some(h) => h,
      None => return Ok(Vec::new()),
    };

    let document = parse_html().one(html.as_str());

    let anchors: Vec<_> = document
      .select("a[href]")
      .map_err(|_| to_napi_err("Failed to select links"))?
      .collect();

    let mut out: Vec<String> = Vec::new();

    for anchor in anchors {
      let mut href = match anchor.attributes.borrow().get("href") {
        Some(x) => x.to_string(),
        None => continue,
      };

      if href.starts_with("http:/") && !href.starts_with("http://") {
        href = format!("http://{}", &href[6..]);
      } else if href.starts_with("https:/") && !href.starts_with("https://") {
        href = format!("https://{}", &href[7..]);
      }

      out.push(href);
    }

    Ok(out)
  })
  .await
  .map_err(|e| {
    napi::Error::new(
      napi::Status::GenericFailure,
      format!("extract_links join error: {e}"),
    )
  })?
}

macro_rules! insert_meta_name {
  ($out:ident, $document:ident, $metaName:expr, $outName:expr) => {
    if let Some(x) = $document
      .select(&format!("meta[name=\"{}\"]", $metaName))
      .map_err(|_| "Failed to select meta name")?
      .next()
      .and_then(|description| {
        description
          .attributes
          .borrow()
          .get("content")
          .map(|x| x.to_string())
      })
    {
      $out.insert(($outName).to_string(), Value::String(x));
    }
  };
}

macro_rules! insert_meta_property {
  ($out:ident, $document:ident, $metaName:expr, $outName:expr) => {
    if let Some(x) = $document
      .select(&format!("meta[property=\"{}\"]", $metaName))
      .map_err(|_| "Failed to select meta property")?
      .next()
      .and_then(|description| {
        description
          .attributes
          .borrow()
          .get("content")
          .map(|x| x.to_string())
      })
    {
      $out.insert(($outName).to_string(), Value::String(x));
    }
  };
}

fn _extract_metadata(
  html: &str,
) -> Result<HashMap<String, Value>, Box<dyn std::error::Error + Send + Sync>> {
  let document = parse_html().one(html);
  let mut out = HashMap::<String, Value>::new();

  let head_node = document
    .select("head")
    .map_err(|_| "Failed to select head")?
    .next();

  let search_root = head_node.as_ref().map(|h| h.as_node()).unwrap_or(&document);

  if let Some(title) = search_root
    .select("title")
    .map_err(|_| "Failed to select title")?
    .next()
  {
    out.insert("title".to_string(), Value::String(title.text_contents()));
  }

  if let Some(favicon_link) = search_root
    .select("link[rel=\"icon\"]")
    .map_err(|_| "Failed to select favicon")?
    .next()
    .and_then(|x| x.attributes.borrow().get("href").map(|x| x.to_string()))
    .or_else(|| {
      search_root
        .select("link[rel*=\"icon\"]")
        .ok()
        .and_then(|mut x| {
          x.next()
            .and_then(|x| x.attributes.borrow().get("href").map(|x| x.to_string()))
        })
    })
  {
    out.insert("favicon".to_string(), Value::String(favicon_link));
  }

  if let Some(lang) = document
    .select("html[lang]")
    .map_err(|_| "Failed to select lang")?
    .next()
    .and_then(|x| x.attributes.borrow().get("lang").map(|x| x.to_string()))
  {
    out.insert("language".to_string(), Value::String(lang));
  }

  insert_meta_property!(out, search_root, "og:title", "ogTitle");
  insert_meta_property!(out, search_root, "og:description", "ogDescription");
  insert_meta_property!(out, search_root, "og:url", "ogUrl");
  insert_meta_property!(out, search_root, "og:image", "ogImage");
  insert_meta_property!(out, search_root, "og:audio", "ogAudio");
  insert_meta_property!(out, search_root, "og:determiner", "ogDeterminer");
  insert_meta_property!(out, search_root, "og:locale", "ogLocale");

  for meta in search_root
    .select("meta[property=\"og:locale:alternate\"]")
    .map_err(|_| "Failed to select og locale alternate")?
  {
    let attrs = meta.attributes.borrow();

    if let Some(content) = attrs.get("content") {
      if let Some(v) = out.get_mut("ogLocaleAlternate") {
        match v {
          Value::Array(x) => x.push(Value::String(content.to_string())),
          _ => unreachable!(),
        }
      } else {
        out.insert(
          "ogLocaleAlternate".to_string(),
          Value::Array(vec![Value::String(content.to_string())]),
        );
      }
    }
  }

  insert_meta_property!(out, document, "og:site_name", "ogSiteName");
  insert_meta_property!(out, document, "og:video", "ogVideo");
  insert_meta_name!(out, document, "article:section", "articleSection");
  insert_meta_name!(out, document, "article:tag", "articleTag");
  insert_meta_property!(out, document, "article:published_time", "publishedTime");
  insert_meta_property!(out, document, "article:modified_time", "modifiedTime");
  insert_meta_name!(out, document, "dcterms.keywords", "dcTermsKeywords");
  insert_meta_name!(out, document, "dc.description", "dcDescription");
  insert_meta_name!(out, document, "dc.subject", "dcSubject");
  insert_meta_name!(out, document, "dcterms.subject", "dcTermsSubject");
  insert_meta_name!(out, document, "dcterms.audience", "dcTermsAudience");
  insert_meta_name!(out, document, "dc.type", "dcType");
  insert_meta_name!(out, document, "dcterms.type", "dcTermsType");
  insert_meta_name!(out, document, "dc.date", "dcDate");
  insert_meta_name!(out, document, "dc.date.created", "dcDateCreated");
  insert_meta_name!(out, document, "dcterms.created", "dcTermsCreated");

  for meta in document
    .select("meta")
    .map_err(|_| "Failed to select meta")?
  {
    let meta = meta.as_node().as_element().unwrap();
    let attrs = meta.attributes.borrow();

    if let Some(name) = attrs
      .get("name")
      .or_else(|| attrs.get("property"))
      .or_else(|| attrs.get("itemprop"))
    {
      if let Some(content) = attrs.get("content") {
        if let Some(v) = out.get(name) {
          match v {
            Value::String(existing) => {
              if name == "description" {
                out.insert(
                  name.to_string(),
                  Value::String(format!("{existing}, {content}")),
                );
              } else if name != "title" {
                out.insert(
                  name.to_string(),
                  Value::Array(vec![
                    Value::String(existing.clone()),
                    Value::String(content.to_string()),
                  ]),
                );
              }
            }
            Value::Array(existing_array) => {
              if name == "description" {
                let mut values: Vec<String> = existing_array
                  .iter()
                  .filter_map(|v| match v {
                    Value::String(s) => Some(s.clone()),
                    _ => None,
                  })
                  .collect();
                values.push(content.to_string());
                out.insert(name.to_string(), Value::String(values.join(", ")));
              } else {
                match out.get_mut(name) {
                  Some(Value::Array(x)) => x.push(Value::String(content.to_string())),
                  _ => unreachable!(),
                }
              }
            }
            _ => unreachable!(),
          }
        } else {
          out.insert(name.to_string(), Value::String(content.to_string()));
        }
      }
    }
  }

  // Backfill title from og:title, twitter:title, or meta[name="title"] if primary extraction failed
  if !out.contains_key("title") {
    let fallback_title = out
      .get("ogTitle")
      .or_else(|| out.get("og:title"))
      .or_else(|| out.get("twitter:title"))
      .and_then(|v| match v {
        Value::String(s) if !s.is_empty() => Some(s.clone()),
        _ => None,
      });

    if let Some(title) = fallback_title {
      out.insert("title".to_string(), Value::String(title));
    }
  }

  Ok(out)
}

/// Extract metadata from HTML document.
#[napi]
pub async fn extract_metadata(html: Option<String>) -> napi::Result<HashMap<String, Value>> {
  task::spawn_blocking(move || {
    let html = match html {
      Some(h) => h,
      None => return Ok(HashMap::new()),
    };

    _extract_metadata(&html).map_err(to_napi_err)
  })
  .await
  .map_err(|e| {
    napi::Error::new(
      napi::Status::GenericFailure,
      format!("extract_metadata join error: {e}"),
    )
  })?
}

const EXCLUDE_NON_MAIN_TAGS: [&str; 42] = [
  "header",
  "footer",
  "nav",
  "aside",
  ".header",
  ".top",
  ".navbar",
  "#header",
  ".footer",
  ".bottom",
  "#footer",
  ".sidebar",
  ".side",
  ".aside",
  "#sidebar",
  ".modal",
  ".popup",
  "#modal",
  ".overlay",
  ".ad",
  ".ads",
  ".advert",
  "#ad",
  ".lang-selector",
  ".language",
  "#language-selector",
  ".social",
  ".social-media",
  ".social-links",
  "#social",
  ".menu",
  ".navigation",
  "#nav",
  ".breadcrumbs",
  "#breadcrumbs",
  ".share",
  "#share",
  ".widget",
  "#widget",
  ".cookie",
  "#cookie",
  ".fc-decoration",
];

const FORCE_INCLUDE_MAIN_TAGS: [&str; 13] = [
  "#main",
  ".swoogo-cols",
  ".swoogo-text",
  ".swoogo-table-div",
  ".swoogo-space",
  ".swoogo-alert",
  ".swoogo-sponsors",
  ".swoogo-title",
  ".swoogo-tabs",
  ".swoogo-logo",
  ".swoogo-image",
  ".swoogo-button",
  ".swoogo-agenda",
];

#[derive(Deserialize, Serialize)]
#[napi(object)]
pub struct TransformHtmlOptions {
  pub html: String,
  pub url: String,
  #[serde(default)]
  pub include_tags: Vec<String>,
  #[serde(default)]
  pub exclude_tags: Vec<String>,
  pub only_main_content: bool,
  pub omce_signatures: Option<Vec<String>>,
}

struct ImageSource {
  url: String,
  size: f64,
  is_x: bool,
}

fn _transform_html_inner(
  opts: TransformHtmlOptions,
) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
  let mut document = parse_html().one(opts.html.as_ref());
  let url = Url::parse(&_extract_base_href_from_document(
    &document,
    &Url::parse(&opts.url)?,
  )?)?;

  if !opts.include_tags.is_empty() {
    let new_document = parse_html().one("<div></div>");
    let root = new_document
      .select_first("div")
      .map_err(|_| "Failed to select root element")?;

    for x in opts.include_tags.iter() {
      let matching_nodes: Vec<_> = document
        .select(x)
        .map_err(|_| "Failed to include_tags tags")?
        .collect();
      for tag in matching_nodes {
        root.as_node().append(tag.as_node().clone());
      }
    }

    document = new_document;
  }

  while let Ok(x) = document.select_first("head") {
    x.as_node().detach();
  }
  while let Ok(x) = document.select_first("meta") {
    x.as_node().detach();
  }
  while let Ok(x) = document.select_first("noscript") {
    x.as_node().detach();
  }
  while let Ok(x) = document.select_first("style") {
    x.as_node().detach();
  }
  while let Ok(x) = document.select_first("script") {
    x.as_node().detach();
  }

  // OMCE first
  if opts.only_main_content {
    if let Some(signatures) = opts.omce_signatures.as_ref() {
      let mut nodes_to_drop: Vec<NodeRef> = Vec::new();

      let modes = signatures
        .iter()
        .map(|x| Into::<SignatureMode>::into(x.split(':').nth(1).unwrap().to_string()))
        .collect::<HashSet<_>>();

      for mode in modes {
        let matcher = format!(":{}:", Into::<String>::into(mode));
        let signatures = signatures
          .iter()
          .filter(|x| x.contains(&matcher))
          .cloned()
          .collect::<HashSet<_>>();

        for edge in document.traverse() {
          match edge {
            NodeEdge::Start(_) => {}
            NodeEdge::End(node) => {
              if node.as_element().is_none() {
                continue;
              }
              if node.text_contents().trim().is_empty() {
                continue;
              }

              let signature = get_node_signature(&node, mode);
              if signatures.contains(&signature) {
                nodes_to_drop.push(node);
              }
            }
          }
        }
      }

      for node in nodes_to_drop {
        node.detach();
      }
    }
  }

  for x in opts.exclude_tags.iter() {
    while let Ok(x) = document.select_first(x) {
      x.as_node().detach();
    }
  }

  if opts.only_main_content {
    for x in EXCLUDE_NON_MAIN_TAGS.iter() {
      let x: Vec<_> = document
        .select(x)
        .map_err(|_| "Failed to select tags")?
        .collect();
      for tag in x {
        if FORCE_INCLUDE_MAIN_TAGS.iter().any(|x| {
          tag
            .as_node()
            .select(x)
            .is_ok_and(|mut x| x.next().is_some())
        }) {
          continue;
        }
        if contains_attribution(tag.as_node()) {
          strip_non_attribution_children(tag.as_node());
          continue;
        }
        tag.as_node().detach();
      }
    }
  }

  // Resolve images, including lazy-loaded ones. Many sites ship a tiny
  // placeholder in `src` and keep the real image in `data-srcset` / `data-src`,
  // swapping it in via JS only once the image scrolls into view. When the real
  // `srcset` isn't present yet, fall back to those lazy-load attributes so we
  // emit the actual image instead of the placeholder. Images that already have
  // a `srcset` are handled exactly as before.
  let imgs: Vec<_> = document
    .select("img")
    .map_err(|_| "Failed to select images")?
    .collect();
  for img in imgs {
    let srcset = {
      let attrs = img.attributes.borrow();
      attrs
        .get("srcset")
        .filter(|x| !x.trim().is_empty())
        .or_else(|| attrs.get("data-srcset").filter(|x| !x.trim().is_empty()))
        .map(|x| x.to_string())
    };

    if let Some(srcset) = srcset {
      let mut sizes: Vec<ImageSource> = srcset
        .split(',')
        .filter_map(|x| {
          let tok: Vec<&str> = x.trim().split(' ').collect();
          let last_token = tok[tok.len() - 1];
          let (last_token, last_token_used) = if tok.len() > 1
            && !last_token.is_empty()
            && (last_token.ends_with('x') || last_token.ends_with('w'))
          {
            (last_token, true)
          } else {
            ("1x", false)
          };

          if let Some((last_index, _)) = last_token.char_indices().last() {
            if let Ok(parsed_size) = last_token[..last_index].parse() {
              Some(ImageSource {
                url: if last_token_used {
                  tok[0..tok.len() - 1].join(" ")
                } else {
                  tok.join(" ")
                },
                size: parsed_size,
                is_x: last_token.ends_with('x'),
              })
            } else {
              None
            }
          } else {
            None
          }
        })
        .collect();

      if sizes.iter().all(|x| x.is_x) {
        if let Some(src) = img.attributes.borrow().get("src").map(|x| x.to_string()) {
          sizes.push(ImageSource {
            url: src,
            size: 1.0,
            is_x: true,
          });
        }
      }

      sizes.sort_by(|a, b| {
        b.size
          .partial_cmp(&a.size)
          .unwrap_or(std::cmp::Ordering::Equal)
      });

      if let Some(biggest) = sizes.first() {
        img
          .attributes
          .borrow_mut()
          .insert("src", biggest.url.clone());
      }
    } else {
      // No usable `srcset`/`data-srcset`: fall back to `data-src` for the
      // common lazy-load case where only a single image URL is deferred.
      let data_src = {
        let attrs = img.attributes.borrow();
        attrs
          .get("data-src")
          .filter(|x| !x.trim().is_empty())
          .map(|x| x.to_string())
      };
      if let Some(data_src) = data_src {
        img.attributes.borrow_mut().insert("src", data_src);
      }
    }
  }

  let src_images: Vec<_> = document
    .select("img[src]")
    .map_err(|_| "Failed to select src images")?
    .collect();
  for img in src_images {
    let old = img
      .attributes
      .borrow()
      .get("src")
      .map(|x| x.to_string())
      .ok_or("Failed to get src")?;
    if let Ok(new) = url.join(&old) {
      img.attributes.borrow_mut().insert("src", new.to_string());
    }
  }

  let href_anchors: Vec<_> = document
    .select("a[href]")
    .map_err(|_| "Failed to select href anchors")?
    .collect();
  for anchor in href_anchors {
    let old = anchor
      .attributes
      .borrow()
      .get("href")
      .map(|x| x.to_string())
      .ok_or("Failed to get href")?;
    if let Ok(new) = url.join(&old) {
      anchor
        .attributes
        .borrow_mut()
        .insert("href", new.to_string());
    }
  }

  Ok(document.to_string())
}

/// Transform and clean HTML content based on provided options.
#[napi]
pub async fn transform_html(opts: TransformHtmlOptions) -> napi::Result<String> {
  let res = task::spawn_blocking(move || _transform_html_inner(opts))
    .await
    .map_err(|e| {
      napi::Error::new(
        napi::Status::GenericFailure,
        format!("transform_html join error: {e}"),
      )
    })?;

  res.map_err(to_napi_err)
}

fn _get_inner_json(html: &str) -> Result<String, ()> {
  Ok(parse_html().one(html).select_first("body")?.text_contents())
}

/// Extract inner text content from HTML body.
#[napi]
pub async fn get_inner_json(html: String) -> napi::Result<String> {
  let res = task::spawn_blocking(move || _get_inner_json(&html))
    .await
    .map_err(|e| {
      napi::Error::new(
        napi::Status::GenericFailure,
        format!("get_inner_json join error: {e}"),
      )
    })?;

  res.map_err(|_| to_napi_err("Failed to get inner JSON"))
}

#[derive(Deserialize, Serialize)]
#[napi(object)]
pub struct AttributeSelector {
  pub selector: String,
  pub attribute: String,
}

#[derive(Deserialize, Serialize)]
#[napi(object)]
pub struct ExtractAttributesOptions {
  pub selectors: Vec<AttributeSelector>,
}

#[derive(Serialize)]
#[napi(object)]
pub struct ExtractedAttributeResult {
  pub selector: String,
  pub attribute: String,
  pub values: Vec<String>,
}

fn _extract_attributes(
  html: &str,
  options: &ExtractAttributesOptions,
) -> Result<Vec<ExtractedAttributeResult>, Box<dyn std::error::Error + Send + Sync>> {
  let document = parse_html().one(html);
  let mut results = Vec::new();

  for selector_config in &options.selectors {
    let mut values = Vec::new();

    let elements: Vec<_> = match document.select(&selector_config.selector).map_err(|_| {
      format!(
        "Failed to select with selector: {}",
        selector_config.selector
      )
    }) {
      Ok(x) => x.collect(),
      Err(_) => Vec::new(), // invalid selector => empty list
    };

    for element in elements {
      if let Some(attr_value) = element
        .attributes
        .borrow()
        .get(selector_config.attribute.as_str())
      {
        values.push(attr_value.to_string());
        continue;
      }

      if !selector_config.attribute.starts_with("data-") {
        let data_attr = format!("data-{}", selector_config.attribute);
        if let Some(attr_value) = element.attributes.borrow().get(data_attr.as_str()) {
          values.push(attr_value.to_string());
        }
      }
    }

    results.push(ExtractedAttributeResult {
      selector: selector_config.selector.clone(),
      attribute: selector_config.attribute.clone(),
      values,
    });
  }

  Ok(results)
}

/// Extract specified attributes from HTML elements matching selectors.
#[napi]
pub async fn extract_attributes(
  html: String,
  options: ExtractAttributesOptions,
) -> napi::Result<Vec<ExtractedAttributeResult>> {
  let res = task::spawn_blocking(move || _extract_attributes(&html, &options))
    .await
    .map_err(|e| {
      napi::Error::new(
        napi::Status::GenericFailure,
        format!("extract_attributes join error: {e}"),
      )
    })?;

  res.map_err(to_napi_err)
}

fn _extract_images(
  html: &str,
  base_url: &str,
) -> Result<Vec<String>, Box<dyn std::error::Error + Send + Sync>> {
  let document = parse_html().one(html);
  let base_url = Url::parse(base_url)?;
  let base_href = _extract_base_href_from_document(&document, &base_url)?;
  let base_href_url = Url::parse(&base_href)?;
  let mut images = HashSet::<String>::new();

  let resolve_image_url = |src: &str| -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    if src.starts_with("data:") || src.starts_with("blob:") {
      return Ok(src.to_string());
    }
    if src.starts_with("http://") || src.starts_with("https://") {
      return Ok(src.to_string());
    }
    if src.starts_with("//") {
      let resolved = base_url.join(src)?;
      return Ok(resolved.to_string());
    }
    let resolved = base_href_url.join(src)?;
    Ok(resolved.to_string())
  };

  // <img>
  let img_elements: Vec<_> = match document
    .select("img")
    .map_err(|_| "Failed to select img tags")
  {
    Ok(x) => x.collect(),
    Err(e) => return Err(e.into()),
  };

  for img in img_elements {
    let attrs = img.attributes.borrow();

    if let Some(src) = attrs.get("src") {
      if let Ok(resolved) = resolve_image_url(src) {
        images.insert(resolved);
      }
    }

    if let Some(data_src) = attrs.get("data-src") {
      if let Ok(resolved) = resolve_image_url(data_src) {
        images.insert(resolved);
      }
    }

    if let Some(srcset) = attrs.get("srcset") {
      for part in srcset.split(',') {
        if let Some(url) = part.split_whitespace().next() {
          if !url.is_empty() {
            if let Ok(resolved) = resolve_image_url(url) {
              images.insert(resolved);
            }
          }
        }
      }
    }
  }

  // <picture><source>
  let source_elements: Vec<_> = match document
    .select("picture source")
    .map_err(|_| "Failed to select picture source")
  {
    Ok(x) => x.collect(),
    Err(_) => Vec::new(),
  };

  for source in source_elements {
    if let Some(srcset) = source.attributes.borrow().get("srcset") {
      for part in srcset.split(',') {
        if let Some(url) = part.split_whitespace().next() {
          if !url.is_empty() {
            if let Ok(resolved) = resolve_image_url(url) {
              images.insert(resolved);
            }
          }
        }
      }
    }
  }

  // OG/Twitter images
  let meta_selectors = [
    "meta[property=\"og:image\"]",
    "meta[property=\"og:image:url\"]",
    "meta[property=\"og:image:secure_url\"]",
    "meta[name=\"twitter:image\"]",
    "meta[name=\"twitter:image:src\"]",
    "meta[itemprop=\"image\"]",
  ];

  for selector in &meta_selectors {
    if let Ok(elements) = document.select(selector) {
      for element in elements {
        if let Some(content) = element.attributes.borrow().get("content") {
          if let Ok(resolved) = resolve_image_url(content) {
            images.insert(resolved);
          }
        }
      }
    }
  }

  // icons
  let link_selectors = [
    "link[rel*=\"icon\"]",
    "link[rel*=\"apple-touch-icon\"]",
    "link[rel*=\"image_src\"]",
  ];

  for selector in &link_selectors {
    if let Ok(elements) = document.select(selector) {
      for element in elements {
        if let Some(href) = element.attributes.borrow().get("href") {
          if let Ok(resolved) = resolve_image_url(href) {
            images.insert(resolved);
          }
        }
      }
    }
  }

  // <video poster="">
  if let Ok(video_elements) = document.select("video[poster]") {
    for video in video_elements {
      if let Some(poster) = video.attributes.borrow().get("poster") {
        if let Ok(resolved) = resolve_image_url(poster) {
          images.insert(resolved);
        }
      }
    }
  }

  // <... style="background: url(...)"> or <... style="background-image: url(...)">
  if let Ok(elements) = document.select("[style*=\"background\"]") {
    for element in elements {
      if let Some(style) = element.attributes.borrow().get("style") {
        for cap in URL_REGEX.captures_iter(style) {
          if let Some(url_match) = cap.get(1) {
            let url = url_match.as_str().trim();
            if !url.is_empty() {
              if let Ok(resolved) = resolve_image_url(url) {
                images.insert(resolved);
              }
            }
          }
        }
      }
    }
  }

  let filtered_images: Vec<String> = images
    .into_iter()
    .filter(|url| !url.to_lowercase().starts_with("javascript:"))
    .filter(|url| !url.is_empty())
    .filter(|url| url.starts_with("data:") || url.starts_with("blob:") || Url::parse(url).is_ok())
    .collect();

  Ok(filtered_images)
}

/// Extract all image URLs from HTML document.
#[napi]
pub async fn extract_images(html: String, base_url: String) -> napi::Result<Vec<String>> {
  let res = task::spawn_blocking(move || _extract_images(&html, &base_url))
    .await
    .map_err(|e| {
      napi::Error::new(
        napi::Status::GenericFailure,
        format!("extract_images join error: {e}"),
      )
    })?;

  res.map_err(to_napi_err)
}

/// Process multi-line links in markdown.
#[napi]
pub async fn post_process_markdown(markdown: String) -> napi::Result<String> {
  let res = task::spawn_blocking(move || {
    let mut link_open_count = 0usize;
    let mut out = String::with_capacity(markdown.len());

    for ch in markdown.chars() {
      match ch {
        '[' => {
          link_open_count += 1;
        }
        ']' => {
          link_open_count = link_open_count.saturating_sub(1);
        }
        _ => {}
      }

      let inside_link_content = link_open_count > 0;
      if inside_link_content && ch == '\n' {
        out.push('\\');
        out.push('\n');
      } else {
        out.push(ch);
      }
    }

    remove_skip_to_content_links(&out)
  })
  .await
  .map_err(|e| {
    napi::Error::new(
      napi::Status::GenericFailure,
      format!("post_process_markdown join error: {e}"),
    )
  })?;

  Ok(res)
}

#[cfg(test)]
mod tests {
  use super::*;
  use kuchikiki::parse_html;
  use kuchikiki::traits::TendrilSink;

  fn make_node(html: &str) -> NodeRef {
    parse_html().one(html)
  }

  #[test]
  fn detects_copyright_symbol() {
    let node = make_node("<footer>© 2024 Company</footer>");
    assert!(contains_attribution(&node));
  }

  #[test]
  fn detects_html_entity_copyright() {
    let node = make_node("<footer>&copy; 2024 Company</footer>");
    assert!(contains_attribution(&node));
  }

  #[test]
  fn detects_copyright_text() {
    let node = make_node("<div>Copyright 2024 Company Inc.</div>");
    assert!(contains_attribution(&node));
  }

  #[test]
  fn detects_copyright_c() {
    let node = make_node("<div>Copyright (c) Company</div>");
    assert!(contains_attribution(&node));
  }

  #[test]
  fn detects_all_rights_reserved() {
    let node = make_node("<footer>All Rights Reserved</footer>");
    assert!(contains_attribution(&node));
  }

  #[test]
  fn detects_creative_commons_text() {
    let node = make_node("<div>Licensed under Creative Commons</div>");
    assert!(contains_attribution(&node));
  }

  #[test]
  fn detects_cc_by_license() {
    let node = make_node("<div>CC BY-SA 4.0</div>");
    assert!(contains_attribution(&node));
  }

  #[test]
  fn detects_cc0() {
    let node = make_node("<div>CC0 1.0 Universal</div>");
    assert!(contains_attribution(&node));
  }

  #[test]
  fn detects_licensed_under() {
    let node = make_node("<div>Licensed under the MIT License</div>");
    assert!(contains_attribution(&node));
  }

  #[test]
  fn detects_photo_credit() {
    let node = make_node("<aside>Photo by John Doe</aside>");
    assert!(contains_attribution(&node));
  }

  #[test]
  fn detects_image_credit() {
    let node = make_node("<aside>Image credit: Jane Smith</aside>");
    assert!(contains_attribution(&node));
  }

  #[test]
  fn detects_rel_license_link() {
    let node = make_node(r#"<footer><a rel="license" href="https://creativecommons.org/licenses/by/4.0/">License</a></footer>"#);
    assert!(contains_attribution(&node));
  }

  #[test]
  fn detects_itemprop_copyright_holder() {
    let node = make_node(r#"<footer><span itemprop="copyrightHolder">Company</span></footer>"#);
    assert!(contains_attribution(&node));
  }

  #[test]
  fn detects_itemprop_copyright_year() {
    let node = make_node(r#"<footer><span itemprop="copyrightYear">2024</span></footer>"#);
    assert!(contains_attribution(&node));
  }

  #[test]
  fn detects_copyright_class() {
    let node = make_node(r#"<div class="site-copyright">Some text</div>"#);
    assert!(contains_attribution(&node));
  }

  #[test]
  fn detects_license_class() {
    let node = make_node(r#"<div class="license-info">Some text</div>"#);
    assert!(contains_attribution(&node));
  }

  #[test]
  fn no_false_positive_on_plain_nav() {
    let node = make_node("<nav><a href='/home'>Home</a><a href='/about'>About</a></nav>");
    assert!(!contains_attribution(&node));
  }

  #[test]
  fn no_false_positive_on_plain_aside() {
    let node = make_node("<aside><h3>Related articles</h3><ul><li>Article 1</li></ul></aside>");
    assert!(!contains_attribution(&node));
  }

  #[test]
  fn no_false_positive_on_social_links() {
    let node = make_node(r#"<div class="social-links"><a href="https://twitter.com">Twitter</a></div>"#);
    assert!(!contains_attribution(&node));
  }

  #[test]
  fn detects_standalone_c_year() {
    let node = make_node("<footer>(c) 2024 Company</footer>");
    assert!(contains_attribution(&node));
  }

  #[test]
  fn detects_standalone_c_year_no_space() {
    let node = make_node("<footer>(c)2024 Company</footer>");
    assert!(contains_attribution(&node));
  }

  #[test]
  fn detects_uppercase_c_in_parens() {
    let node = make_node("<footer>(C) 2024 Company</footer>");
    assert!(contains_attribution(&node));
  }

  #[test]
  fn detects_copyright_lowercase() {
    let node = make_node("<footer>copyright 2024 Company</footer>");
    assert!(contains_attribution(&node));
  }

  #[test]
  fn detects_all_rights_reserved_mixed_case() {
    let node = make_node("<footer>all rights reserved</footer>");
    assert!(contains_attribution(&node));
  }

  #[test]
  fn detects_copyright_symbol_no_year() {
    let node = make_node("<footer>© Company Name</footer>");
    assert!(contains_attribution(&node));
  }

  #[test]
  fn detects_cc_by_alone() {
    let node = make_node("<div>CC BY 4.0</div>");
    assert!(contains_attribution(&node));
  }

  #[test]
  fn detects_cc_by_nc_sa() {
    let node = make_node("<div>CC BY-NC-SA 4.0</div>");
    assert!(contains_attribution(&node));
  }

  #[test]
  fn detects_cc_by_nc_nd() {
    let node = make_node("<div>CC BY-NC-ND 4.0</div>");
    assert!(contains_attribution(&node));
  }

  #[test]
  fn detects_cc_by_with_spaces() {
    let node = make_node("<div>CC BY SA 4.0</div>");
    assert!(contains_attribution(&node));
  }

  #[test]
  fn detects_licensed_under_apache() {
    let node = make_node("<footer>Licensed under the Apache License 2.0</footer>");
    assert!(contains_attribution(&node));
  }

  #[test]
  fn detects_photo_by_mid_text() {
    let node = make_node("<aside>Header image: Photo by Jane Doe on Unsplash</aside>");
    assert!(contains_attribution(&node));
  }

  #[test]
  fn detects_attribution_nested_deep() {
    let node = make_node(r#"<footer><div class="wrapper"><div class="inner"><span>© 2024 Corp</span></div></div></footer>"#);
    assert!(contains_attribution(&node));
  }

  #[test]
  fn detects_creativecommons_org_link() {
    let node = make_node(r#"<footer><a href="https://creativecommons.org/licenses/by/4.0/">License</a></footer>"#);
    assert!(contains_attribution(&node));
  }

  #[test]
  fn transform_preserves_attribution_footer_removes_nav() {
    let html = r#"<html><body>
      <nav><a href="/home">Home</a><a href="/about">About</a></nav>
      <main><h1>Hello World</h1><p>Content here</p></main>
      <footer>© 2024 Test Company. All Rights Reserved.</footer>
    </body></html>"#;

    let result = _transform_html_inner(TransformHtmlOptions {
      html: html.to_string(),
      url: "https://example.com".to_string(),
      include_tags: vec![],
      exclude_tags: vec![],
      only_main_content: true,
      omce_signatures: None,
    })
    .unwrap();

    // Footer with attribution should be preserved
    assert!(result.contains("© 2024 Test Company"));
    assert!(result.contains("All Rights Reserved"));

    // Nav should be removed
    assert!(!result.contains("Home</a>"));
    assert!(!result.contains("About</a>"));
  }

  #[test]
  fn transform_strips_noise_siblings_keeps_attribution() {
    let html = r#"<html><body>
      <main><h1>Hello World</h1></main>
      <footer>
        <div class="copyright">© 2024 Test Company</div>
        <div class="social-links"><a href="https://twitter.com">Twitter</a><a href="https://github.com">GitHub</a></div>
        <div class="sitemap"><a href="/sitemap">Sitemap</a></div>
      </footer>
    </body></html>"#;

    let result = _transform_html_inner(TransformHtmlOptions {
      html: html.to_string(),
      url: "https://example.com".to_string(),
      include_tags: vec![],
      exclude_tags: vec![],
      only_main_content: true,
      omce_signatures: None,
    })
    .unwrap();

    // Attribution div kept
    assert!(result.contains("© 2024 Test Company"));
    // Noise siblings removed
    assert!(!result.contains("Twitter"));
    assert!(!result.contains("GitHub"));
    assert!(!result.contains("Sitemap"));
  }

  #[test]
  fn transform_strips_nested_noise_keeps_nested_attribution() {
    let html = r#"<html><body>
      <main><h1>Content</h1></main>
      <footer>
        <div class="footer-inner">
          <div class="copyright-wrapper"><span>© 2024 Corp</span></div>
          <div class="social"><a href="/tw">Twitter</a></div>
          <div class="newsletter"><form>Subscribe</form></div>
        </div>
      </footer>
    </body></html>"#;

    let result = _transform_html_inner(TransformHtmlOptions {
      html: html.to_string(),
      url: "https://example.com".to_string(),
      include_tags: vec![],
      exclude_tags: vec![],
      only_main_content: true,
      omce_signatures: None,
    })
    .unwrap();

    // Nested attribution kept
    assert!(result.contains("© 2024 Corp"));
    // Nested noise removed
    assert!(!result.contains("Twitter"));
    assert!(!result.contains("Subscribe"));
  }

  #[test]
  fn transform_removes_footer_without_attribution() {
    let html = r#"<html><body>
      <main><h1>Hello World</h1></main>
      <footer><a href="/sitemap">Sitemap</a></footer>
    </body></html>"#;

    let result = _transform_html_inner(TransformHtmlOptions {
      html: html.to_string(),
      url: "https://example.com".to_string(),
      include_tags: vec![],
      exclude_tags: vec![],
      only_main_content: true,
      omce_signatures: None,
    })
    .unwrap();

    // Footer without attribution should be removed
    assert!(!result.contains("Sitemap"));
  }

  #[test]
  fn transform_no_strip_when_only_main_content_false() {
    let html = r#"<html><body>
      <nav><a href="/home">Home</a></nav>
      <main><h1>Hello World</h1></main>
      <footer><a href="/sitemap">Sitemap</a></footer>
    </body></html>"#;

    let result = _transform_html_inner(TransformHtmlOptions {
      html: html.to_string(),
      url: "https://example.com".to_string(),
      include_tags: vec![],
      exclude_tags: vec![],
      only_main_content: false,
      omce_signatures: None,
    })
    .unwrap();

    // Everything should be preserved
    assert!(result.contains("Home"));
    assert!(result.contains("Hello World"));
    assert!(result.contains("Sitemap"));
  }
}

fn remove_skip_to_content_links(input: &str) -> String {
  const LABEL: &str = "Skip to Content";
  let bytes = input.as_bytes();
  let len = bytes.len();
  let mut out = String::with_capacity(len);
  let mut i = 0;

  'outer: while i < len {
    if bytes[i] == b'[' {
      let label_start = i + 1;
      let label_end = label_start + LABEL.len();

      if label_end <= len && bytes[label_start..label_end].iter().all(|b| b.is_ascii()) {
        let label_slice = &input[label_start..label_end];

        if label_slice.eq_ignore_ascii_case(LABEL)
          && label_end + 3 <= len
          && bytes[label_end] == b']'
          && bytes[label_end + 1] == b'('
          && bytes[label_end + 2] == b'#'
        {
          let mut j = label_end + 3;

          while j < len {
            let ch = input[j..].chars().next().unwrap();
            if ch == ')' {
              i = j + ch.len_utf8();
              continue 'outer;
            }
            j += ch.len_utf8();
          }
        }
      }
    }

    let ch = input[i..].chars().next().unwrap();
    out.push(ch);
    i += ch.len_utf8();
  }

  out
}
