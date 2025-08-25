use std::{collections::{HashMap, HashSet}, ffi::{CStr, CString}};

use nodesig::{get_node_signature, SignatureMode};
use kuchikiki::{iter::NodeEdge, parse_html, traits::TendrilSink, NodeRef};
use serde::Deserialize;
use serde_json::Value;
use url::Url;

fn _extract_base_href_from_document(document: &NodeRef, url: &Url) -> Result<String, Box<dyn std::error::Error>> {
    if let Some(base) = document.select("base[href]").map_err(|_| "Failed to select base href".to_string())?.next()
            .and_then(|base| base.attributes.borrow().get("href").map(|x| x.to_string())) {
        
        if let Ok(base) = url.join(&base) {
            return Ok(base.to_string());
        }
    }

    Ok(url.to_string())
}

fn _extract_base_href(html: &str, url: &str) -> Result<String, Box<dyn std::error::Error>> {
    let document = parse_html().one(html);
    let url = Url::parse(url)?;

    _extract_base_href_from_document(&document, &url)
}

/// Extracts base href from HTML
/// 
/// # Safety
/// Input must be a C HTML string and a C URL string. Output will be a string. Output string must be freed with free_string.
#[no_mangle]
pub unsafe extern "C" fn extract_base_href(html: *const libc::c_char, url: *const libc::c_char) -> *mut libc::c_char {
    let html = match unsafe { CStr::from_ptr(html) }.to_str().map_err(|_| ()) {
        Ok(x) => x,
        Err(_) => {
            return CString::new("RUSTFC:ERROR:Failed to parse input HTML as C string").unwrap().into_raw();
        }
    };
    let url = match unsafe { CStr::from_ptr(url) }.to_str().map_err(|_| ()) {
        Ok(x) => x,
        Err(_) => {
            return CString::new("RUSTFC:ERROR:Failed to parse input URL as C string").unwrap().into_raw();
        }
    };

    let base_href = match _extract_base_href(html, url) {
        Ok(x) => x,
        Err(e) => {
            return CString::new(format!("RUSTFC:ERROR:{}", e)).unwrap().into_raw();
        }
    };

    CString::new(base_href).unwrap().into_raw()
}

/// Extracts links from HTML
/// 
/// # Safety
/// Input options must be a C HTML string. Output will be a JSON string array. Output string must be freed with free_string.
#[no_mangle]
pub unsafe extern "C" fn extract_links(html: *const libc::c_char) -> *mut libc::c_char {
    let html = match unsafe { CStr::from_ptr(html) }.to_str().map_err(|_| ()) {
        Ok(x) => x,
        Err(_) => {
            return CString::new("RUSTFC:ERROR:Failed to parse input HTML as C string").unwrap().into_raw();
        }
    };

    let document = parse_html().one(html);

    let mut out: Vec<String> = Vec::new();

    let anchors: Vec<_> = match document.select("a[href]").map_err(|_| "Failed to select links") {
        Ok(x) => x.collect(),
        Err(e) => {
            return CString::new(format!("RUSTFC:ERROR:{}", e)).unwrap().into_raw();
        }
    };

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

    let links_out = match serde_json::ser::to_string(&out) {
        Ok(x) => x,
        Err(e) => {
            return CString::new(format!("RUSTFC:ERROR:{}", e)).unwrap().into_raw();
        }
    };

    CString::new(links_out).unwrap().into_raw()
}

macro_rules! insert_meta_name {
    ($out:ident, $document:ident, $metaName:expr, $outName:expr) => {
        if let Some(x) = $document.select(&format!("meta[name=\"{}\"]", $metaName)).map_err(|_| "Failed to select meta name")?.next().and_then(|description| description.attributes.borrow().get("content").map(|x| x.to_string())) {
            $out.insert(($outName).to_string(), Value::String(x));
        }
    };
}

macro_rules! insert_meta_property {
    ($out:ident, $document:ident, $metaName:expr, $outName:expr) => {
        if let Some(x) = $document.select(&format!("meta[property=\"{}\"]", $metaName)).map_err(|_| "Failed to select meta property")?.next().and_then(|description| description.attributes.borrow().get("content").map(|x| x.to_string())) {
            $out.insert(($outName).to_string(), Value::String(x));
        }
    };
}

