//! Pure-Rust sitemap XML parsing and instruction generation.

use std::borrow::Cow;

use serde::Serialize;
use url::Url;

use crate::crawler::is_file;
use crate::sitemap_lenient::parse_sitemap_lenient;
use crate::xml::exceeds_element_depth;

/// Sitemaps nest a handful of levels; anything deeper is malformed.
pub(crate) const MAX_SITEMAP_DEPTH: usize = 32;

#[derive(Debug, Clone, Serialize)]
pub struct SitemapUrl {
  pub loc: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SitemapEntry {
  pub loc: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SitemapUrlset {
  pub url: Vec<SitemapUrl>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SitemapIndex {
  pub sitemap: Vec<SitemapEntry>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ParsedSitemap {
  pub urlset: Option<SitemapUrlset>,
  pub sitemapindex: Option<SitemapIndex>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SitemapInstruction {
  pub action: String,
  pub urls: Vec<String>,
  pub count: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct SitemapProcessingResult {
  pub instructions: Vec<SitemapInstruction>,
  pub total_count: u32,
}

pub(crate) enum ParseOutcome {
  InvalidRoot,
  XmlError(String),
}

/// Parse XML sitemap content into structured data.
pub fn parse_sitemap_xml(xml_content: &str) -> Result<ParsedSitemap, String> {
  let cleaned = clean_xml_input(xml_content);
  if exceeds_element_depth(&cleaned, MAX_SITEMAP_DEPTH) {
    return Err(format!(
      "XML parsing error: elements nested deeper than {MAX_SITEMAP_DEPTH} levels"
    ));
  }
  // Entity replacement text can carry nested markup the depth scan never sees.
  if cleaned.contains("<!ENTITY") {
    return Err("XML parsing error: entity declarations are not supported".to_string());
  }

  match parse_with_roxmltree(&cleaned) {
    Ok(parsed) => Ok(parsed),
    Err(ParseOutcome::InvalidRoot) => {
      Err("Invalid sitemap format: root element must be 'sitemapindex' or 'urlset'".to_string())
    }
    Err(ParseOutcome::XmlError(primary_err)) => match parse_sitemap_lenient(&cleaned) {
      Ok(parsed) => Ok(parsed),
      Err(ParseOutcome::InvalidRoot) => {
        Err("Invalid sitemap format: root element must be 'sitemapindex' or 'urlset'".to_string())
      }
      Err(ParseOutcome::XmlError(_)) => Err(format!("XML parsing error: {primary_err}")),
    },
  }
}

/// Process sitemap XML and extract crawling instructions.
pub fn process_sitemap(xml_content: &str) -> Result<SitemapProcessingResult, String> {
  let parsed = parse_sitemap_xml(xml_content)?;
  let mut instructions = Vec::new();
  let mut total_count: u32 = 0;

  if let Some(sitemapindex) = parsed.sitemapindex {
    let sitemap_urls: Vec<String> = sitemapindex
      .sitemap
      .iter()
      .filter_map(|sitemap| {
        let loc = sitemap.loc.first()?.trim();
        (!loc.is_empty()).then(|| loc.to_string())
      })
      .collect();

    if !sitemap_urls.is_empty() {
      let count = u32::try_from(sitemap_urls.len()).unwrap_or(u32::MAX);
      instructions.push(SitemapInstruction {
        action: "recurse".to_string(),
        urls: sitemap_urls,
        count,
      });
      total_count = total_count.saturating_add(count);
    }
  } else if let Some(urlset) = parsed.urlset {
    let mut xml_sitemaps = Vec::new();
    let mut valid_urls = Vec::new();

    for url_entry in urlset.url {
      let Some(raw_url) = url_entry.loc.first() else {
        continue;
      };
      let url = raw_url.trim();
      if url.is_empty() {
        continue;
      }
      let url_lower = url.to_lowercase();
      if url_lower.ends_with(".xml") || url_lower.ends_with(".xml.gz") {
        xml_sitemaps.push(url.to_string());
      } else if let Ok(parsed_url) = Url::parse(url) {
        let path_lower = parsed_url.path().to_lowercase();
        if !is_file(&path_lower) {
          valid_urls.push(url.to_string());
        }
      }
    }

    if !xml_sitemaps.is_empty() {
      let count = u32::try_from(xml_sitemaps.len()).unwrap_or(u32::MAX);
      instructions.push(SitemapInstruction {
        action: "recurse".to_string(),
        urls: xml_sitemaps,
        count,
      });
      total_count = total_count.saturating_add(count);
    }

    if !valid_urls.is_empty() {
      let count = u32::try_from(valid_urls.len()).unwrap_or(u32::MAX);
      instructions.push(SitemapInstruction {
        action: "process".to_string(),
        urls: valid_urls,
        count,
      });
      total_count = total_count.saturating_add(count);
    }
  }

  Ok(SitemapProcessingResult {
    instructions,
    total_count,
  })
}

fn clean_xml_input(xml: &str) -> Cow<'_, str> {
  let trimmed = xml.trim_start_matches(|c: char| c == '\u{feff}' || c.is_whitespace());
  let has_illegal_ctrl = trimmed
    .bytes()
    .any(|b| b < 0x20 && !matches!(b, b'\t' | b'\n' | b'\r'));
  if !has_illegal_ctrl {
    return Cow::Borrowed(trimmed);
  }
  let filtered: String = trimmed
    .chars()
    .filter(|&c| {
      let code = u32::from(c);
      code >= 0x20 || matches!(c, '\t' | '\n' | '\r')
    })
    .collect();
  Cow::Owned(filtered)
}

fn collect_all_text(node: roxmltree::Node<'_, '_>) -> Option<String> {
  let mut out = String::new();
  let mut has_text = false;
  for child in node.children() {
    if let Some(text) = child.is_text().then(|| child.text()).flatten() {
      out.push_str(text);
      has_text = true;
    }
  }
  has_text.then_some(out)
}

fn parse_with_roxmltree(xml: &str) -> Result<ParsedSitemap, ParseOutcome> {
  let doc = roxmltree::Document::parse_with_options(
    xml,
    roxmltree::ParsingOptions {
      allow_dtd: true,
      ..Default::default()
    },
  )
  .map_err(|e| ParseOutcome::XmlError(e.to_string()))?;

  let root = doc.root_element();
  match root.tag_name().name() {
    "sitemapindex" => {
      let sitemaps = root
        .children()
        .filter(|n| n.is_element() && n.tag_name().name() == "sitemap")
        .filter_map(|sitemap_node| {
          sitemap_node
            .children()
            .find(|n| n.is_element() && n.tag_name().name() == "loc")
            .and_then(collect_all_text)
            .map(|loc_text| SitemapEntry {
              loc: vec![loc_text],
            })
        })
        .collect();

      Ok(ParsedSitemap {
        urlset: None,
        sitemapindex: Some(SitemapIndex { sitemap: sitemaps }),
      })
    }
    "urlset" => {
      let urls = root
        .children()
        .filter(|n| n.is_element() && n.tag_name().name() == "url")
        .filter_map(|url_node| {
          url_node
            .children()
            .find(|n| n.is_element() && n.tag_name().name() == "loc")
            .and_then(collect_all_text)
            .map(|loc_text| SitemapUrl {
              loc: vec![loc_text],
            })
        })
        .collect();

      Ok(ParsedSitemap {
        urlset: Some(SitemapUrlset { url: urls }),
        sitemapindex: None,
      })
    }
    _ => Err(ParseOutcome::InvalidRoot),
  }
}
