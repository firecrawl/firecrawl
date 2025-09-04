use napi::bindgen_prelude::*;
use napi_derive::napi;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, usize};
use texting_robots::Robot;
use url::Url;

#[derive(Deserialize)]
#[napi(object)]
pub struct FilterLinksCall {
  pub links: Vec<String>,
  pub limit: Option<i64>,
  pub max_depth: u32,
  pub base_url: String,
  pub initial_url: String,
  pub regex_on_full_url: bool,
  pub excludes: Vec<String>,
  pub includes: Vec<String>,
  pub allow_backward_crawling: bool,
  pub ignore_robots_txt: bool,
  pub robots_txt: String,
}

#[derive(Serialize)]
#[napi(object)]
pub struct FilterLinksResult {
  pub links: Vec<String>,
  pub denial_reasons: HashMap<String, String>,
}

#[derive(Serialize, Debug)]
#[napi(object)]
pub struct SitemapUrl {
  pub loc: Vec<String>,
}

#[derive(Serialize, Debug)]
#[napi(object)]
pub struct SitemapEntry {
  pub loc: Vec<String>,
}

#[derive(Serialize, Debug)]
#[napi(object)]
pub struct SitemapUrlset {
  pub url: Vec<SitemapUrl>,
}

#[derive(Serialize, Debug)]
#[napi(object)]
pub struct SitemapIndex {
  pub sitemap: Vec<SitemapEntry>,
}

#[derive(Serialize, Debug)]
#[napi(object)]
pub struct ParsedSitemap {
  pub urlset: Option<SitemapUrlset>,
  pub sitemapindex: Option<SitemapIndex>,
}

#[derive(Serialize, Debug)]
#[napi(object)]
pub struct SitemapInstruction {
  pub action: String,
  pub urls: Vec<String>,
  pub count: u32,
}

#[derive(Serialize, Debug)]
#[napi(object)]
pub struct SitemapProcessingResult {
  pub instructions: Vec<SitemapInstruction>,
  pub total_count: u32,
}

fn _is_file(url: &Url) -> bool {
  let file_extensions = vec![
    ".png", ".jpg", ".jpeg", ".gif", ".css", ".js", ".ico", ".svg", ".tiff", ".zip", ".exe",
    ".dmg", ".mp4", ".mp3", ".wav", ".pptx", ".xlsx", ".avi", ".flv", ".woff", ".ttf", ".woff2",
    ".webp", ".inc",
  ];
  let url_without_query = url.path().to_lowercase();
  file_extensions
    .iter()
    .any(|ext| url_without_query.ends_with(ext))
}

fn _get_url_depth(path: &str) -> u32 {
  path
    .split('/')
    .filter(|x| *x != "" && *x != "index.php" && *x != "index.html")
    .count() as u32
}

fn _filter_links(data: FilterLinksCall) -> std::result::Result<FilterLinksResult, String> {
  let mut denial_reasons = HashMap::new();

  let limit = data
    .limit
    .and_then(|x| if x < 0 { Some(0) } else { Some(x as usize) })
    .unwrap_or(usize::MAX);

  if limit == 0 {
    return Ok(FilterLinksResult {
      links: Vec::with_capacity(0),
      denial_reasons,
    });
  }

  let base_url = Url::parse(&data.base_url).map_err(|e| format!("Base URL parse error: {}", e))?;
  let initial_url = Url::parse(&data.initial_url).map_err(|e| format!("Initial URL parse error: {}", e))?;

  let excludes_regex = data
    .excludes
    .iter()
    .map(|exclude| Regex::new(exclude))
    .collect::<Vec<std::result::Result<Regex, regex::Error>>>();
  let excludes_regex = excludes_regex
    .into_iter()
    .filter_map(|x| x.ok())
    .collect::<Vec<Regex>>();

  let includes_regex = data
    .includes
    .iter()
    .map(|include| Regex::new(include))
    .collect::<Vec<std::result::Result<Regex, regex::Error>>>();
  let includes_regex = includes_regex
    .into_iter()
    .filter_map(|x| x.ok())
    .collect::<Vec<Regex>>();

  let links = data
    .links
    .into_iter()
    .filter(|link| {
      let url = match base_url.join(link) {
        Ok(x) => x,
        Err(_) => {
          denial_reasons.insert(link.clone(), "URL_PARSE_ERROR".to_string());
          return false;
        }
      };

      let path = url.path();
      let depth = _get_url_depth(path);
      if depth > data.max_depth {
        denial_reasons.insert(link.clone(), "DEPTH_LIMIT".to_string());
        return false;
      }

      let exinc_path = if data.regex_on_full_url {
        url.as_str()
      } else {
        url.path()
      };

      if !excludes_regex.is_empty()
        && excludes_regex
          .iter()
          .any(|regex| regex.is_match(exinc_path))
      {
        denial_reasons.insert(link.clone(), "EXCLUDE_PATTERN".to_string());
        return false;
      }

      if !includes_regex.is_empty()
        && !includes_regex
          .iter()
          .any(|regex| regex.is_match(exinc_path))
      {
        denial_reasons.insert(link.clone(), "INCLUDE_PATTERN".to_string());
        return false;
      }

      if !data.allow_backward_crawling {
        if !url.path().starts_with(initial_url.path()) {
          denial_reasons.insert(link.clone(), "BACKWARD_CRAWLING".to_string());
          return false;
        }
      }

      if !data.ignore_robots_txt {
        match Robot::new("FireCrawlAgent", data.robots_txt.as_bytes()) {
          Ok(robot) => {
            let allowed = robot.allowed(url.as_str());
            if !allowed {
              match Robot::new("FirecrawlAgent", data.robots_txt.as_bytes()) {
                Ok(robot_alt) => {
                  let allowed_alt = robot_alt.allowed(url.as_str());
                  if !allowed_alt {
                    denial_reasons.insert(link.clone(), "ROBOTS_TXT".to_string());
                    return false;
                  }
                }
                Err(_) => {
                  denial_reasons.insert(link.clone(), "ROBOTS_TXT".to_string());
                  return false;
                }
              }
            }
          }
          Err(_) => {}
        }
      }

      if _is_file(&url) {
        denial_reasons.insert(link.clone(), "FILE_TYPE".to_string());
        return false;
      }

      true
    })
    .take(limit)
    .collect::<Vec<_>>();

  Ok(FilterLinksResult {
    links,
    denial_reasons,
  })
}

