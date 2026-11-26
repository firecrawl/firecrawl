use std::collections::{BTreeMap, HashSet};

use firecrawl_core_types::{AttributeRequest, CoreNativeError, DeriveCoreHtmlRequest};
use hegel::{TestCase, generators as gs};
use serde_json::Value;
use url::Url;

use crate::derive::derive_core_html;
use crate::html::{
  AttributeSelector, ExtractAttributesOptions, TransformHtmlOptions, extract_attributes,
  extract_base_href, extract_images, extract_links, extract_metadata, transform_html,
};
use crate::markdown_links::extract_links_from_markdown;

const SAFE_INCLUDE_SELECTORS: &[&str] = &[
  "article", "main", "section", "div", "p", ".card", "#content", "ul",
];
const SAFE_EXCLUDE_SELECTORS: &[&str] = &[
  ".ad",
  ".promo",
  "aside",
  "footer",
  "nav",
  ".sidebar",
  "[data-skip=\"1\"]",
];
const ATTR_SELECTORS: &[&str] = &[
  "a", "img", "div", "article", "section", ".card", "p", "span",
];
const ATTR_NAMES: &[&str] = &[
  "href", "src", "id", "class", "role", "data-id", "sku", "data-sku", "missing",
];
const SAMPLE_URLS: &[&str] = &[
  "https://example.com/articles/post-1",
  "https://docs.example.org/v2/guide/",
  "http://sub.example.net:8080/path/index.html?q=1",
];
const SAMPLE_BASE_HREFS: &[Option<&str>] = &[
  None,
  Some("/"),
  Some("/nested/"),
  Some("https://cdn.example.com/assets/"),
];
const SAMPLE_HREFS: &[&str] = &[
  "/about",
  "relative/page.html",
  "../up",
  "https://external.example.org/doc",
  "http://legacy.example.com/item",
  "mailto:team@example.com",
  "#section-1",
  "http:/fixed.example.com/one",
  "https:/fixed.example.com/two",
  "  /trimmed/path  ",
  "javascript:void(0)",
  "",
];
const SAMPLE_IMG_SRCS: &[&str] = &[
  "/img/hero.png",
  "photos/pic.jpg",
  "https://cdn.example.com/banner.webp",
  "//static.example.com/proto.png",
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==",
  "blob:https://example.com/1234",
];
const SAMPLE_SRCSETS: &[&str] = &[
  "small.jpg 480w, large.jpg 1200w",
  "a.png 1x, b.png 2x",
  "broken.png NaNx, fallback.png 1x",
  "inf.png infw, valid.png 800w",
];

fn escape_attr(s: &str) -> String {
  s.replace('&', "&amp;")
    .replace('"', "&quot;")
    .replace('<', "&lt;")
    .replace('>', "&gt;")
}

