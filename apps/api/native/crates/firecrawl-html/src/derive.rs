//! Single-pass HTML cleaning and extraction over one `kuchikiki` DOM parse.

use std::collections::{BTreeMap, HashSet};

use firecrawl_core_types::{
  CoreNativeError, DeriveCoreHtmlRequest, DeriveCoreHtmlResult, ExtractedAttribute,
};
use kuchikiki::{NodeRef, parse_html, traits::TendrilSink};
use serde_json::Value;
use url::Url;

use crate::html::{
  AttributeSelector, ExtractAttributesOptions, TransformHtmlOptions, base_href_of_document,
  extract_attributes_from_document, extract_images_from_document, extract_links_from_document,
  extract_metadata_from_document, transform_document,
};
use crate::markdown_links::{extract_links_from_markdown, is_markdown_content_type};

/// Resolves raw `a[href]` values against the document's `<base href>` and
/// `base_url`, preserving insertion order while deduplicating, matching
/// `apps/api/src/scraper/scrapeURL/lib/extractLinks.ts`.
pub fn resolve_links_from_document(
  document: &NodeRef,
  base_url: &Url,
) -> Result<Vec<String>, CoreNativeError> {
  let raw_hrefs = extract_links_from_document(document)
    .map_err(|message| CoreNativeError::HtmlProcessing { message })?;
  let base_href = base_href_of_document(document, base_url);
  let resolution_base = Url::parse(&base_href).unwrap_or_else(|_| base_url.clone());

  let mut seen = HashSet::with_capacity(raw_hrefs.len());
  let mut links = Vec::with_capacity(raw_hrefs.len());

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
      links.push(url);
    }
  }

  Ok(links)
}

/// Parses `raw_html` once into a `kuchikiki` DOM and performs metadata
/// extraction (pre-cleaning) followed by HTML cleaning and post-cleaning
/// link, image, and attribute extraction.
pub fn derive_core_html(
  raw_html: &str,
  request: &DeriveCoreHtmlRequest,
) -> Result<DeriveCoreHtmlResult, CoreNativeError> {
  let base_url = Url::parse(&request.url).map_err(|err| CoreNativeError::HtmlProcessing {
    message: format!("invalid url: {err}"),
  })?;

  let document = parse_html().one(raw_html).document_node;

  // Metadata reads <head>, <title>, <meta>, and <link rel="icon"> before cleaning strips them.
  let metadata = if request.need_metadata {
    let extracted =
      extract_metadata_from_document(&document).map_err(|err| CoreNativeError::HtmlProcessing {
        message: err.to_string(),
      })?;
    Some(extracted.into_iter().collect::<BTreeMap<String, Value>>())
  } else {
    None
  };

  let transform_opts = TransformHtmlOptions {
    html: String::new(),
    url: request.url.clone(),
    include_tags: request.include_tags.clone(),
    exclude_tags: request.exclude_tags.clone(),
    only_main_content: request.only_main_content,
    omce_signatures: request.drop_signatures.clone(),
  };

  let cleaned_doc = transform_document(document, &transform_opts).map_err(|err| {
    CoreNativeError::HtmlProcessing {
      message: err.to_string(),
    }
  })?;

  let html = cleaned_doc.to_string();

  let links = if request.need_links {
    if is_markdown_content_type(request.content_type.as_deref()) {
      Some(extract_links_from_markdown(raw_html, &base_url))
    } else {
      Some(resolve_links_from_document(&cleaned_doc, &base_url)?)
    }
  } else {
    None
  };

  let images = if request.need_images {
    let extracted = extract_images_from_document(&cleaned_doc, &base_url).map_err(|err| {
      CoreNativeError::HtmlProcessing {
        message: err.to_string(),
      }
    })?;
    Some(extracted)
  } else {
    None
  };

  let attributes = match request.attributes.as_ref() {
    Some(selectors) => {
      let opts = ExtractAttributesOptions {
        selectors: selectors
          .iter()
          .map(|item| AttributeSelector {
            selector: item.selector.clone(),
            attribute: item.attribute.clone(),
          })
          .collect(),
      };
      let extracted = extract_attributes_from_document(&cleaned_doc, &opts).map_err(|err| {
        CoreNativeError::HtmlProcessing {
          message: err.to_string(),
        }
      })?;
      Some(
        extracted
          .into_iter()
          .map(|item| ExtractedAttribute {
            selector: item.selector,
            attribute: item.attribute,
            values: item.values,
          })
          .collect(),
      )
    }
    None => None,
  };

  let span = tracing::Span::current();
  span.record("html_len", html.len());
  span.record(
    "metadata_count",
    metadata.as_ref().map_or(0usize, BTreeMap::len),
  );
  span.record("links_count", links.as_ref().map_or(0usize, Vec::len));
  span.record("images_count", images.as_ref().map_or(0usize, Vec::len));
  span.record(
    "attributes_count",
    attributes.as_ref().map_or(0usize, Vec::len),
  );
  span.record("remove_base64_images", request.remove_base64_images);

  Ok(DeriveCoreHtmlResult {
    html,
    metadata,
    links,
    images,
    attributes,
  })
}