/// Filter links based on crawling rules and constraints.
#[napi]
pub fn filter_links(data: FilterLinksCall) -> Result<FilterLinksResult> {
  _filter_links(data)
    .map_err(|e| Error::new(Status::GenericFailure, format!("Filter links error: {}", e)))
}

fn _parse_sitemap_xml(xml_content: &str) -> std::result::Result<ParsedSitemap, String> {
  let doc = roxmltree::Document::parse_with_options(
    xml_content,
    roxmltree::ParsingOptions {
      allow_dtd: true,
      ..Default::default()
    },
  ).map_err(|e| format!("XML parsing error: {}", e))?;
  let root = doc.root_element();

  match root.tag_name().name() {
    "sitemapindex" => {
      let mut sitemaps = Vec::new();

      for sitemap_node in root
        .children()
        .filter(|n| n.is_element() && n.tag_name().name() == "sitemap")
      {
        if let Some(loc_node) = sitemap_node
          .children()
          .find(|n| n.is_element() && n.tag_name().name() == "loc")
        {
          if let Some(loc_text) = loc_node.text() {
            sitemaps.push(SitemapEntry {
              loc: vec![loc_text.to_string()],
            });
          }
        }
      }

      Ok(ParsedSitemap {
        urlset: None,
        sitemapindex: Some(SitemapIndex { sitemap: sitemaps }),
      })
    }
    "urlset" => {
      let mut urls = Vec::new();

      for url_node in root
        .children()
        .filter(|n| n.is_element() && n.tag_name().name() == "url")
      {
        if let Some(loc_node) = url_node
          .children()
          .find(|n| n.is_element() && n.tag_name().name() == "loc")
        {
          if let Some(loc_text) = loc_node.text() {
            urls.push(SitemapUrl {
              loc: vec![loc_text.to_string()],
            });
          }
        }
      }

      Ok(ParsedSitemap {
        urlset: Some(SitemapUrlset { url: urls }),
        sitemapindex: None,
      })
    }
    _ => Err("Invalid sitemap format: root element must be 'sitemapindex' or 'urlset'".to_string()),
  }
}

/// Parse XML sitemap content into structured data.
#[napi]
pub fn parse_sitemap_xml(xml_content: String) -> Result<ParsedSitemap> {
  _parse_sitemap_xml(&xml_content).map_err(|e| {
    Error::new(
      Status::GenericFailure,
      format!("Parse sitemap XML error: {}", e),
    )
  })
}