#[hegel::composite]
fn generated_html_document(tc: &TestCase) -> String {
  let lang = tc.draw(gs::sampled_from(&["en", "fr", "hu", ""]));
  let title = escape_attr(&tc.draw(gs::text().max_size(32)));
  let desc1 = escape_attr(&tc.draw(gs::text().max_size(32)));
  let desc2 = escape_attr(&tc.draw(gs::text().max_size(24)));
  let base_href = tc.draw(gs::sampled_from(SAMPLE_BASE_HREFS));

  let mut html = String::from("<!DOCTYPE html><html");
  if !lang.is_empty() {
    html.push_str(&format!(" lang=\"{lang}\""));
  }
  html.push_str("><head>");
  if let Some(bh) = base_href {
    html.push_str(&format!("<base href=\"{bh}\">"));
  }
  if !title.is_empty() {
    html.push_str(&format!("<title>{title}</title>"));
  }
  if tc.draw(gs::booleans()) {
    html.push_str("<link rel=\"icon\" href=\"/favicon.ico\">");
  }
  html.push_str(&format!("<meta name=\"description\" content=\"{desc1}\">"));
  if tc.draw(gs::booleans()) {
    html.push_str(&format!("<meta name=\"description\" content=\"{desc2}\">"));
  }
  if tc.draw(gs::booleans()) {
    html.push_str(
      "<meta property=\"og:title\" content=\"OG Title\">\
       <meta property=\"og:image\" content=\"https://example.com/og.png\">\
       <meta property=\"og:locale:alternate\" content=\"de_DE\">\
       <meta property=\"og:locale:alternate\" content=\"es_ES\">",
    );
  }
  html.push_str("<style>.x { color: red; }</style><script>console.log(1)</script></head><body>");

  if tc.draw(gs::booleans()) {
    html.push_str("<header class=\"header\"><nav><a href=\"/nav-link\">Nav</a></nav>");
    if tc.draw(gs::booleans()) {
      html.push_str("<div id=\"main\"><a href=\"/kept-in-header\">Kept</a></div>");
    }
    html.push_str("</header>");
  }

  html
    .push_str("<main id=\"content\"><article class=\"card\" data-id=\"art-1\" data-sku=\"sku-9\">");
  for i in 0..tc.draw(gs::integers::<usize>().max_value(5)) {
    let href = escape_attr(tc.draw(gs::sampled_from(SAMPLE_HREFS)));
    html.push_str(&format!(
      "<a href=\"{href}\" data-id=\"link-{i}\">Link {i}</a>"
    ));
  }
  for i in 0..tc.draw(gs::integers::<usize>().max_value(4)) {
    let src = escape_attr(tc.draw(gs::sampled_from(SAMPLE_IMG_SRCS)));
    html.push_str(&format!("<img src=\"{src}\""));
    if tc.draw(gs::booleans()) {
      let srcset = escape_attr(tc.draw(gs::sampled_from(SAMPLE_SRCSETS)));
      html.push_str(&format!(" srcset=\"{srcset}\""));
    }
    if tc.draw(gs::booleans()) {
      html.push_str(&format!(" data-src=\"/lazy/{i}.jpg\""));
    }
    html.push('>');
  }
  if tc.draw(gs::booleans()) {
    html.push_str(
      "<picture><source srcset=\"pic-1.avif 1x, pic-2.avif 2x\"><img src=\"pic.jpg\"></picture>",
    );
  }
  if tc.draw(gs::booleans()) {
    html.push_str("<video poster=\"/poster.jpg\"></video>");
  }
  if tc.draw(gs::booleans()) {
    html.push_str("<div style=\"background-image: url('/bg/hero.png')\">Bg</div>");
  }
  html.push_str(
    "<div class=\"ad\" data-skip=\"1\"><a href=\"/ad-click\">Ad</a></div>\
     <noscript><img src=\"/noscript.png\"></noscript>\
     <section><p role=\"note\">Hello world paragraph content.</p></section>\
     </article></main>",
  );
  if tc.draw(gs::booleans()) {
    html.push_str("<footer><a href=\"/privacy\">Privacy</a></footer>");
  }
  html.push_str("</body></html>");
  html
}

fn legacy_resolve_links(cleaned_html: &str, base_url: &str) -> Result<Vec<String>, String> {
  let raw_hrefs = extract_links(cleaned_html)?;
  let base_href = extract_base_href(cleaned_html, base_url).map_err(|e| e.to_string())?;
  let parsed_base = Url::parse(base_url).map_err(|e| e.to_string())?;
  let resolution_base = Url::parse(&base_href).unwrap_or(parsed_base);

  let mut seen = HashSet::new();
  let mut out = Vec::new();
  for raw_href in raw_hrefs {
    let href = raw_href.trim();
    let resolved =
      if href.starts_with("http://") || href.starts_with("https://") || href.starts_with("mailto:")
      {
        Some(href.to_string())
      } else if href.starts_with('#') {
        None
      } else {
        resolution_base.join(href).ok().map(String::from)
      };
    if let Some(url) = resolved
      && !url.is_empty()
      && seen.insert(url.clone())
    {
      out.push(url);
    }
  }
  Ok(out)
}

