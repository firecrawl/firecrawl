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

/// Base URL of an already-parsed document: its `<base href>` if it has one,
/// otherwise the page URL.
pub fn base_href_of_document(document: &NodeRef, url: &Url) -> String {
  _extract_base_href_from_document(document, url).unwrap_or_else(|_| url.to_string())
}

fn _extract_base_href(
  html: &str,
  url: &str,
) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
  let document = parse_html().one(html).document_node;
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

/// Raw `href` of every link in an already-parsed document.
pub fn extract_links_from_document(document: &NodeRef) -> Result<Vec<String>, String> {
  let anchors: Vec<_> = document
    .select("a[href]")
    .map_err(|_| "Failed to select links".to_string())?
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
}

/// Extract all links from HTML document.
#[napi]
pub async fn extract_links(html: Option<String>) -> napi::Result<Vec<String>> {
  task::spawn_blocking(move || {
    let html = match html {
      Some(h) => h,
      None => return Ok(Vec::new()),
    };

    let document = parse_html().one(html.as_str()).document_node;
    extract_links_from_document(&document).map_err(to_napi_err)
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
  let document = parse_html().one(html).document_node;
  extract_metadata_from_document(&document)
}

/// Metadata of an already-parsed document.
pub fn extract_metadata_from_document(
  document: &NodeRef,
) -> Result<HashMap<String, Value>, Box<dyn std::error::Error + Send + Sync>> {
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

const EXCLUDE_NON_MAIN_TAGS: [&str; 97] = [
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
  "[id*=\"sidebar\" i]",
  ".modal",
  ".popup",
  "#modal",
  ".overlay",
  ".popover",
  ".s-popover",
  ".tooltip",
  ".ad",
  ".ads",
  ".advert",
  "#ad",
  "[class*=\"billboard\" i]",
  ".crayons-bb",
  ".lang-selector",
  ".language",
  "#language-selector",
  ".social",
  ".social-media",
  ".social-links",
  ".social-share",
  ".share-buttons",
  ".article-share",
  ".post-share",
  "#social",
  ".menu",
  ".navigation",
  "#nav",
  ".breadcrumb",
  ".breadcrumbs",
  "#breadcrumbs",
  ".pagination",
  ".pager",
  ".share",
  "#share",
  ".widget",
  "#widget",
  ".related-posts",
  ".related-articles",
  ".related-content",
  ".recommended-posts",
  ".popular-posts",
  "#related-posts",
  ".PopularPosts",
  ".newsletter",
  ".subscribe-box",
  ".signup-prompt",
  "[class*=\"signedOutBanner\" i]",
  "[class*=\"copy-feedback\" i]",
  ".js-bottom-notice",
  ".js-post-menu",
  ".post-menu",
  ".js-voting-container",
  "[data-testid=\"issue-viewer-metadata-container\"]",
  "[data-testid=\"headerSignUpButton\"]",
  ".comment-respond",
  "#respond",
  ".comments-area",
  "#substack-comments",
  "#add-comment-block",
  "#wpdcom",
  "article section#comments",
  ".toc",
  "#toc",
  ".table-of-contents",
  "[aria-label=\"Table of contents\" i]",
  "[aria-label=\"On this page\" i]",
  ".sr-only",
  ".visually-hidden",
  ".screen-reader-text",
  ".skip-link",
  ".skip-to-content",
  "devsite-feedback",
  "devsite-page-rating",
  ".devsite-content-data",
  "awsdocs-page-header-container",
  "awsdocs-thumb-feedback",
  ".fc-decoration",
  ".grecaptcha-badge",
  "[data-original-tag=\"iframe\"][src*=\"google.com/recaptcha/\"]",
  "[data-original-tag=\"iframe\"][src*=\"recaptcha.net/recaptcha/\"]",
  "[data-original-tag=\"iframe\"][src*=\"hcaptcha.com\"]",
];

const EXCLUDE_ALWAYS_CHROME_SELECTORS: [&str; 37] = [
  "dialog",
  "svg",
  "tool-tip",
  "[role=\"dialog\"]",
  "[role=\"alertdialog\"]",
  "[role=\"tooltip\"]",
  "[role=\"navigation\"]",
  "[role=\"banner\"]",
  "[role=\"contentinfo\"]",
  "[role=\"complementary\"]",
  "[role=\"search\"]",
  "[role=\"menu\"]",
  "[role=\"menubar\"]",
  "[role=\"toolbar\"]",
  ".cookie",
  "#cookie",
  "[aria-label=\"Cookie consent\" i]",
  "#onetrust-consent-sdk",
  "#onetrust-banner-sdk",
  "#CybotCookiebotDialog",
  "#truste-consent-track",
  "#consent_blackbar",
  "#osano-cm-window",
  ".cky-consent-container",
  ".cky-modal",
  ".cky-preference-center",
  "[id*=\"cookie-consent\" i]",
  "[id*=\"cookie-banner\" i]",
  "[id*=\"cookie-notice\" i]",
  "[id*=\"cookie-modal\" i]",
  "[class*=\"cookie-consent\" i]",
  "[class*=\"cookie-banner\" i]",
  "[class*=\"cookie-notice\" i]",
  "[class*=\"cookie-modal\" i]",
  "[class*=\"consent-banner\" i]",
  "[class*=\"awsccc-\"]",
  "[data-original-tag=\"iframe\"][src*=\"challenges.cloudflare.com\"]",
];

// Inlined documents of embedded players hold only player chrome, never page content.
const EMPTY_NON_MAIN_FRAMES: [&str; 3] = [
  "[data-original-tag=\"iframe\"][src*=\"player.vimeo.com/\"]",
  "[data-original-tag=\"iframe\"][src*=\"youtube.com/embed/\"]",
  "[data-original-tag=\"iframe\"][src*=\"youtube-nocookie.com/embed/\"]",
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

const PROTECTED_CONTENT_SELECTORS: [&str; 5] = [
  "main",
  "article",
  "[role=\"main\"]",
  ".entry-content",
  ".post-body",
];

fn lang_from_url(url: &Url) -> &'static str {
  let filename = url
    .path()
    .rsplit('/')
    .next()
    .unwrap_or("")
    .to_ascii_lowercase();
  if filename == "dockerfile" || filename.starts_with("dockerfile.") {
    return "dockerfile";
  }
  let ext = filename.rsplit_once('.').map(|(_, e)| e).unwrap_or("");
  match ext {
    "rs" => "rust",
    "py" => "python",
    "ts" | "mts" | "cts" => "typescript",
    "tsx" => "tsx",
    "js" | "mjs" | "cjs" => "javascript",
    "jsx" => "jsx",
    "go" => "go",
    "java" => "java",
    "kt" | "kts" => "kotlin",
    "swift" => "swift",
    "c" | "h" => "c",
    "cc" | "cpp" | "cxx" | "hpp" | "hh" => "cpp",
    "cs" => "csharp",
    "rb" => "ruby",
    "php" => "php",
    "sh" | "bash" | "zsh" => "bash",
    "json" | "jsonc" => "json",
    "yaml" | "yml" => "yaml",
    "toml" => "toml",
    "xml" | "plist" => "xml",
    "html" | "htm" => "html",
    "css" => "css",
    "scss" => "scss",
    "sql" => "sql",
    "proto" => "protobuf",
    "tf" | "hcl" => "hcl",
    "dockerfile" => "dockerfile",
    _ => "",
  }
}

fn lang_from_class(class_str: &str) -> Option<String> {
  for part in class_str.split_whitespace() {
    let lower = part.to_ascii_lowercase();
    if let Some(lang) = lower.strip_prefix("language-") {
      if !lang.is_empty()
        && lang
          .chars()
          .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
      {
        return Some(lang.to_string());
      }
    }
    if let Some(lang) = lower.strip_prefix("lang-") {
      if !lang.is_empty()
        && lang
          .chars()
          .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
      {
        return Some(lang.to_string());
      }
    }
    if let Some(lang) = lower.strip_prefix("brush:") {
      let lang = lang.trim_matches(';');
      if !lang.is_empty()
        && lang
          .chars()
          .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
      {
        return Some(lang.to_string());
      }
    }
  }
  None
}

fn build_pre_code(code_text: &str, lang: &str, is_viewer: bool) -> Option<NodeRef> {
  let clean_lang: String = lang
    .chars()
    .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
    .collect();
  let html = if clean_lang.is_empty() {
    if is_viewer {
      "<pre data-fc-code-viewer=\"1\"><code></code></pre>".to_string()
    } else {
      "<pre><code></code></pre>".to_string()
    }
  } else if is_viewer {
    format!("<pre data-fc-code-viewer=\"1\"><code class=\"language-{clean_lang}\"></code></pre>")
  } else {
    format!("<pre><code class=\"language-{clean_lang}\"></code></pre>")
  };
  let frag = parse_html().one(html.as_str()).document_node;
  let pre = frag.select_first("pre").ok()?.as_node().clone();
  let code = pre.select_first("code").ok()?.as_node().clone();
  let normalized = code_text.replace('\u{00a0}', " ");
  code.append(NodeRef::new_text(normalized));
  pre.detach();
  Some(pre)
}

fn has_gutter_class(class_str: &str) -> bool {
  let lower = class_str.to_ascii_lowercase();
  lower.split_whitespace().any(|tok| {
    tok == "gutter"
      || tok == "linenos"
      || tok == "blob-num"
      || tok == "hljs-ln-numbers"
      || tok == "hljs-ln-n"
      || tok.contains("linenum")
      || tok.contains("line-num")
      || tok.contains("line-gutter")
  })
}

fn has_code_cell_class(class_str: &str) -> bool {
  let lower = class_str.to_ascii_lowercase();
  lower.split_whitespace().any(|tok| {
    tok == "code"
      || tok == "source"
      || tok == "blob-code"
      || tok == "blob-code-inner"
      || tok == "js-file-line"
      || tok == "hljs-ln-code"
      || tok.contains("linecontents")
      || tok.contains("line-content")
  })
}

fn has_ancestor_tag(node: &NodeRef, tag_name: &str) -> bool {
  let mut cur = node.parent();
  while let Some(p) = cur {
    if let Some(el) = p.as_element() {
      if el.name.local.as_ref().eq_ignore_ascii_case(tag_name) {
        return true;
      }
    }
    cur = p.parent();
  }
  false
}

fn is_collapsible_or_tabpanel(node: &NodeRef) -> bool {
  if has_ancestor_tag(node, "details") {
    return true;
  }
  let mut cur = Some(node.clone());
  while let Some(n) = cur {
    if let Some(el) = n.as_element() {
      let tag = el.name.local.as_ref();
      if tag.ends_with("-tabs") || tag.contains("expandable") {
        return true;
      }
      let attrs = el.attributes.borrow();
      if attrs
        .get("role")
        .is_some_and(|r| r.eq_ignore_ascii_case("tabpanel"))
        || attrs.get("tab-id").is_some()
      {
        return true;
      }
      if attrs.get("class").is_some_and(|c| {
        let l = c.to_ascii_lowercase();
        l.contains("tab-content") || l.contains("tabpanel") || l.contains("collapsible")
      }) {
        return true;
      }
    }
    cur = n.parent();
  }
  false
}

fn is_sidebar_layout_class(class_str: &str) -> bool {
  for tok in class_str.split_whitespace() {
    let lower = tok.to_ascii_lowercase();
    if !lower.contains("sidebar") {
      continue;
    }
    if lower.contains(':')
      || lower.starts_with("bg-")
      || lower.starts_with("text-")
      || lower.starts_with("border-")
      || lower.starts_with("ring-")
      || lower.starts_with("fill-")
      || lower.starts_with("stroke-")
      || lower.starts_with("shadow-")
      || lower.starts_with("from-")
      || lower.starts_with("to-")
      || lower.starts_with("via-")
      || lower.starts_with("has-")
      || lower.starts_with("with-")
      || lower.contains("-with-sidebar")
      || lower.contains("has-sidebar")
    {
      continue;
    }
    return true;
  }
  false
}

fn is_inline_hidden(style: &str) -> bool {
  for decl in style.split(';') {
    if let Some((prop, val)) = decl.split_once(':') {
      let prop = prop.trim();
      let val = val.trim().trim_end_matches("!important").trim();
      if (prop.eq_ignore_ascii_case("display") && val.eq_ignore_ascii_case("none"))
        || (prop.eq_ignore_ascii_case("visibility") && val.eq_ignore_ascii_case("hidden"))
      {
        return true;
      }
    }
  }
  false
}

fn non_ws_len(node: &NodeRef) -> usize {
  node
    .text_contents()
    .chars()
    .filter(|c| !c.is_whitespace())
    .count()
}

fn normalize_code_blocks(document: &NodeRef, url: &Url) {
  if let Ok(origins) = document.select("pre.enlighter-origin, pre.EnlighterJSRAW") {
    let origins: Vec<_> = origins.collect();
    if !origins.is_empty() {
      for origin in origins {
        let lang = origin
          .attributes
          .borrow()
          .get("data-enlighter-language")
          .map(|s| s.trim().to_ascii_lowercase())
          .filter(|s| !s.is_empty() && s != "generic" && s != "null" && s != "raw");
        if let Some(l) = lang {
          let mut attrs = origin.attributes.borrow_mut();
          let existing = attrs.get("class").unwrap_or("").to_string();
          if !existing.contains("language-") {
            attrs.insert("class", format!("{existing} language-{l}"));
          }
        }
      }
      if let Ok(dups) = document.select(".enlighter-default") {
        let dups: Vec<_> = dups.collect();
        for d in dups {
          d.as_node().detach();
        }
      }
    }
  }

  // Strip `line-numbers` from <pre> because Go's RobustCodeBlock treats any node
  // whose class contains "line-numbers" as a gutter and drops the entire code block.
  if let Ok(pres) = document.select("pre") {
    let pres: Vec<_> = pres.collect();
    for pre in pres {
      let node = pre.as_node();
      for sel in [
        ".line-numbers-rows",
        "button",
        "svg",
        "[role=\"button\"]",
        "[class*=\"copy-btn\" i]",
        "[class*=\"copy-button\" i]",
        ".highlight__panel",
      ] {
        if let Ok(junk) = node.select(sel) {
          let junk: Vec<_> = junk.collect();
          for j in junk {
            j.as_node().detach();
          }
        }
      }
      let new_class = {
        let attrs = pre.attributes.borrow();
        attrs.get("class").and_then(|cls| {
          let parts: Vec<&str> = cls.split_whitespace().collect();
          if parts.iter().any(|p| p.eq_ignore_ascii_case("line-numbers")) {
            Some(
              parts
                .into_iter()
                .filter(|p| !p.eq_ignore_ascii_case("line-numbers"))
                .collect::<Vec<_>>()
                .join(" "),
            )
          } else {
            None
          }
        })
      };
      if let Some(new_cls) = new_class {
        pre.attributes.borrow_mut().insert("class", new_cls);
      }
    }
  }

  if let Ok(textareas) = document.select(
    "textarea#read-only-cursor-text-area, textarea[data-testid=\"read-only-cursor-text-area\"]",
  ) {
    let textareas: Vec<_> = textareas.collect();
    for ta in textareas {
      let code_text = ta.as_node().text_contents();
      if code_text.trim().is_empty() {
        continue;
      }
      let lang = lang_from_url(url);
      if let Some(pre) = build_pre_code(&code_text, lang, true) {
        ta.as_node().insert_before(pre);
        ta.as_node().detach();
      }
    }
  }

  if let Ok(tables) = document.select("table") {
    let tables: Vec<_> = tables.collect();
    for tbl in tables {
      let tbl_node = tbl.as_node();
      if has_ancestor_tag(tbl_node, "pre") || tbl_node.parent().is_none() {
        continue;
      }
      if tbl_node
        .select("th")
        .is_ok_and(|mut it| it.next().is_some())
      {
        continue;
      }

      let trs: Vec<_> = match tbl_node.select("tr") {
        Ok(it) => it
          .filter(|tr| {
            let mut cur = tr.as_node().parent();
            while let Some(p) = cur {
              if p == *tbl_node {
                return true;
              }
              if let Some(el) = p.as_element() {
                if el.name.local.as_ref().eq_ignore_ascii_case("table") {
                  return false;
                }
              }
              cur = p.parent();
            }
            false
          })
          .collect(),
        Err(_) => continue,
      };
      if trs.is_empty() {
        continue;
      }

      let mut lang = tbl
        .attributes
        .borrow()
        .get("class")
        .and_then(lang_from_class)
        .unwrap_or_default();
      if lang.is_empty() {
        if let Some(parent) = tbl_node.parent().and_then(|p| p.into_element_ref()) {
          if let Some(l) = parent
            .attributes
            .borrow()
            .get("class")
            .and_then(lang_from_class)
          {
            lang = l;
          }
        }
      }

      if trs.len() == 1 {
        let tds: Vec<_> = trs[0]
          .as_node()
          .children()
          .filter_map(|c| c.into_element_ref())
          .filter(|e| e.name.local.as_ref().eq_ignore_ascii_case("td"))
          .collect();
        if tds.len() == 2 {
          let c0_cls = tds[0]
            .attributes
            .borrow()
            .get("class")
            .unwrap_or("")
            .to_string();
          let c1_cls = tds[1]
            .attributes
            .borrow()
            .get("class")
            .unwrap_or("")
            .to_string();
          if has_gutter_class(&c0_cls)
            && (has_code_cell_class(&c1_cls)
              || tds[1]
                .as_node()
                .select("pre, .line")
                .is_ok_and(|mut it| it.next().is_some()))
          {
            let code_text = if let Ok(pre_el) = tds[1].as_node().select_first("pre") {
              if lang.is_empty() {
                if let Some(l) = pre_el
                  .attributes
                  .borrow()
                  .get("class")
                  .and_then(lang_from_class)
                {
                  lang = l;
                }
              }
              pre_el.as_node().text_contents()
            } else if let Ok(line_els) = tds[1].as_node().select(".line") {
              let lines: Vec<String> = line_els
                .map(|l| l.as_node().text_contents().replace('\r', ""))
                .collect();
              if !lines.is_empty() {
                lines.join("\n")
              } else {
                tds[1].as_node().text_contents()
              }
            } else {
              tds[1].as_node().text_contents()
            };

            if !code_text.trim().is_empty() {
              if let Some(pre) = build_pre_code(&code_text, &lang, false) {
                tbl_node.insert_before(pre);
                tbl_node.detach();
              }
            }
          }
        }
        continue;
      }

      let mut matched_rows = 0usize;
      let mut lines: Vec<String> = Vec::with_capacity(trs.len());
      for tr in &trs {
        let tds: Vec<_> = tr
          .as_node()
          .children()
          .filter_map(|c| c.into_element_ref())
          .filter(|e| e.name.local.as_ref().eq_ignore_ascii_case("td"))
          .collect();
        if tds.len() != 2 {
          continue;
        }
        let c0_is_gutter = {
          let attrs = tds[0].attributes.borrow();
          attrs.get("data-line-number").is_some()
            || attrs.get("class").is_some_and(has_gutter_class)
        };
        let c1_is_code = tds[1]
          .attributes
          .borrow()
          .get("class")
          .is_some_and(has_code_cell_class);
        if c0_is_gutter
          && (c1_is_code || tds[0].attributes.borrow().get("data-line-number").is_some())
        {
          matched_rows += 1;
          let raw = tds[1].as_node().text_contents().replace('\r', "");
          let line = raw.strip_prefix('\n').unwrap_or(&raw);
          let line = line.strip_suffix('\n').unwrap_or(line);
          lines.push(line.to_string());
        }
      }

      if matched_rows >= 2 && matched_rows * 10 >= trs.len() * 7 {
        if lang.is_empty() {
          lang = lang_from_url(url).to_string();
        }
        let code_text = lines.join("\n");
        if let Some(pre) = build_pre_code(&code_text, &lang, false) {
          tbl_node.insert_before(pre);
          tbl_node.detach();
        }
      }
    }
  }
}

fn is_boilerplate_section_heading(text: &str) -> bool {
  let clean: String = text
    .split_whitespace()
    .collect::<Vec<_>>()
    .join(" ")
    .to_ascii_lowercase();
  let trimmed = clean.trim_end_matches([':', '?', '!']);
  matches!(
    trimmed,
    "related posts"
      | "related articles"
      | "related guides"
      | "related courses"
      | "related tools"
      | "related questions"
      | "related topics"
      | "related reading"
      | "recommended posts"
      | "recommended articles"
      | "recommended reading"
      | "you might also like"
      | "you may also like"
      | "you might also like this video"
      | "popular posts"
      | "recent posts"
      | "featured tool"
      | "did this page help you"
      | "was this page helpful"
      | "leave a reply"
      | "leave a comment"
      | "top comments (0)"
      | "explore related questions"
      | "subscribe to our newsletter"
      | "sign up for our newsletter"
      | "share this article"
      | "share this post"
      | "recently added to this guide"
  )
}

fn clean_inline_chrome_and_boilerplate(document: &NodeRef) {
  // Serialized Shadow DOM places <span part="root"> beside light-DOM fallback text, doubling dates.
  if let Ok(rts) = document.select("relative-time") {
    let rts: Vec<_> = rts.collect();
    for rt in rts {
      let node = rt.as_node();
      let has_direct_text = node
        .children()
        .any(|c| c.as_text().is_some_and(|t| !t.borrow().trim().is_empty()));
      if has_direct_text {
        if let Ok(roots) = node.select("span[part=\"root\"]") {
          let roots: Vec<_> = roots.collect();
          for r in roots {
            r.as_node().detach();
          }
        }
      }
    }
  }

  // Empty fragment anchors cause html-to-markdown to emit aria-label ("Permalink: ...", "Skip link to ...").
  if let Ok(anchors) = document.select("a[href]") {
    let anchors: Vec<_> = anchors.collect();
    for a in anchors {
      let node = a.as_node();
      if node.parent().is_none() || has_ancestor_tag(node, "pre") {
        continue;
      }
      if non_ws_len(node) > 0 || node.select("img").is_ok_and(|mut it| it.next().is_some()) {
        continue;
      }
      let is_fragment_or_permalink = {
        let attrs = a.attributes.borrow();
        let href = attrs.get("href").unwrap_or("");
        let cls = attrs.get("class").unwrap_or("").to_ascii_lowercase();
        let aria = attrs.get("aria-label").unwrap_or("").to_ascii_lowercase();
        href.starts_with('#')
          || href.contains('#')
            && (cls.contains("anchor")
              || cls.contains("permalink")
              || cls.contains("hash-link")
              || cls.contains("heading-link")
              || aria.starts_with("permalink")
              || aria.starts_with("skip link")
              || aria.starts_with("direct link"))
      };
      if is_fragment_or_permalink {
        node.detach();
      }
    }
  }

  let root_len = document
    .select_first("body")
    .ok()
    .map(|b| non_ws_len(b.as_node()))
    .unwrap_or(0);
  if root_len < 150 {
    return;
  }

  if let Ok(containers) = document.select("section, div") {
    let containers: Vec<_> = containers.collect();
    for el in containers {
      let node = el.as_node();
      if node.parent().is_none() {
        continue;
      }
      if node
        .select("h1, article, main, pre, table, [role=\"main\"]")
        .is_ok_and(|mut it| it.next().is_some())
      {
        continue;
      }
      let el_len = non_ws_len(node);
      if el_len == 0 || el_len * 100 >= root_len * 65 {
        continue;
      }
      let lead_text = node
        .children()
        .filter_map(|c| c.into_element_ref())
        .find(|c| non_ws_len(c.as_node()) > 0)
        .map(|c| {
          let tag = c.name.local.as_ref();
          if matches!(tag, "h2" | "h3" | "h4" | "h5" | "h6" | "p" | "header") {
            c.as_node().text_contents()
          } else {
            c.as_node()
              .select_first("h2, h3, h4, h5, h6")
              .ok()
              .map(|h| h.as_node().text_contents())
              .unwrap_or_default()
          }
        })
        .unwrap_or_default();

      if !lead_text.is_empty()
        && lead_text.len() <= 80
        && is_boilerplate_section_heading(&lead_text)
      {
        node.detach();
      }
    }
  }
}

fn scope_to_main_content(document: &NodeRef) {
  let Some(body) = document.select_first("body").ok() else {
    return;
  };
  let body_node = body.as_node();

  let mut scoped_to_main = false;
  let main_candidate = document
    .select("main")
    .ok()
    .into_iter()
    .flatten()
    .filter(|m| !has_ancestor_tag(m.as_node(), "main"))
    .max_by_key(|m| non_ws_len(m.as_node()))
    .filter(|m| non_ws_len(m.as_node()) >= 150)
    .or_else(|| {
      document
        .select("[role=\"main\"]")
        .ok()
        .into_iter()
        .flatten()
        .max_by_key(|m| non_ws_len(m.as_node()))
        .filter(|m| non_ws_len(m.as_node()) >= 150)
    });

  if let Some(main_el) = main_candidate {
    let main_node = main_el.as_node().clone();
    if main_node != *body_node {
      main_node.detach();
      while let Some(child) = body_node.first_child() {
        child.detach();
      }
      body_node.append(main_node);
      scoped_to_main = true;
    }
  }

  let root_len = non_ws_len(body_node);
  if root_len == 0 {
    return;
  }

  if let Ok(viewer_pre) = body_node.select_first("pre[data-fc-code-viewer=\"1\"]") {
    let pre_node = viewer_pre.as_node().clone();
    let pre_len = non_ws_len(&pre_node);
    if pre_len >= 300 && pre_len * 100 >= root_len * 30 {
      let h1_node = body_node
        .select_first("h1")
        .ok()
        .map(|h| h.as_node().clone())
        .filter(|h| {
          let l = non_ws_len(h);
          (1..=250).contains(&l)
        });
      if let Some(ref h) = h1_node {
        h.detach();
      }
      pre_node.detach();
      while let Some(child) = body_node.first_child() {
        child.detach();
      }
      if let Some(h) = h1_node {
        body_node.append(h);
      }
      body_node.append(pre_node);
      return;
    }
  }

  let top_articles: Vec<_> = body_node
    .select("article")
    .ok()
    .into_iter()
    .flatten()
    .filter(|a| !has_ancestor_tag(a.as_node(), "article"))
    .collect();

  if top_articles.len() == 1 {
    let art_node = top_articles[0].as_node().clone();
    let art_len = non_ws_len(&art_node);
    let dominant = if scoped_to_main {
      art_len >= 300 && (art_len * 100 >= root_len * 25 || art_len >= 1000)
    } else {
      art_len >= 300 && art_len * 100 >= root_len * 35
    };
    if dominant {
      let art_has_h1 = art_node
        .select_first("h1")
        .is_ok_and(|h| non_ws_len(h.as_node()) >= 2);
      let external_h1 = if !art_has_h1 {
        body_node
          .select("h1")
          .ok()
          .into_iter()
          .flatten()
          .map(|h| h.as_node().clone())
          .find(|h| {
            let l = non_ws_len(h);
            (2..=250).contains(&l)
          })
      } else {
        None
      };

      if let Some(ref h) = external_h1 {
        h.detach();
      }
      art_node.detach();
      while let Some(child) = body_node.first_child() {
        child.detach();
      }
      if let Some(h) = external_h1 {
        body_node.append(h);
      }
      body_node.append(art_node);
    }
  }
}

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
  let document = parse_html().one(opts.html.as_ref()).document_node;
  Ok(transform_document(document, &opts)?.to_string())
}

/// Clean an already-parsed document with the same rules as `transform_html`,
/// without parsing it again. `opts.html` is ignored.
pub fn transform_document(
  mut document: NodeRef,
  opts: &TransformHtmlOptions,
) -> Result<NodeRef, Box<dyn std::error::Error + Send + Sync>> {
  let url = Url::parse(&_extract_base_href_from_document(
    &document,
    &Url::parse(&opts.url)?,
  )?)?;

  if !opts.include_tags.is_empty() {
    let new_document = parse_html().one("<div></div>").document_node;
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
  while let Ok(x) = document.select_first("template") {
    x.as_node().detach();
  }

  normalize_code_blocks(&document, &url);

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
    let has_force_include = |node: &NodeRef| -> bool {
      FORCE_INCLUDE_MAIN_TAGS
        .iter()
        .any(|sel| node.select(sel).is_ok_and(|mut it| it.next().is_some()))
    };
    let has_protected_content = |node: &NodeRef| -> bool {
      PROTECTED_CONTENT_SELECTORS
        .iter()
        .any(|sel| node.select(sel).is_ok_and(|mut it| it.next().is_some()))
    };

    for sel in EXCLUDE_ALWAYS_CHROME_SELECTORS.iter() {
      let matches: Vec<_> = document
        .select(sel)
        .map_err(|_| "Failed to select chrome tags")?
        .collect();
      for tag in matches {
        let node = tag.as_node();
        if node.parent().is_none() || has_ancestor_tag(node, "pre") {
          continue;
        }
        if !has_force_include(node) && !has_protected_content(node) {
          node.detach();
        }
      }
    }

    if let Ok(hidden_els) = document.select("[hidden]") {
      let hidden_els: Vec<_> = hidden_els.collect();
      for el in hidden_els {
        let node = el.as_node();
        if node.parent().is_none()
          || has_ancestor_tag(node, "pre")
          || is_collapsible_or_tabpanel(node)
        {
          continue;
        }
        if !has_force_include(node) && !has_protected_content(node) {
          node.detach();
        }
      }
    }

    if let Ok(styled) = document.select("[style]") {
      let styled: Vec<_> = styled.collect();
      for el in styled {
        let node = el.as_node();
        if node.parent().is_none()
          || has_ancestor_tag(node, "pre")
          || is_collapsible_or_tabpanel(node)
        {
          continue;
        }
        let hidden = el
          .attributes
          .borrow()
          .get("style")
          .is_some_and(is_inline_hidden);
        if hidden && !has_force_include(node) && !has_protected_content(node) {
          node.detach();
        }
      }
    }

    if let Ok(aria_hidden) = document.select("[aria-hidden=\"true\"]") {
      let aria_hidden: Vec<_> = aria_hidden.collect();
      for el in aria_hidden {
        let node = el.as_node();
        if node.parent().is_none()
          || has_ancestor_tag(node, "pre")
          || has_ancestor_tag(node, "code")
          || has_ancestor_tag(node, "math")
        {
          continue;
        }
        let is_math_or_code = el.attributes.borrow().get("class").is_some_and(|c| {
          let l = c.to_ascii_lowercase();
          l.contains("katex") || l.contains("mathjax") || l.contains("mjx")
        }) || node
          .select("pre, code, math, .katex, .MathJax")
          .is_ok_and(|mut it| it.next().is_some());
        if !is_math_or_code && !has_force_include(node) && !has_protected_content(node) {
          node.detach();
        }
      }
    }

    for sel in ["select", "input", "textarea"] {
      if let Ok(controls) = document.select(sel) {
        let controls: Vec<_> = controls.collect();
        for el in controls {
          if !has_ancestor_tag(el.as_node(), "pre") {
            el.as_node().detach();
          }
        }
      }
    }
    if let Ok(buttons) = document.select("button") {
      let buttons: Vec<_> = buttons.collect();
      for btn in buttons {
        let node = btn.as_node();
        if node.parent().is_none() {
          continue;
        }
        let keeps_heading = node
          .select("h1, h2, h3, h4, h5, h6")
          .is_ok_and(|mut it| it.next().is_some());
        if !keeps_heading && non_ws_len(node) <= 150 && !has_force_include(node) {
          node.detach();
        }
      }
    }

    let body_total_len = document
      .select_first("body")
      .ok()
      .map(|b| non_ws_len(b.as_node()))
      .unwrap_or(0);

    if let Ok(forms) = document.select("form") {
      let forms: Vec<_> = forms.collect();
      for form in forms {
        let node = form.as_node();
        if node.parent().is_none() {
          continue;
        }
        let wraps_main = has_force_include(node)
          || has_protected_content(node)
          || node.select("h1").is_ok_and(|mut it| it.next().is_some())
          || (body_total_len > 0 && non_ws_len(node) * 100 >= body_total_len * 35);
        if !wraps_main {
          node.detach();
        }
      }
    }

    let body_len_after_forms = document
      .select_first("body")
      .ok()
      .map(|b| non_ws_len(b.as_node()))
      .unwrap_or(0);

    for sel in EXCLUDE_NON_MAIN_TAGS.iter() {
      let matches: Vec<_> = document
        .select(sel)
        .map_err(|_| "Failed to select tags")?
        .collect();
      let is_structural = matches!(*sel, "footer" | "nav" | "aside");
      for tag in matches {
        let node = tag.as_node();
        if node.parent().is_none() || has_ancestor_tag(node, "pre") {
          continue;
        }
        if *sel == "header" {
          let has_h1 = node.select("h1").is_ok_and(|mut it| it.next().is_some());
          let inside_article = has_ancestor_tag(node, "article");
          if has_h1 || (inside_article && node.select("h2").is_ok_and(|mut it| it.next().is_some()))
          {
            continue;
          }
        }
        if has_force_include(node) {
          continue;
        }
        if !is_structural {
          if has_protected_content(node) {
            continue;
          }
          if body_len_after_forms >= 400 && non_ws_len(node) * 100 >= body_len_after_forms * 40 {
            continue;
          }
        }
        node.detach();
      }
    }

    if let Ok(sidebar_els) = document.select("[class*=\"sidebar\" i]") {
      let sidebar_els: Vec<_> = sidebar_els.collect();
      for el in sidebar_els {
        let node = el.as_node();
        if node.parent().is_none()
          || has_ancestor_tag(node, "pre")
          || has_ancestor_tag(node, "code")
        {
          continue;
        }
        let is_sidebar = el
          .attributes
          .borrow()
          .get("class")
          .is_some_and(is_sidebar_layout_class);
        if !is_sidebar || has_force_include(node) || has_protected_content(node) {
          continue;
        }
        if body_len_after_forms >= 400 && non_ws_len(node) * 100 >= body_len_after_forms * 40 {
          continue;
        }
        node.detach();
      }
    }

    for x in EMPTY_NON_MAIN_FRAMES.iter() {
      let frames: Vec<_> = document
        .select(x)
        .map_err(|_| "Failed to select frames")?
        .collect();
      for frame in frames {
        while let Some(child) = frame.as_node().first_child() {
          child.detach();
        }
      }
    }

    if opts.include_tags.is_empty() {
      scope_to_main_content(&document);
    }

    clean_inline_chrome_and_boilerplate(&document);
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

  Ok(document)
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
  Ok(
    parse_html()
      .one(html)
      .document_node
      .select_first("body")?
      .text_contents(),
  )
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
  let document = parse_html().one(html).document_node;
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
  let document = parse_html().one(html).document_node;
  let base_url = Url::parse(base_url)?;
  let base_href = _extract_base_href_from_document(&document, &base_url)?;
  let base_href_url = Url::parse(&base_href)?;
  let mut images = HashSet::<String>::new();

  let resolve_image_url = |src: &str| -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    if src.trim().is_empty() {
      return Err("empty image URL".into());
    }
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

fn parse_fence_line(line: &str) -> Option<(u8, usize, &str)> {
  let bytes = line.as_bytes();
  let mut i = 0;
  while i < bytes.len() && (bytes[i] == b' ' || bytes[i] == b'\t') {
    i += 1;
  }
  if i >= bytes.len() || (bytes[i] != b'`' && bytes[i] != b'~') {
    return None;
  }
  let ch = bytes[i];
  let start = i;
  while i < bytes.len() && bytes[i] == ch {
    i += 1;
  }
  let count = i - start;
  if count >= 3 {
    Some((ch, count, &line[i..]))
  } else {
    None
  }
}

fn find_link_dest_end(s: &str, open_paren: usize) -> Option<usize> {
  let bytes = s.as_bytes();
  if open_paren >= bytes.len() || bytes[open_paren] != b'(' {
    return None;
  }
  let mut depth = 1usize;
  let mut i = open_paren + 1;
  while i < bytes.len() {
    match bytes[i] {
      b'\\' if i + 1 < bytes.len() => {
        i += 2;
        continue;
      }
      b'(' => depth += 1,
      b')' => {
        depth -= 1;
        if depth == 0 {
          return Some(i + 1);
        }
      }
      b'\n' => return None,
      _ => {}
    }
    i += 1;
  }
  None
}

fn find_matching_bracket(s: &str, open_bracket: usize) -> Option<usize> {
  let bytes = s.as_bytes();
  if open_bracket >= bytes.len() || bytes[open_bracket] != b'[' {
    return None;
  }
  let mut depth = 1usize;
  let mut i = open_bracket + 1;
  let mut code_ticks = 0usize;
  while i < bytes.len() {
    if bytes[i] == b'\\' && code_ticks == 0 && i + 1 < bytes.len() {
      i += 2;
      continue;
    }
    if bytes[i] == b'`' {
      let start = i;
      while i < bytes.len() && bytes[i] == b'`' {
        i += 1;
      }
      let ticks = i - start;
      if code_ticks == 0 {
        code_ticks = ticks;
      } else if code_ticks == ticks {
        code_ticks = 0;
      }
      continue;
    }
    if code_ticks == 0 {
      if bytes[i] == b'[' {
        depth += 1;
      } else if bytes[i] == b']' {
        depth -= 1;
        if depth == 0 {
          return Some(i);
        }
      }
    }
    i += 1;
  }
  None
}

fn is_skip_link_label(label: &str) -> bool {
  let trimmed = label.trim();
  trimmed.eq_ignore_ascii_case("skip to content")
    || trimmed.eq_ignore_ascii_case("skip to main content")
    || trimmed.eq_ignore_ascii_case("skip navigation")
    || trimmed.eq_ignore_ascii_case("skip to main")
}

fn is_permalink_noise_label(label: &str) -> bool {
  let trimmed = label.trim();
  trimmed.is_empty()
    || matches!(
      trimmed,
      "#" | "¶" | "§" | "🔗" | "Permalink" | "Direct link to heading"
    )
}

fn process_prose_segment(input: &str) -> String {
  let bytes = input.as_bytes();
  let len = bytes.len();
  let mut out = String::with_capacity(len);
  let mut i = 0usize;

  while i < len {
    if bytes[i] == b'`' {
      let start = i;
      while i < len && bytes[i] == b'`' {
        i += 1;
      }
      let ticks = i - start;
      let mut j = i;
      let mut found_end = None;
      while j < len {
        if bytes[j] == b'`' {
          let cs = j;
          while j < len && bytes[j] == b'`' {
            j += 1;
          }
          if j - cs == ticks {
            found_end = Some(j);
            break;
          }
        } else {
          j += 1;
        }
      }
      let end = found_end.unwrap_or(i);
      out.push_str(&input[start..end]);
      i = end;
      continue;
    }

    if bytes[i] == b'!' && i + 1 < len && bytes[i + 1] == b'[' {
      if let Some(close_b) = find_matching_bracket(input, i + 1) {
        if close_b + 1 < len && bytes[close_b + 1] == b'(' {
          if let Some(end_p) = find_link_dest_end(input, close_b + 1) {
            out.push_str(&input[i..end_p]);
            i = end_p;
            continue;
          }
        }
      }
    }

    if bytes[i] == b'[' {
      if let Some(close_b) = find_matching_bracket(input, i) {
        if close_b + 1 < len && bytes[close_b + 1] == b'(' {
          if let Some(end_p) = find_link_dest_end(input, close_b + 1) {
            let label = &input[i + 1..close_b];
            let dest = &input[close_b + 2..end_p - 1];

            if is_skip_link_label(label) && dest.contains('#') {
              i = end_p;
              continue;
            }

            if is_permalink_noise_label(label) {
              i = end_p;
              continue;
            }

            out.push('[');
            for ch in label.chars() {
              if ch == '\n' {
                out.push('\\');
                out.push('\n');
              } else {
                out.push(ch);
              }
            }
            out.push_str(&input[close_b..end_p]);
            i = end_p;
            continue;
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

/// The synchronous body of `post_process_markdown`.
pub fn post_process_markdown_text(markdown: &str) -> String {
  let mut out = String::with_capacity(markdown.len());
  let mut prose_buf = String::new();
  let mut active_fence: Option<(u8, usize)> = None;

  for segment in markdown.split_inclusive('\n') {
    let line_no_nl = segment.trim_end_matches(['\r', '\n']);

    if let Some((f_char, f_len)) = active_fence {
      out.push_str(segment);
      if let Some((c, n, rest)) = parse_fence_line(line_no_nl) {
        if c == f_char && n >= f_len && rest.trim().is_empty() {
          active_fence = None;
        }
      }
    } else if let Some((c, n, rest)) = parse_fence_line(line_no_nl) {
      if c == b'`' && rest.contains('`') {
        prose_buf.push_str(segment);
      } else {
        if !prose_buf.is_empty() {
          out.push_str(&process_prose_segment(&prose_buf));
          prose_buf.clear();
        }
        active_fence = Some((c, n));
        out.push_str(segment);
      }
    } else {
      prose_buf.push_str(segment);
    }
  }

  if !prose_buf.is_empty() {
    out.push_str(&process_prose_segment(&prose_buf));
  }

  out
}

/// Process multi-line links in markdown.
#[napi]
pub async fn post_process_markdown(markdown: String) -> napi::Result<String> {
  let res = task::spawn_blocking(move || post_process_markdown_text(&markdown))
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

  fn run_transform(html: &str, url: &str, only_main_content: bool) -> String {
    _transform_html_inner(TransformHtmlOptions {
      html: html.to_string(),
      url: url.to_string(),
      include_tags: vec![],
      exclude_tags: vec![],
      only_main_content,
      omce_signatures: None,
    })
    .expect("transform_html should succeed")
  }

  #[test]
  fn post_process_preserves_multiline_brackets_in_fenced_and_inline_code() {
    let md = "Intro [multi\nline](https://example.com) and `[a\nb]`.\n\n```json\n{\n  \"items\": [\n    \"one\",\n    \"two\"\n  ]\n}\n```\n\n1. Nested in list:\n\n    ```json\n    {\n      \"nested\": [\n        \"a\",\n        \"b\"\n      ]\n    }\n    ```\n";
    let out = post_process_markdown_text(md);
    assert!(out.contains("[multi\\\nline](https://example.com)"));
    assert!(out.contains("```json\n{\n  \"items\": [\n    \"one\",\n    \"two\"\n  ]\n}\n```"));
    assert!(!out.contains("\"one\",\\"));
    assert!(out.contains("    ```json\n    {\n      \"nested\": [\n        \"a\",\n        \"b\"\n      ]\n    }\n    ```"));
    assert!(!out.contains("\"a\",\\"));
  }

  #[test]
  fn post_process_removes_resolved_skip_links_and_permalinks() {
    let md = "[Skip to content](https://example.com/page#main)\n\n## API [#](https://example.com/page#api)\n\nSee [`foo`](https://example.com/foo) and ![icon](https://example.com/i.png).\n";
    let out = post_process_markdown_text(md);
    assert!(!out.contains("Skip to content"));
    assert!(!out.contains("[#]"));
    assert!(out.contains("[`foo`](https://example.com/foo)"));
    assert!(out.contains("![icon](https://example.com/i.png)"));
  }

  #[test]
  fn converts_gitiles_and_syntaxhighlighter_code_tables_to_pre_code() {
    let gitiles = r#"<html><body><table class="FileContents">
      <tr class="FileContents-line"><td class="FileContents-lineNum" data-line-number="1"></td><td class="FileContents-lineContents"><span>void</span> <span>Foo()</span> {</td></tr>
      <tr class="FileContents-line"><td class="FileContents-lineNum" data-line-number="2"></td><td class="FileContents-lineContents">  return;</td></tr>
      <tr class="FileContents-line"><td class="FileContents-lineNum" data-line-number="3"></td><td class="FileContents-lineContents">}</td></tr>
    </table></body></html>"#;
    let out = run_transform(gitiles, "https://example.googlesource.com/src/foo.cc", true);
    assert!(
      out.contains("<pre><code class=\"language-cpp\">void Foo() {\n  return;\n}</code></pre>")
    );
    assert!(!out.contains("<table"));

    let sh = r#"<html><body><table><tr>
      <td class="gutter"><div class="line">01</div><div class="line">02</div></td>
      <td class="code"><div class="line">let x = 1;</div><div class="line">&nbsp;&nbsp;return x;</div></td>
    </tr></table></body></html>"#;
    let out_sh = run_transform(sh, "https://example.com/post", true);
    assert!(out_sh.contains("<pre><code>let x = 1;\n  return x;</code></pre>"));
    assert!(!out_sh.contains("01"));

    let line_gutter = r#"<html><body><table>
      <tr><td class="code-block-line-gutter">1</td><td class="code">const a = 1;</td></tr>
      <tr><td class="code-block-line-gutter">2</td><td class="code">const b = 2;</td></tr>
    </table></body></html>"#;
    let out_lg = run_transform(line_gutter, "https://example.com/app.ts", true);
    assert!(out_lg.contains(
      "<pre><code class=\"language-typescript\">const a = 1;\nconst b = 2;</code></pre>"
    ));
    assert!(!out_lg.contains("<table"));
  }

  #[test]
  fn normalizes_prism_line_numbers_enlighter_and_blob_viewer_textarea() {
    let prism = r#"<html><body>
      <pre class="line-numbers language-ts"><button>Copy</button><code>const a = 1;</code><span class="line-numbers-rows"><span></span></span></pre>
    </body></html>"#;
    let out_prism = run_transform(prism, "https://example.com/guide", true);
    assert!(out_prism.contains("class=\"language-ts\""));
    assert!(!out_prism.contains("line-numbers"));
    assert!(!out_prism.contains("Copy"));

    let enlighter = r#"<html><body>
      <pre class="EnlighterJSRAW" data-enlighter-language="python">def greet():
    return "hi"</pre>
      <div class="enlighter-default"><span>def greet():</span></div>
    </body></html>"#;
    let out_enlighter = run_transform(enlighter, "https://example.com/py", true);
    assert!(out_enlighter.contains("language-python"));
    assert!(!out_enlighter.contains("enlighter-default"));

    let blob = r#"<html><body>
      <textarea id="read-only-cursor-text-area">FROM alpine:3.20</textarea>
    </body></html>"#;
    let out_blob = run_transform(
      blob,
      "https://github.com/org/repo/blob/main/Dockerfile",
      true,
    );
    assert!(out_blob.contains("<pre data-fc-code-viewer=\"1\"><code class=\"language-dockerfile\">FROM alpine:3.20</code></pre>"));
    assert!(!out_blob.contains("<textarea"));
  }

  #[test]
  fn preserves_article_header_details_and_strips_chrome_and_boilerplate() {
    let html = r#"<html><body>
      <div id="onetrust-consent-sdk" role="dialog">Cookie Preferences</div>
      <div role="navigation"><a href="/home">Home</a></div>
      <main>
        <article>
          <header><h1>Guide Title</h1></header>
          <p>Main article body with enough words to exceed the minimum length threshold for scoping cleanly in tests and real pages alike. Adding more text here so the article dominates the page comfortably.</p>
          <details><div style="display: none"><p>Hidden flag details inside collapsible section.</p></div></details>
          <div role="tabpanel" hidden><p>Inactive tab panel documentation.</p></div>
        </article>
        <section><h2>Related Posts</h2><a href="/other">Other</a></section>
      </main>
    </body></html>"#;
    let out = run_transform(html, "https://example.com/guide", true);
    assert!(out.contains("<h1>Guide Title</h1>"));
    assert!(out.contains("Hidden flag details inside collapsible section."));
    assert!(out.contains("Inactive tab panel documentation."));
    assert!(!out.contains("Cookie Preferences"));
    assert!(!out.contains("Related Posts"));
    assert!(!out.contains("Home"));
  }

  #[test]
  fn protects_tailwind_sidebar_utility_and_short_form_pages() {
    let tw = r#"<html><body><main><pre><div class="bg-token-sidebar-surface-primary">const keep = true;</div></pre></main></body></html>"#;
    let out_tw = run_transform(tw, "https://example.com/forum", true);
    assert!(out_tw.contains("const keep = true;"));

    let form_page = r#"<html><body><h2>Contact</h2><form><p>Fill out your name, email, and company details to contact support.</p></form></body></html>"#;
    let out_form = run_transform(form_page, "https://example.com/form.html", true);
    assert!(out_form.contains("Fill out your name"));
  }

  #[test]
  fn deduplicates_relative_time_shadow_span_and_drops_empty_permalink_anchors() {
    let html = r##"<html><body><main>
      <h1>Docs <a aria-label="Permalink: Docs" class="anchor" href="#docs"><svg><title>link</title></svg></a></h1>
      <p>Updated <relative-time datetime="2026-01-01"><span part="root">on Jan 1, 2026</span>on Jan 1, 2026</relative-time>.</p>
    </main></body></html>"##;
    let out = run_transform(html, "https://example.com/docs", true);
    assert!(!out.contains("Permalink: Docs"));
    assert_eq!(out.matches("on Jan 1, 2026").count(), 1);
  }
}