fn _process_sitemap(
  xml_content: &str,
) -> std::result::Result<SitemapProcessingResult, String> {
  let parsed = _parse_sitemap_xml(xml_content)?;
  let mut instructions = Vec::new();
  let mut total_count: u32 = 0;

  if let Some(sitemapindex) = parsed.sitemapindex {
    let sitemap_urls: Vec<String> = sitemapindex
      .sitemap
      .iter()
      .filter_map(|sitemap| {
        if !sitemap.loc.is_empty() {
          Some(sitemap.loc[0].trim().to_string())
        } else {
          None
        }
      })
      .collect();

    if !sitemap_urls.is_empty() {
      instructions.push(SitemapInstruction {
        action: "recurse".to_string(),
        urls: sitemap_urls.clone(),
        count: sitemap_urls.len() as u32,
      });
      total_count += sitemap_urls.len() as u32;
    }
  } else if let Some(urlset) = parsed.urlset {
    let mut xml_sitemaps = Vec::new();
    let mut valid_urls = Vec::new();

    for url_entry in urlset.url {
      if !url_entry.loc.is_empty() {
        let url = url_entry.loc[0].trim();
        if url.to_lowercase().ends_with(".xml") {
          xml_sitemaps.push(url.to_string());
        } else if let Ok(parsed_url) = Url::parse(url) {
          if !_is_file(&parsed_url) {
            valid_urls.push(url.to_string());
          }
        }
      }
    }

    if !xml_sitemaps.is_empty() {
      instructions.push(SitemapInstruction {
        action: "recurse".to_string(),
        urls: xml_sitemaps.clone(),
        count: xml_sitemaps.len() as u32,
      });
      total_count += xml_sitemaps.len() as u32;
    }

    if !valid_urls.is_empty() {
      instructions.push(SitemapInstruction {
        action: "process".to_string(),
        urls: valid_urls.clone(),
        count: valid_urls.len() as u32,
      });
      total_count += valid_urls.len() as u32;
    }
  }

  Ok(SitemapProcessingResult {
    instructions,
    total_count,
  })
}