/// Untrusted input panic-freedom: arbitrary UTF-8 HTML, URLs, selectors,
/// colonless `drop_signatures`, and `srcset` descriptors must never panic.
#[hegel::test]
fn derive_core_html_never_panics_on_arbitrary_input(tc: TestCase) {
  let raw_html = if tc.draw(gs::booleans()) {
    tc.draw(gs::text().max_size(512))
  } else {
    let inner = tc.draw(gs::text().max_size(128));
    let srcset = tc.draw(gs::text().max_size(96));
    let href = tc.draw(gs::text().max_size(64));
    format!(
      "<html><head><title>{inner}</title><meta name=\"description\" content=\"{inner}\"></head>\
       <body><img src=\"{href}\" srcset=\"{srcset}\" data-srcset=\"{srcset}\"><a href=\"{href}\">{inner}</a></body></html>"
    )
  };
  let url = if tc.draw(gs::booleans()) {
    tc.draw(gs::sampled_from(SAMPLE_URLS)).to_string()
  } else {
    tc.draw(gs::text().max_size(64))
  };
  let attributes = tc.draw(gs::booleans()).then(|| {
    (0..tc.draw(gs::integers::<usize>().max_value(3)))
      .map(|_| AttributeRequest {
        selector: tc.draw(gs::text().max_size(24)),
        attribute: tc.draw(gs::text().max_size(24)),
      })
      .collect()
  });
  let content_type = tc
    .draw(gs::sampled_from(&[
      None,
      Some("text/html; charset=utf-8"),
      Some("text/plain"),
      Some("text/markdown"),
    ]))
    .map(ToString::to_string);

  let request = DeriveCoreHtmlRequest {
    url,
    content_type,
    only_main_content: tc.draw(gs::booleans()),
    include_tags: tc.draw(gs::vecs(gs::text().max_size(24)).max_size(3)),
    exclude_tags: tc.draw(gs::vecs(gs::text().max_size(24)).max_size(3)),
    drop_signatures: tc
      .draw(gs::booleans())
      .then(|| tc.draw(gs::vecs(gs::text().max_size(32)).max_size(4))),
    need_metadata: tc.draw(gs::booleans()),
    need_links: tc.draw(gs::booleans()),
    need_images: tc.draw(gs::booleans()),
    attributes,
    remove_base64_images: tc.draw(gs::booleans()),
  };

  match derive_core_html(&raw_html, &request) {
    Ok(res) => {
      assert_eq!(res.metadata.is_some(), request.need_metadata);
      assert_eq!(res.links.is_some(), request.need_links);
      assert_eq!(res.images.is_some(), request.need_images);
      assert_eq!(res.attributes.is_some(), request.attributes.is_some());
    }
    Err(CoreNativeError::HtmlProcessing { message }) => assert!(!message.is_empty()),
    Err(other) => assert!(
      matches!(other, CoreNativeError::HtmlProcessing { .. }),
      "unexpected error variant: {other:?}"
    ),
  }
}

