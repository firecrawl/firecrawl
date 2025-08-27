use std::{collections::HashMap, usize};
use serde::{Deserialize, Serialize};
use std::ffi::{CStr, CString};
use url::Url;
use regex::Regex;
use texting_robots::Robot;

#[derive(Deserialize)]
struct FilterLinksCall {
    links: Vec<String>,
    limit: Option<i64>,
    max_depth: u32,
    base_url: String,
    initial_url: String,
    regex_on_full_url: bool,
    excludes: Vec<String>,
    includes: Vec<String>,
    allow_backward_crawling: bool,
    ignore_robots_txt: bool,
    robots_txt: String,
}

#[derive(Serialize)]
struct FilterLinksResult {
    links: Vec<String>,
    denial_reasons: HashMap<String, String>,
}

#[derive(Serialize, Debug)]
struct SitemapUrl {
    loc: Vec<String>,
}

#[derive(Serialize, Debug)]
struct SitemapEntry {
    loc: Vec<String>,
}

#[derive(Serialize, Debug)]
#[serde(untagged)]
enum ParsedSitemap {
    Urlset { urlset: SitemapUrlset },
    SitemapIndex { sitemapindex: SitemapIndex },
}

#[derive(Serialize, Debug)]
struct SitemapUrlset {
    url: Vec<SitemapUrl>,
}

#[derive(Serialize, Debug)]
struct SitemapIndex {
    sitemap: Vec<SitemapEntry>,
}

#[derive(Serialize, Debug)]
struct SitemapInstruction {
    action: String,
    urls: Vec<String>,
    count: usize,
}

#[derive(Serialize, Debug)]
struct SitemapProcessingResult {
    instructions: Vec<SitemapInstruction>,
    total_count: usize,
}

fn _is_file(url: &Url) -> bool {
    let file_extensions = vec![
        ".png",
        ".jpg",
        ".jpeg",
        ".gif",
        ".css",
        ".js",
        ".ico",
        ".svg",
        ".tiff",
        ".zip",
        ".exe",
        ".dmg",
        ".mp4",
        ".mp3",
        ".wav",
        ".pptx",
        ".xlsx",
        ".avi",
        ".flv",
        ".woff",
        ".ttf",
        ".woff2",
        ".webp",
        ".inc",
    ];
    let url_without_query = url.path().to_lowercase();
    file_extensions.iter().any(|ext| url_without_query.ends_with(ext))
}

fn _get_url_depth(path: &str) -> u32 {
    path.split('/').filter(|x| *x != "" && *x != "index.php" && *x != "index.html").count() as u32
}