fn _extract_metadata(html: &str) -> Result<String, Box<dyn std::error::Error>> {
    let document = parse_html().one(html);
    let mut out = HashMap::<String, Value>::new();

    if let Some(title) = document.select("title").map_err(|_| "Failed to select title")?.next() {
        out.insert("title".to_string(), Value::String(title.text_contents()));
    }
    // insert_meta_name!(out, document, "description", "description");

    if let Some(favicon_link) = document.select("link[rel=\"icon\"]").map_err(|_| "Failed to select favicon")?.next()
        .and_then(|x| x.attributes.borrow().get("href").map(|x| x.to_string()))
        .or_else(|| document.select("link[rel*=\"icon\"]").unwrap().next()
            .and_then(|x| x.attributes.borrow().get("href").map(|x| x.to_string()))) {
        out.insert("favicon".to_string(), Value::String(favicon_link));
    }

    if let Some(lang) = document.select("html[lang]").map_err(|_| "Failed to select lang")?.next().and_then(|x| x.attributes.borrow().get("lang").map(|x| x.to_string())) {
        out.insert("language".to_string(), Value::String(lang));
    }

    // insert_meta_name!(out, document, "keywords", "keywords");
    // insert_meta_name!(out, document, "robots", "robots");
    insert_meta_property!(out, document, "og:title", "ogTitle");
    insert_meta_property!(out, document, "og:description", "ogDescription");
    insert_meta_property!(out, document, "og:url", "ogUrl");
    insert_meta_property!(out, document, "og:image", "ogImage");
    insert_meta_property!(out, document, "og:audio", "ogAudio");
    insert_meta_property!(out, document, "og:determiner", "ogDeterminer");
    insert_meta_property!(out, document, "og:locale", "ogLocale");

    for meta in document.select("meta[property=\"og:locale:alternate\"]").map_err(|_| "Failed to select og locale alternate")? {
        let attrs = meta.attributes.borrow();

        if let Some(content) = attrs.get("content") {
            if let Some(v) = out.get_mut("ogLocaleAlternate") {
                match v {
                    Value::Array(x) => {
                        x.push(Value::String(content.to_string()));
                    },
                    _ => unreachable!(),
                }
            } else {
                out.insert("ogLocaleAlternate".to_string(), Value::Array(vec! [Value::String(content.to_string())]));
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

    for meta in document.select("meta").map_err(|_| "Failed to select meta")? {
        let meta = meta.as_node().as_element().unwrap();
        let attrs = meta.attributes.borrow();

        if let Some(name) = attrs.get("name").or_else(|| attrs.get("property")).or_else(|| attrs.get("itemprop")) {
            if let Some(content) = attrs.get("content") {
                if let Some(v) = out.get(name) {
                    match v {
                        Value::String(existing) => {
                            if name == "description" {
                                out.insert(name.to_string(), Value::String(format!("{}, {}", existing, content)));
                            } else if name != "title" { // preserve title tag in metadata
                                out.insert(name.to_string(), Value::Array(vec! [Value::String(existing.clone()), Value::String(content.to_string())]));
                            }
                        },
                        Value::Array(existing_array) => {
                            if name == "description" {
                                let mut values: Vec<String> = existing_array.iter()
                                    .filter_map(|v| match v {
                                        Value::String(s) => Some(s.clone()),
                                        _ => None,
                                    })
                                    .collect();
                                values.push(content.to_string());
                                out.insert(name.to_string(), Value::String(values.join(", ")));
                            } else {
                                match out.get_mut(name) {
                                    Some(Value::Array(x)) => {
                                        x.push(Value::String(content.to_string()));
                                    },
                                    _ => unreachable!(),
                                }
                            }
                        },
                        _ => unreachable!(),
                    }
                } else {
                    out.insert(name.to_string(), Value::String(content.to_string()));
                }
            }
        }
    }

    Ok(serde_json::ser::to_string(&out)?)
}

/// Extracts metadata from HTML
/// 
/// # Safety
/// Input options must be a C HTML string. Output will be a JSON object. Output string must be freed with free_string.
#[no_mangle]
pub unsafe extern "C" fn extract_metadata(html: *const libc::c_char) -> *mut libc::c_char {
    let html = match unsafe { CStr::from_ptr(html) }.to_str().map_err(|_| ()) {
        Ok(x) => x,
        Err(_) => {
            return CString::new("RUSTFC:ERROR:Failed to parse input HTML as C string").unwrap().into_raw();
        }
    };

    let metadata_out = match _extract_metadata(html) {
        Ok(x) => x,
        Err(e) => {
            return CString::new(format!("RUSTFC:ERROR:{}", e)).unwrap().into_raw();
        }
    };

    CString::new(metadata_out).unwrap().into_raw()
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

    // swoogo event software as .widget in all of their content
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

#[derive(Deserialize)]
struct TranformHTMLOptions {
    html: String,
    url: String,
    include_tags: Vec<String>,
    exclude_tags: Vec<String>,
    only_main_content: bool,
    omce_signatures: Option<Vec<String>>,
}

struct ImageSource {
    url: String,
    size: f64,
    is_x: bool,
}

fn _transform_html_inner(opts: TranformHTMLOptions) -> Result<String, Box<dyn std::error::Error>> {
    let mut document = parse_html().one(opts.html.as_ref());
    let url = Url::parse(&_extract_base_href_from_document(&document, &Url::parse(&opts.url)?)?)?;

    if !opts.include_tags.is_empty() {
        let new_document = parse_html().one("<div></div>");
        let root = new_document.select_first("div").map_err(|_| "Failed to select root element")?;

        for x in opts.include_tags.iter() {
            let matching_nodes: Vec<_> = document.select(x).map_err(|_| "Failed to include_tags tags")?.collect();
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

    // The first operation applied must be OMCE.
    if opts.only_main_content {
        if let Some(signatures) = opts.omce_signatures.as_ref() {
            let mut nodes_to_drop: Vec<NodeRef> = Vec::new();

            let modes = signatures.iter().map(|x| Into::<SignatureMode>::into(x.split(':').nth(1).unwrap().to_string())).collect::<HashSet<_>>();
            for mode in modes {
                let matcher = format!(":{}:", Into::<String>::into(mode));
                let signatures = signatures.iter().filter(|x| x.contains(&matcher)).cloned().collect::<HashSet<_>>();
                
                for edge in document.traverse() {
                    match edge {
                        NodeEdge::Start(_) => {},
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
        // TODO: implement weird version
        while let Ok(x) = document.select_first(x) {
            x.as_node().detach();
        }
    }

    if opts.only_main_content {
        for x in EXCLUDE_NON_MAIN_TAGS.iter() {
            let x: Vec<_> = document.select(x).map_err(|_| "Failed to select tags")?.collect();
            for tag in x {
                if !FORCE_INCLUDE_MAIN_TAGS.iter().any(|x| tag.as_node().select(x).is_ok_and(|mut x| x.next().is_some())) {
                    tag.as_node().detach();
                }
            }
        }
    }

    let srcset_images: Vec<_> = document.select("img[srcset]").map_err(|_| "Failed to select srcset images")?.collect();
    for img in srcset_images {
        let mut sizes: Vec<ImageSource> = img.attributes.borrow().get("srcset").ok_or("Failed to get srcset")?.split(",").filter_map(|x| {
            let tok: Vec<&str> = x.trim().split(" ").collect();
            let last_token = tok[tok.len() - 1]; // SAFETY: split is guaranteed to return at least one token
            let (last_token, last_token_used) = if tok.len() > 1 && !last_token.is_empty() && (last_token.ends_with("x") || last_token.ends_with("w")) {
                (last_token, true)
            } else {
                ("1x", false)
            };

            // split off the last character of the last token and parse as size
            if let Some((last_index, _)) = last_token.char_indices().last() {
                if let Ok(parsed_size) = last_token[..last_index].parse() {
                    Some(ImageSource {
                        url: if last_token_used { tok[0..tok.len()-1].join(" ") } else { tok.join(" ") },
                        size: parsed_size,
                        is_x: last_token.ends_with("x")
                    })
                } else {
                    None
                }
            } else {
                None
            }
        }).collect();

        if sizes.iter().all(|x| x.is_x) {
            if let Some(src) = img.attributes.borrow().get("src").map(|x| x.to_string()) {
                sizes.push(ImageSource {
                    url: src,
                    size: 1.0,
                    is_x: true,
                });
            }
        }

        sizes.sort_by(|a, b| b.size.partial_cmp(&a.size).unwrap_or(std::cmp::Ordering::Equal));

        if let Some(biggest) = sizes.first() {
            img.attributes.borrow_mut().insert("src", biggest.url.clone());
        }
    }
    
    let src_images: Vec<_> = document.select("img[src]").map_err(|_| "Failed to select src images")?.collect();
    for img in src_images {
        let old = img.attributes.borrow().get("src").map(|x| x.to_string()).ok_or("Failed to get src")?;
        if let Ok(new) = url.join(&old) {
            img.attributes.borrow_mut().insert("src", new.to_string());            
        }
    }

    let href_anchors: Vec<_> = document.select("a[href]").map_err(|_| "Failed to select href anchors")?.collect();
    for anchor in href_anchors {
        let old = anchor.attributes.borrow().get("href").map(|x| x.to_string()).ok_or("Failed to get href")?;
        if let Ok(new) = url.join(&old) {
            anchor.attributes.borrow_mut().insert("href", new.to_string());            
        }
    }

    Ok(document.to_string())
}

/// Transforms rawHtml to html (formerly removeUnwantedElements)
/// 
/// # Safety
/// Input options must be a C JSON string. Output will be an HTML string. Output string must be freed with free_string.
#[no_mangle]
pub unsafe extern "C" fn transform_html(opts: *const libc::c_char) -> *mut libc::c_char {
    let opts: TranformHTMLOptions = match unsafe { CStr::from_ptr(opts) }.to_str().map_err(|_| ()).and_then(|x| serde_json::de::from_str(x).map_err(|_| ())) {
        Ok(x) => x,
        Err(_) => {
            return CString::new("RUSTFC:ERROR").unwrap().into_raw();
        }
    };

    let out = match _transform_html_inner(opts) {
        Ok(x) => x,
        Err(e) => format!("RUSTFC:ERROR:{}", e),
    };

    CString::new(out).unwrap().into_raw()
}

fn _get_inner_json(html: &str) -> Result<String, ()> {
    Ok(parse_html().one(html).select_first("body")?.text_contents())
}

/// For JSON pages retrieved by browser engines, this function can be used to transform it back into valid JSON.
/// 
/// # Safety
/// Input must be a C HTML string. Output will be an HTML string. Output string must be freed with free_string.
#[no_mangle]
pub unsafe extern "C" fn get_inner_json(html: *const libc::c_char) -> *mut libc::c_char {
    let html = match unsafe { CStr::from_ptr(html) }.to_str().map_err(|_| ()) {
        Ok(x) => x,
        Err(_) => {
            return CString::new("RUSTFC:ERROR:Failed to parse input HTML as C string").unwrap().into_raw();
        }
    };

    let out = match _get_inner_json(html) {
        Ok(x) => x,
        Err(_) => "RUSTFC:ERROR".to_string(),
    };

    CString::new(out).unwrap().into_raw()
}

#[derive(Deserialize)]
struct AttributeSelector {
    selector: String,
    attribute: String,
}

#[derive(Deserialize)]
struct ExtractAttributesOptions {
    selectors: Vec<AttributeSelector>,
}

fn _extract_attributes(html: &str, options: &ExtractAttributesOptions) -> Result<String, Box<dyn std::error::Error>> {
    let document = parse_html().one(html);
    let mut results = Vec::new();

    for selector_config in &options.selectors {
        let mut values = Vec::new();

        let elements: Vec<_> = match document.select(&selector_config.selector).map_err(|_| format!("Failed to select with selector: {}", selector_config.selector)) {
            Ok(x) => x.collect(),
            Err(_) => {
                // Return empty values for invalid selectors rather than failing completely
                Vec::new()
            }
        };

        for element in elements {
            // Try the attribute as-is first
            if let Some(attr_value) = element.attributes.borrow().get(selector_config.attribute.as_str()) {
                values.push(attr_value.to_string());
                continue;
            }

            // If not found and doesn't start with 'data-', try with 'data-' prefix
            if !selector_config.attribute.starts_with("data-") {
                let data_attr = format!("data-{}", selector_config.attribute);
                if let Some(attr_value) = element.attributes.borrow().get(data_attr.as_str()) {
                    values.push(attr_value.to_string());
                }
            }
        }

        results.push(serde_json::json!({
            "selector": selector_config.selector,
            "attribute": selector_config.attribute,
            "values": values
        }));
    }

    Ok(serde_json::to_string(&results)?)
}

/// Extracts attributes from HTML elements using CSS selectors
/// 
/// # Safety
/// html must be a C HTML string. options must be a C JSON string with format:
/// {"selectors": [{"selector": "...", "attribute": "..."}]}
/// Output will be a JSON string. Output string must be freed with free_string.
#[no_mangle]
pub unsafe extern "C" fn extract_attributes(html: *const libc::c_char, options: *const libc::c_char) -> *mut libc::c_char {
    let html = match unsafe { CStr::from_ptr(html) }.to_str().map_err(|_| ()) {
        Ok(x) => x,
        Err(_) => {
            return CString::new("RUSTFC:ERROR:Failed to parse input HTML as C string").unwrap().into_raw();
        }
    };

    let options_str = match unsafe { CStr::from_ptr(options) }.to_str().map_err(|_| ()) {
        Ok(x) => x,
        Err(_) => {
            return CString::new("RUSTFC:ERROR:Failed to parse input options as C string").unwrap().into_raw();
        }
    };

    let parsed_options: ExtractAttributesOptions = match serde_json::from_str(options_str) {
        Ok(x) => x,
        Err(e) => {
            return CString::new(format!("RUSTFC:ERROR:Failed to parse options JSON: {}", e)).unwrap().into_raw();
        }
    };

    let result = match _extract_attributes(html, &parsed_options) {
        Ok(x) => x,
        Err(e) => {
            return CString::new(format!("RUSTFC:ERROR:{}", e)).unwrap().into_raw();
        }
    };

    CString::new(result).unwrap().into_raw()
}

/// Frees a string allocated in Rust-land.
/// 
/// # Safety
/// ptr must be a non-freed string pointer returned by Rust code.
#[no_mangle]
pub unsafe extern "C" fn free_string(ptr: *mut libc::c_char) {
    drop(unsafe { CString::from_raw(ptr) })
}
