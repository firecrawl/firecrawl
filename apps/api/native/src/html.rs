use std::collections::{HashMap, HashSet};

use kuchikiki::{iter::NodeEdge, parse_html, traits::TendrilSink, NodeRef};
use napi_derive::napi;
use nodesig::{get_node_signature, SignatureMode};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::task;
use url::Url;

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
        if !FORCE_INCLUDE_MAIN_TAGS.iter().any(|x| {
          tag
            .as_node()
            .select(x)
            .is_ok_and(|mut x| x.next().is_some())
        }) {
          tag.as_node().detach();
        }
      }
    }
  }

  let srcset_images: Vec<_> = document
    .select("img[srcset]")
    .map_err(|_| "Failed to select srcset images")?
    .collect();
  for img in srcset_images {
    let mut sizes: Vec<ImageSource> = img
      .attributes
      .borrow()
      .get("srcset")
      .ok_or("Failed to get srcset")?
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

    let out = remove_skip_to_content_links(&out);
    deduplicate_markdown_images(&out)
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

/// Deduplicate markdown images by removing duplicate image references.
/// This addresses the issue where infinite scroll carousels duplicate images
/// in the DOM for seamless looping effects, resulting in repeated images in markdown.
/// Keeps the first occurrence of each image URL.
fn deduplicate_markdown_images(input: &str) -> String {
  let mut seen_urls: HashSet<String> = HashSet::new();
  let mut out = String::with_capacity(input.len());
  let bytes = input.as_bytes();
  let len = bytes.len();
  let mut i = 0;

  while i < len {
    // Check for markdown image pattern: ![...](...) 
    if i + 1 < len && bytes[i] == b'!' && bytes[i + 1] == b'[' {
      let img_start = i;
      
      // Find the end of alt text: ![alt text]
      let mut j = i + 2;
      let mut bracket_depth = 1;
      
      while j < len && bracket_depth > 0 {
        match bytes[j] {
          b'[' => bracket_depth += 1,
          b']' => bracket_depth -= 1,
          b'\\' if j + 1 < len => {
            j += 1; // Skip escaped character
          }
          _ => {}
        }
        j += 1;
      }
      
      // Check if followed by (url)
      if j < len && bytes[j] == b'(' {
        let url_start = j + 1;
        let mut paren_depth = 1;
        j += 1;
        
        while j < len && paren_depth > 0 {
          match bytes[j] {
            b'(' => paren_depth += 1,
            b')' => paren_depth -= 1,
            b'\\' if j + 1 < len => {
              j += 1; // Skip escaped character
            }
            _ => {}
          }
          j += 1;
        }
        
        let img_end = j;
        
        // Extract the URL (without the closing paren)
        let url_end = j - 1;
        if url_start < url_end {
          let url = &input[url_start..url_end];
          // Trim any title attribute: ![alt](url "title")
          let url_only = url.split_whitespace().next().unwrap_or(url);
          
          if seen_urls.contains(url_only) {
            // Skip this duplicate image entirely
            i = img_end;
            // Also skip any trailing whitespace/newline after the image
            while i < len && (bytes[i] == b' ' || bytes[i] == b'\n' || bytes[i] == b'\r') {
              // Only consume one newline to avoid collapsing too much whitespace
              if bytes[i] == b'\n' {
                i += 1;
                break;
              }
              i += 1;
            }
            continue;
          } else {
            seen_urls.insert(url_only.to_string());
            // Keep the image
            out.push_str(&input[img_start..img_end]);
            i = img_end;
            continue;
          }
        }
      }
    }
    
    // Not an image or couldn't parse it, copy character as-is
    let ch = input[i..].chars().next().unwrap();
    out.push(ch);
    i += ch.len_utf8();
  }

  out
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn test_deduplicate_markdown_images_removes_duplicates() {
    let input = "![Logo](https://example.com/logo.png)\n![Logo](https://example.com/logo.png)\n![Logo](https://example.com/logo.png)";
    let result = deduplicate_markdown_images(input);
    
    // Should only have one occurrence
    assert_eq!(result.matches("logo.png").count(), 1);
  }

  #[test]
  fn test_deduplicate_markdown_images_keeps_unique() {
    let input = "![Logo 1](https://example.com/logo1.png)\n![Logo 2](https://example.com/logo2.png)\n![Logo 3](https://example.com/logo3.png)";
    let result = deduplicate_markdown_images(input);
    
    // Should keep all unique images
    assert!(result.contains("logo1.png"));
    assert!(result.contains("logo2.png"));
    assert!(result.contains("logo3.png"));
  }

  #[test]
  fn test_deduplicate_markdown_images_preserves_first_occurrence() {
    let input = "![First](https://example.com/image.png)\nSome text\n![Second](https://example.com/image.png)";
    let result = deduplicate_markdown_images(input);
    
    // Should preserve the first alt text
    assert!(result.contains("![First]"));
    assert!(!result.contains("![Second]"));
  }

  #[test]
  fn test_deduplicate_markdown_images_handles_different_alt_same_url() {
    let input = "![Company Logo](https://example.com/logo.png)\n![Our Logo](https://example.com/logo.png)\n![](https://example.com/logo.png)";
    let result = deduplicate_markdown_images(input);
    
    // Should only have one occurrence of the URL
    assert_eq!(result.matches("logo.png").count(), 1);
    // Should keep the first one
    assert!(result.contains("![Company Logo]"));
  }

  #[test]
  fn test_deduplicate_markdown_images_does_not_affect_links() {
    let input = "[Link 1](https://example.com/page)\n[Link 2](https://example.com/page)";
    let result = deduplicate_markdown_images(input);
    
    // Links should not be deduplicated (they don't start with !)
    assert_eq!(result.matches("[Link").count(), 2);
  }

  #[test]
  fn test_deduplicate_markdown_images_carousel_scenario() {
    // Simulates the infinite scroll carousel case
    let input = r#"# Partner Logos

![Partner A](https://example.com/partner-a.png)
![Partner B](https://example.com/partner-b.png)
![Partner C](https://example.com/partner-c.png)
![Partner A](https://example.com/partner-a.png)
![Partner B](https://example.com/partner-b.png)
![Partner C](https://example.com/partner-c.png)
![Partner A](https://example.com/partner-a.png)
![Partner B](https://example.com/partner-b.png)
![Partner C](https://example.com/partner-c.png)

## Footer"#;
    
    let result = deduplicate_markdown_images(input);
    
    // Each partner should only appear once
    assert_eq!(result.matches("partner-a.png").count(), 1);
    assert_eq!(result.matches("partner-b.png").count(), 1);
    assert_eq!(result.matches("partner-c.png").count(), 1);
    
    // The surrounding content should be preserved
    assert!(result.contains("# Partner Logos"));
    assert!(result.contains("## Footer"));
  }

  #[test]
  fn test_deduplicate_markdown_images_with_title() {
    let input = r#"![Logo](https://example.com/logo.png "Company Logo")
![Logo](https://example.com/logo.png "Another Title")"#;
    let result = deduplicate_markdown_images(input);
    
    // Should deduplicate based on URL, ignoring title
    assert_eq!(result.matches("logo.png").count(), 1);
  }

  #[test]
  fn test_deduplicate_markdown_images_empty_input() {
    let input = "";
    let result = deduplicate_markdown_images(input);
    assert_eq!(result, "");
  }

  #[test]
  fn test_deduplicate_markdown_images_no_images() {
    let input = "Just some text\nWith multiple lines\nNo images here";
    let result = deduplicate_markdown_images(input);
    assert_eq!(result, input);
  }

  #[test]
  fn test_remove_skip_to_content_links() {
    let input = "[Skip to Content](#main)Hello World";
    let result = remove_skip_to_content_links(input);
    assert_eq!(result, "Hello World");
  }

  #[test]
  fn test_remove_skip_to_content_links_case_insensitive() {
    let input = "[skip to content](#skip)Hello";
    let result = remove_skip_to_content_links(input);
    assert_eq!(result, "Hello");
  }
}