/// Process sitemap XML and extract crawling instructions.
#[napi]
pub fn process_sitemap(xml_content: String) -> Result<SitemapProcessingResult> {
  _process_sitemap(&xml_content).map_err(|e| {
    Error::new(
      Status::GenericFailure,
      format!("Process sitemap error: {}", e),
    )
  })
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn test_parse_sitemap_xml_urlset() {
    let xml_content = r#"<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://example.com/page1</loc>
  </url>
  <url>
    <loc>https://example.com/page2</loc>
  </url>
</urlset>"#;

    let result = _parse_sitemap_xml(xml_content).unwrap();
    assert!(result.urlset.is_some());
    let urlset = result.urlset.unwrap();
    assert_eq!(urlset.url.len(), 2);
    assert_eq!(urlset.url[0].loc[0], "https://example.com/page1");
    assert_eq!(urlset.url[1].loc[0], "https://example.com/page2");
  }

  #[test]
  fn test_parse_sitemap_xml_sitemapindex() {
    let xml_content = r#"<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap>
    <loc>https://example.com/sitemap1.xml</loc>
  </sitemap>
  <sitemap>
    <loc>https://example.com/sitemap2.xml</loc>
  </sitemap>
</sitemapindex>"#;

    let result = _parse_sitemap_xml(xml_content).unwrap();
    assert!(result.sitemapindex.is_some());
    let sitemapindex = result.sitemapindex.unwrap();
    assert_eq!(sitemapindex.sitemap.len(), 2);
    assert_eq!(
      sitemapindex.sitemap[0].loc[0],
      "https://example.com/sitemap1.xml"
    );
    assert_eq!(
      sitemapindex.sitemap[1].loc[0],
      "https://example.com/sitemap2.xml"
    );
  }

  #[test]
  fn test_parse_sitemap_xml_invalid_root() {
    let xml_content = r#"<?xml version="1.0" encoding="UTF-8"?>
<invalid xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://example.com/page1</loc>
  </url>
</invalid>"#;

    let result = _parse_sitemap_xml(xml_content);
    assert!(result.is_err());
    assert!(result
      .unwrap_err()
      .to_string()
      .contains("Invalid sitemap format"));
  }

  #[test]
  fn test_parse_sitemap_xml_malformed() {
    let xml_content = r#"<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://example.com/page1</loc>
  </url>
</urlset"#; // Missing closing >

    let result = _parse_sitemap_xml(xml_content);
    assert!(result.is_err());
  }

  #[test]
  fn test_process_sitemap_urlset() {
    let xml_content = r#"<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://example.com/page1</loc>
  </url>
  <url>
    <loc>https://example.com/sitemap2.xml</loc>
  </url>
  <url>
    <loc>https://example.com/image.png</loc>
  </url>
</urlset>"#;

    let result = _process_sitemap(xml_content).unwrap();
    assert_eq!(result.instructions.len(), 2);

    let recurse_instruction = result
      .instructions
      .iter()
      .find(|i| i.action == "recurse")
      .unwrap();
    assert_eq!(recurse_instruction.urls.len(), 1);
    assert_eq!(
      recurse_instruction.urls[0],
      "https://example.com/sitemap2.xml"
    );

    let process_instruction = result
      .instructions
      .iter()
      .find(|i| i.action == "process")
      .unwrap();
    assert_eq!(process_instruction.urls.len(), 1);
    assert_eq!(process_instruction.urls[0], "https://example.com/page1");
  }

  #[test]
  fn test_process_sitemap_sitemapindex() {
    let xml_content = r#"<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap>
    <loc>https://example.com/sitemap1.xml</loc>
  </sitemap>
  <sitemap>
    <loc>https://example.com/sitemap2.xml</loc>
  </sitemap>
</sitemapindex>"#;

    let result = _process_sitemap(xml_content).unwrap();
    assert_eq!(result.instructions.len(), 1);
    assert_eq!(result.instructions[0].action, "recurse");
    assert_eq!(result.instructions[0].urls.len(), 2);
    assert_eq!(
      result.instructions[0].urls[0],
      "https://example.com/sitemap1.xml"
    );
    assert_eq!(
      result.instructions[0].urls[1],
      "https://example.com/sitemap2.xml"
    );
  }

  #[test]
  fn test_filter_links_normal_robots_txt() {
    let data = FilterLinksCall {
      links: vec![
        "https://example.com/allowed".to_string(),
        "https://example.com/disallowed".to_string(),
      ],
      limit: Some(10),
      includes: vec![],
      excludes: vec![],
      ignore_robots_txt: false,
      robots_txt: "User-agent: *\nDisallow: /disallowed".to_string(),
      max_depth: 10,
      base_url: "https://example.com".to_string(),
      initial_url: "https://example.com".to_string(),
      regex_on_full_url: false,
      allow_backward_crawling: true,
    };

    let result = _filter_links(data).unwrap();
    assert_eq!(result.links.len(), 1);
    assert_eq!(result.links[0], "https://example.com/allowed");
    assert!(result
      .denial_reasons
      .contains_key("https://example.com/disallowed"));
    assert_eq!(
      result
        .denial_reasons
        .get("https://example.com/disallowed")
        .unwrap(),
      "ROBOTS_TXT"
    );
  }

  #[test]
  fn test_filter_links_malformed_robots_txt() {
    let data = FilterLinksCall {
      links: vec!["https://example.com/test".to_string()],
      limit: Some(10),
      includes: vec![],
      excludes: vec![],
      ignore_robots_txt: false,
      robots_txt: "Invalid robots.txt content with \x00 null bytes and malformed syntax"
        .to_string(),
      max_depth: 10,
      base_url: "https://example.com".to_string(),
      initial_url: "https://example.com".to_string(),
      regex_on_full_url: false,
      allow_backward_crawling: true,
    };

    let result = _filter_links(data);
    assert!(result.is_ok());
    let result = result.unwrap();
    assert_eq!(result.links.len(), 1);
    assert_eq!(result.links[0], "https://example.com/test");
  }

  #[test]
  fn test_filter_links_non_utf8_robots_txt() {
    let mut non_utf8_bytes = vec![0xFF, 0xFE];
    non_utf8_bytes.extend_from_slice(b"User-agent: *\nDisallow: /blocked");
    let non_utf8_string = String::from_utf8_lossy(&non_utf8_bytes).to_string();

    let data = FilterLinksCall {
      links: vec!["https://example.com/allowed".to_string()],
      limit: Some(10),
      includes: vec![],
      excludes: vec![],
      ignore_robots_txt: false,
      robots_txt: non_utf8_string,
      max_depth: 10,
      base_url: "https://example.com".to_string(),
      initial_url: "https://example.com".to_string(),
      regex_on_full_url: false,
      allow_backward_crawling: true,
    };

    let result = _filter_links(data);
    assert!(result.is_ok());
    let result = result.unwrap();
    assert_eq!(result.links.len(), 1);
    assert_eq!(result.links[0], "https://example.com/allowed");
  }

  #[test]
  fn test_filter_links_char_boundary_issue() {
    let problematic_content = "User-agent: *\nDisallow: /\u{a0}test";

    let data = FilterLinksCall {
      links: vec!["https://example.com/test".to_string()],
      limit: Some(10),
      includes: vec![],
      excludes: vec![],
      ignore_robots_txt: false,
      robots_txt: problematic_content.to_string(),
      max_depth: 10,
      base_url: "https://example.com".to_string(),
      initial_url: "https://example.com".to_string(),
      regex_on_full_url: false,
      allow_backward_crawling: true,
    };

    let result = _filter_links(data);
    assert!(result.is_ok());
    let result = result.unwrap();
    assert_eq!(result.links.len(), 1);
    assert_eq!(result.links[0], "https://example.com/test");
  }
}