fn _filter_links(data: FilterLinksCall) -> Result<FilterLinksResult, Box<dyn std::error::Error>> {
    let mut denial_reasons = HashMap::new();

    let limit = data.limit
        .and_then(|x| if x < 0 { Some(0) } else { Some(x as usize) })
        .unwrap_or(usize::MAX);

    if limit == 0 {
        return Ok(FilterLinksResult {
            links: Vec::with_capacity(0),
            denial_reasons,
        });
    }

    let base_url = Url::parse(&data.base_url)?;
    let initial_url = Url::parse(&data.initial_url)?;

    let excludes_regex = data.excludes.iter().map(|exclude| Regex::new(exclude)).collect::<Vec<Result<Regex, regex::Error>>>();
    let excludes_regex = excludes_regex.into_iter().filter_map(|x| x.ok()).collect::<Vec<Regex>>();

    let includes_regex = data.includes.iter().map(|include| Regex::new(include)).collect::<Vec<Result<Regex, regex::Error>>>();
    let includes_regex = includes_regex.into_iter().filter_map(|x| x.ok()).collect::<Vec<Regex>>();

    let links = data.links.into_iter()
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

            if !excludes_regex.is_empty() && excludes_regex.iter().any(|regex| regex.is_match(exinc_path)) {
                denial_reasons.insert(link.clone(), "EXCLUDE_PATTERN".to_string());
                return false;
            }

            if !includes_regex.is_empty() && !includes_regex.iter().any(|regex| regex.is_match(exinc_path)) {
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
                    Err(_) => {
                    }
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

#[unsafe(no_mangle)]
pub unsafe extern "C" fn filter_links(data: *const libc::c_char) -> *mut libc::c_char {
    let data = match serde_json::from_slice(unsafe { CStr::from_ptr(data).to_bytes() }) {
        Ok(x) => x,
        Err(e) => {
            return CString::new(format!("RUSTFC:ERROR:Failed to parse input data as C string: {}", e)).unwrap().into_raw();
        }
    };

    let result = match _filter_links(data) {
        Ok(x) => x,
        Err(e) => {
            return CString::new(format!("RUSTFC:ERROR:{}", e)).unwrap().into_raw();
        }
    };

    let result = match serde_json::to_string(&result) {
        Ok(x) => x,
        Err(e) => {
            return CString::new(format!("RUSTFC:ERROR:Failed to serialize result as JSON {}", e)).unwrap().into_raw();
        }
    };

    CString::new(result).unwrap().into_raw()
}

fn _parse_sitemap_xml(xml_content: &str) -> Result<ParsedSitemap, Box<dyn std::error::Error>> {
    let doc = roxmltree::Document::parse_with_options(
        xml_content,
        roxmltree::ParsingOptions { allow_dtd: true, ..Default::default() },
    )?;
    let root = doc.root_element();
    
    match root.tag_name().name() {
        "sitemapindex" => {
            let mut sitemaps = Vec::new();
            
            for sitemap_node in root.children().filter(|n| n.is_element() && n.tag_name().name() == "sitemap") {
                if let Some(loc_node) = sitemap_node.children().find(|n| n.is_element() && n.tag_name().name() == "loc") {
                    if let Some(loc_text) = loc_node.text() {
                        sitemaps.push(SitemapEntry {
                            loc: vec![loc_text.to_string()],
                        });
                    }
                }
            }
            
            Ok(ParsedSitemap::SitemapIndex { 
                sitemapindex: SitemapIndex { sitemap: sitemaps } 
            })
        },
        "urlset" => {
            let mut urls = Vec::new();
            
            for url_node in root.children().filter(|n| n.is_element() && n.tag_name().name() == "url") {
                if let Some(loc_node) = url_node.children().find(|n| n.is_element() && n.tag_name().name() == "loc") {
                    if let Some(loc_text) = loc_node.text() {
                        urls.push(SitemapUrl {
                            loc: vec![loc_text.to_string()],
                        });
                    }
                }
            }
            
            Ok(ParsedSitemap::Urlset { 
                urlset: SitemapUrlset { url: urls } 
            })
        },
        _ => {
            Err("Invalid sitemap format: root element must be 'sitemapindex' or 'urlset'".into())
        }
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn parse_sitemap_xml(data: *const libc::c_char) -> *mut libc::c_char {
    let xml_content = match unsafe { CStr::from_ptr(data).to_str() } {
        Ok(s) => s,
        Err(e) => {
            return CString::new(format!("RUSTFC:ERROR:Failed to parse input data as UTF-8 string: {}", e)).unwrap().into_raw();
        }
    };

    let result = match _parse_sitemap_xml(xml_content) {
        Ok(x) => x,
        Err(e) => {
            return CString::new(format!("RUSTFC:ERROR:{}", e)).unwrap().into_raw();
        }
    };

    let result = match serde_json::to_string(&result) {
        Ok(x) => x,
        Err(e) => {
            return CString::new(format!("RUSTFC:ERROR:Failed to serialize result as JSON {}", e)).unwrap().into_raw();
        }
    };

    CString::new(result).unwrap().into_raw()
}

fn _process_sitemap(xml_content: &str) -> Result<SitemapProcessingResult, Box<dyn std::error::Error>> {
    let parsed = _parse_sitemap_xml(xml_content)?;
    let mut instructions = Vec::new();
    let mut total_count = 0;
    
    match parsed {
        ParsedSitemap::SitemapIndex { sitemapindex } => {
            let sitemap_urls: Vec<String> = sitemapindex.sitemap
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
                    count: sitemap_urls.len(),
                });
                total_count += sitemap_urls.len();
            }
        },
        ParsedSitemap::Urlset { urlset } => {
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
                    count: xml_sitemaps.len(),
                });
                total_count += xml_sitemaps.len();
            }
            
            if !valid_urls.is_empty() {
                instructions.push(SitemapInstruction {
                    action: "process".to_string(),
                    urls: valid_urls.clone(),
                    count: valid_urls.len(),
                });
                total_count += valid_urls.len();
            }
        }
    }
    
    Ok(SitemapProcessingResult {
        instructions,
        total_count,
    })
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn process_sitemap(data: *const libc::c_char) -> *mut libc::c_char {
    let xml_content = match unsafe { CStr::from_ptr(data).to_str() } {
        Ok(s) => s,
        Err(e) => {
            return CString::new(format!("RUSTFC:ERROR:Failed to parse input data as UTF-8 string: {}", e)).unwrap().into_raw();
        }
    };

    let result = match _process_sitemap(xml_content) {
        Ok(x) => x,
        Err(e) => {
            return CString::new(format!("RUSTFC:ERROR:{}", e)).unwrap().into_raw();
        }
    };

    let result = match serde_json::to_string(&result) {
        Ok(x) => x,
        Err(e) => {
            return CString::new(format!("RUSTFC:ERROR:Failed to serialize result as JSON {}", e)).unwrap().into_raw();
        }
    };

    CString::new(result).unwrap().into_raw()
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
        match result {
            ParsedSitemap::Urlset { urlset } => {
                assert_eq!(urlset.url.len(), 2);
                assert_eq!(urlset.url[0].loc[0], "https://example.com/page1");
                assert_eq!(urlset.url[1].loc[0], "https://example.com/page2");
            }
            _ => panic!("Expected Urlset variant"),
        }
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
        match result {
            ParsedSitemap::SitemapIndex { sitemapindex } => {
                assert_eq!(sitemapindex.sitemap.len(), 2);
                assert_eq!(sitemapindex.sitemap[0].loc[0], "https://example.com/sitemap1.xml");
                assert_eq!(sitemapindex.sitemap[1].loc[0], "https://example.com/sitemap2.xml");
            }
            _ => panic!("Expected SitemapIndex variant"),
        }
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
        assert!(result.unwrap_err().to_string().contains("Invalid sitemap format"));
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
        
        let recurse_instruction = result.instructions.iter().find(|i| i.action == "recurse").unwrap();
        assert_eq!(recurse_instruction.urls.len(), 1);
        assert_eq!(recurse_instruction.urls[0], "https://example.com/sitemap2.xml");
        
        let process_instruction = result.instructions.iter().find(|i| i.action == "process").unwrap();
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
        assert_eq!(result.instructions[0].urls[0], "https://example.com/sitemap1.xml");
        assert_eq!(result.instructions[0].urls[1], "https://example.com/sitemap2.xml");
    }

    #[test]
    fn test_filter_links_normal_robots_txt() {
        let data = FilterLinksCall {
            links: vec!["https://example.com/allowed".to_string(), "https://example.com/disallowed".to_string()],
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
        assert!(result.denial_reasons.contains_key("https://example.com/disallowed"));
        assert_eq!(result.denial_reasons.get("https://example.com/disallowed").unwrap(), "ROBOTS_TXT");
    }

    #[test]
    fn test_filter_links_malformed_robots_txt() {
        let data = FilterLinksCall {
            links: vec!["https://example.com/test".to_string()],
            limit: Some(10),
            includes: vec![],
            excludes: vec![],
            ignore_robots_txt: false,
            robots_txt: "Invalid robots.txt content with \x00 null bytes and malformed syntax".to_string(),
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

/// Frees a string allocated in Rust-land.
/// 
/// # Safety
/// ptr must be a non-freed string pointer returned by Rust code.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn free_string(ptr: *mut libc::c_char) {
    drop(unsafe { CString::from_raw(ptr) })
}