/// Exact single-pass equivalence: for arbitrary generated HTML documents and
/// options, `derive_core_html` matches the multi-parse individual pipeline.
#[hegel::test]
fn derive_core_html_matches_individual_pipeline(tc: TestCase) {
  let raw_html = tc.draw(generated_html_document());
  let url = tc.draw(gs::sampled_from(SAMPLE_URLS)).to_string();
  let only_main_content = tc.draw(gs::booleans());
  let include_tags: Vec<String> = (0..tc.draw(gs::integers::<usize>().max_value(2)))
    .map(|_| {
      tc.draw(gs::sampled_from(SAFE_INCLUDE_SELECTORS))
        .to_string()
    })
    .collect();
  let exclude_tags: Vec<String> = (0..tc.draw(gs::integers::<usize>().max_value(2)))
    .map(|_| {
      tc.draw(gs::sampled_from(SAFE_EXCLUDE_SELECTORS))
        .to_string()
    })
    .collect();
  let drop_signatures = tc.draw(gs::booleans()).then(|| {
    vec![
      "v0:cit:deadbeef".to_string(),
      "colonless-signature".to_string(),
    ]
  });
  let need_metadata = tc.draw(gs::booleans());
  let need_links = tc.draw(gs::booleans());
  let need_images = tc.draw(gs::booleans());
  let attributes = tc.draw(gs::booleans()).then(|| {
    (0..tc.draw(gs::integers::<usize>().max_value(3)))
      .map(|_| AttributeRequest {
        selector: tc.draw(gs::sampled_from(ATTR_SELECTORS)).to_string(),
        attribute: tc.draw(gs::sampled_from(ATTR_NAMES)).to_string(),
      })
      .collect::<Vec<_>>()
  });

  let request = DeriveCoreHtmlRequest {
    url: url.clone(),
    content_type: Some("text/html; charset=utf-8".to_string()),
    only_main_content,
    include_tags: include_tags.clone(),
    exclude_tags: exclude_tags.clone(),
    drop_signatures: drop_signatures.clone(),
    need_metadata,
    need_links,
    need_images,
    attributes: attributes.clone(),
    remove_base64_images: tc.draw(gs::booleans()),
  };

  let single_pass = derive_core_html(&raw_html, &request);
  assert!(
    single_pass.is_ok(),
    "derive_core_html failed: {single_pass:?}"
  );
  let Ok(actual) = single_pass else {
    return;
  };

  let expected_metadata: Option<BTreeMap<String, Value>> = need_metadata.then(|| {
    let raw_meta = extract_metadata(&raw_html);
    assert!(raw_meta.is_ok(), "extract_metadata failed: {raw_meta:?}");
    raw_meta.unwrap_or_default().into_iter().collect()
  });
  let expected_html_res = transform_html(TransformHtmlOptions {
    html: raw_html,
    url: url.clone(),
    include_tags,
    exclude_tags,
    only_main_content,
    omce_signatures: drop_signatures,
  });
  assert!(
    expected_html_res.is_ok(),
    "transform_html failed: {expected_html_res:?}"
  );
  let Ok(expected_html) = expected_html_res else {
    return;
  };

  let expected_links = need_links.then(|| {
    let res = legacy_resolve_links(&expected_html, &url);
    assert!(res.is_ok(), "legacy_resolve_links failed: {res:?}");
    res.unwrap_or_default()
  });
  let expected_images = need_images.then(|| {
    let res = extract_images(&expected_html, &url);
    assert!(res.is_ok(), "extract_images failed: {res:?}");
    res.unwrap_or_default()
  });
  let expected_attributes = attributes.map(|selectors| {
    let opts = ExtractAttributesOptions {
      selectors: selectors
        .into_iter()
        .map(|s| AttributeSelector {
          selector: s.selector,
          attribute: s.attribute,
        })
        .collect(),
    };
    let res = extract_attributes(&expected_html, &opts);
    assert!(res.is_ok(), "extract_attributes failed: {res:?}");
    res
      .unwrap_or_default()
      .into_iter()
      .map(|item| firecrawl_core_types::ExtractedAttribute {
        selector: item.selector,
        attribute: item.attribute,
        values: item.values,
      })
      .collect::<Vec<_>>()
  });

  assert_eq!(actual.html, expected_html);
  assert_eq!(actual.metadata, expected_metadata);
  assert_eq!(actual.links, expected_links);
  assert_eq!(actual.images, expected_images);
  assert_eq!(actual.attributes, expected_attributes);
}

/// Markdown link extraction never panics on arbitrary text, returns unique
/// non-empty links, and excludes links inside fenced code blocks, inline code
/// spans (including unmatched backtick runs), and image syntax.
#[hegel::test]
fn markdown_links_never_panic_and_deduplicate(tc: TestCase) {
  let text = tc.draw(gs::text().max_size(512));
  let slug = tc.draw(gs::sampled_from(vec!["alpha", "beta", "gamma", "delta"]));
  let Some(base_url) = Url::parse("https://example.com/docs/").ok() else {
    return;
  };
  let links = extract_links_from_markdown(&text, &base_url);
  let unique: HashSet<&str> = links.iter().map(String::as_str).collect();
  assert_eq!(links.len(), unique.len());
  assert!(links.iter().all(|l| !l.is_empty()));

  let doc = format!(
    "```\nhttps://fenced.invalid/{slug}\n```\n![img](https://img.invalid/{slug}.png)\nprefix ``` [a](https://span.invalid/{slug}) `y`\n[keep](https://keep.example.com/{slug})"
  );
  let extracted = extract_links_from_markdown(&doc, &base_url);
  assert_eq!(extracted, vec![format!("https://keep.example.com/{slug}")]);
}
