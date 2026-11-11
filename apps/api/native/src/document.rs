use crate::xml::exceeds_element_depth;
use napi::bindgen_prelude::*;
use napi_derive::napi;
use roxmltree::Document;
use std::collections::{HashMap, HashSet};
use std::io::{Cursor, Read};

const MAX_OOXML_PART_BYTES: u64 = 128 * 1024 * 1024;
const MAX_OOXML_TOTAL_BYTES: u64 = 128 * 1024 * 1024;
const MAX_OOXML_PARTS: usize = 256;
const MAX_HEADER_FOOTER_REFERENCES: usize = 256;
// roxmltree parses recursively with no depth bound, and a stack overflow is
// not an error but an abort of the whole process. Matches anydoc's own limit.
const MAX_XML_DEPTH: usize = 256;
const WORDPROCESSINGML_NAMESPACES: [&str; 2] = [
  "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
  "http://purl.oclc.org/ooxml/wordprocessingml/main",
];

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
enum RepeatingPartKind {
  Header,
  Footer,
}

struct Relationship {
  target: String,
  kind: RepeatingPartKind,
}

struct ZipReadBudget {
  bytes_remaining: u64,
  parts_remaining: usize,
}

impl Default for ZipReadBudget {
  fn default() -> Self {
    Self {
      bytes_remaining: MAX_OOXML_TOTAL_BYTES,
      parts_remaining: MAX_OOXML_PARTS,
    }
  }
}

/// Convert a document (doc, docx, odt/ods/odp, rtf, xls/xlsx, ppt/pptx, epub,
/// csv, ...) to GitHub-Flavored Markdown using anydoc. The format is detected
/// from the file content; `extension_hint` (with or without a leading dot) is
/// only consulted for signature-less formats like CSV.
///
/// Runs on tokio's blocking thread pool, like the PDF functions: conversion is
/// CPU-bound and would otherwise hold the Node.js event loop for its duration.
#[napi]
pub async fn convert_document_to_markdown(
  data: Uint8Array,
  extension_hint: Option<String>,
) -> Result<String> {
  let bytes = data.to_vec();
  tokio::task::spawn_blocking(move || convert_document_bytes_to_markdown(&bytes, extension_hint))
    .await
    .map_err(|e| {
      Error::new(
        Status::GenericFailure,
        format!("Document conversion task failed: {e}"),
      )
    })?
}

fn convert_document_bytes_to_markdown(
  data: &[u8],
  extension_hint: Option<String>,
) -> Result<String> {
  let format = anydoc::Format::from_bytes(data).or_else(|| {
    extension_hint
      .as_deref()
      .map(|ext| ext.trim_start_matches('.'))
      .and_then(anydoc::Format::from_extension)
  });

  let markdown = anydoc::to_markdown_bytes(data, format)
    .map_err(|e| Error::new(Status::GenericFailure, e.to_string()))?;

  if format != Some(anydoc::Format::Docx) {
    return Ok(markdown);
  }

  let (headers, footers) = extract_docx_headers_and_footers(data);
  if headers.is_empty() && footers.is_empty() {
    return Ok(markdown);
  }
  let sections = [headers, markdown.trim().to_string(), footers]
    .into_iter()
    .filter(|section| !section.is_empty())
    .collect::<Vec<_>>();

  Ok(format!("{}\n", sections.join("\n\n")))
}

fn extract_docx_headers_and_footers(data: &[u8]) -> (String, String) {
  let Ok(mut archive) = zip::ZipArchive::new(Cursor::new(data)) else {
    return (String::new(), String::new());
  };
  let mut budget = ZipReadBudget::default();

  let main_part = read_zip_text(&mut archive, "_rels/.rels", &mut budget)
    .and_then(|xml| office_document_target(&xml))
    .unwrap_or_else(|| "word/document.xml".to_string());
  let Some(document_xml) = read_zip_text(&mut archive, &main_part, &mut budget) else {
    return (String::new(), String::new());
  };
  let relationship_part = relationship_part_for(&main_part);
  let Some(relationships_xml) = read_zip_text(&mut archive, &relationship_part, &mut budget) else {
    return (String::new(), String::new());
  };
  let relationships = parse_repeating_relationships(&relationships_xml);
  let Some(document) = parse_xml_bounded(&document_xml) else {
    return (String::new(), String::new());
  };

  let mut seen = HashSet::new();
  let mut headers = Vec::new();
  let mut footers = Vec::new();
  let mut reference_count = 0;

  for reference in document
    .descendants()
    .filter(|node| is_wordprocessing_node(*node))
  {
    let reference_kind = match reference.tag_name().name() {
      "headerReference" => RepeatingPartKind::Header,
      "footerReference" => RepeatingPartKind::Footer,
      _ => continue,
    };
    reference_count += 1;
    if reference_count > MAX_HEADER_FOOTER_REFERENCES {
      break;
    }
    let Some(id) = reference
      .attributes()
      .find(|attribute| attribute.name() == "id")
      .map(|attribute| attribute.value())
    else {
      continue;
    };
    let Some(relationship) = relationships.get(id) else {
      continue;
    };
    if relationship.kind != reference_kind {
      continue;
    }
    let Some(part) = resolve_part(&main_part, &relationship.target) else {
      continue;
    };
    if !seen.insert((reference_kind, part.clone())) {
      continue;
    }
    let Some(xml) = read_zip_text(&mut archive, &part, &mut budget) else {
      continue;
    };
    let Some(text) = extract_wordprocessing_text(&xml) else {
      continue;
    };

    match reference_kind {
      RepeatingPartKind::Header => headers.push(text),
      RepeatingPartKind::Footer => footers.push(text),
    }
  }

  (headers.join("\n\n"), footers.join("\n\n"))
}

/// Parses an XML part only when its element nesting stays within
/// `MAX_XML_DEPTH`. The scan is a flat pass over the text, so an over-deep
/// part is rejected before any recursion happens.
fn parse_xml_bounded(xml: &str) -> Option<Document<'_>> {
  if exceeds_element_depth(xml, MAX_XML_DEPTH) {
    return None;
  }
  Document::parse(xml).ok()
}

fn read_zip_text<R: Read + std::io::Seek>(
  archive: &mut zip::ZipArchive<R>,
  name: &str,
  budget: &mut ZipReadBudget,
) -> Option<String> {
  if budget.parts_remaining == 0 || budget.bytes_remaining == 0 {
    return None;
  }
  let mut file = archive.by_name(name.trim_start_matches('/')).ok()?;
  if file.size() > MAX_OOXML_PART_BYTES || file.size() > budget.bytes_remaining {
    return None;
  }
  budget.parts_remaining -= 1;
  let mut bytes = Vec::with_capacity(file.size() as usize);
  let read_limit = MAX_OOXML_PART_BYTES.min(budget.bytes_remaining);
  let read_result = file.by_ref().take(read_limit + 1).read_to_end(&mut bytes);
  budget.bytes_remaining = budget.bytes_remaining.saturating_sub(bytes.len() as u64);
  if read_result.is_err() {
    return None;
  }
  if bytes.len() as u64 > read_limit {
    budget.bytes_remaining = 0;
    return None;
  }
  String::from_utf8(bytes).ok()
}

fn office_document_target(xml: &str) -> Option<String> {
  let document = parse_xml_bounded(xml)?;
  let relationship = document.descendants().find(|node| {
    node.is_element()
      && node.tag_name().name() == "Relationship"
      && node
        .attribute("Type")
        .is_some_and(|value| value.ends_with("/officeDocument"))
  })?;
  normalize_part(relationship.attribute("Target")?)
}

fn parse_repeating_relationships(xml: &str) -> HashMap<String, Relationship> {
  let Some(document) = parse_xml_bounded(xml) else {
    return HashMap::new();
  };

  document
    .descendants()
    .filter_map(|node| {
      if !node.is_element()
        || node.tag_name().name() != "Relationship"
        || node
          .attribute("TargetMode")
          .is_some_and(|value| value.eq_ignore_ascii_case("external"))
      {
        return None;
      }
      let kind = match node.attribute("Type")? {
        value if value.ends_with("/header") => RepeatingPartKind::Header,
        value if value.ends_with("/footer") => RepeatingPartKind::Footer,
        _ => return None,
      };
      Some((
        node.attribute("Id")?.to_string(),
        Relationship {
          target: node.attribute("Target")?.to_string(),
          kind,
        },
      ))
    })
    .collect()
}

fn relationship_part_for(part: &str) -> String {
  match part.rsplit_once('/') {
    Some((parent, file_name)) => format!("{parent}/_rels/{file_name}.rels"),
    None => format!("_rels/{part}.rels"),
  }
}

fn resolve_part(base: &str, target: &str) -> Option<String> {
  if target.starts_with('/') {
    return normalize_part(target);
  }
  let parent = base
    .rsplit_once('/')
    .map(|(parent, _)| parent)
    .unwrap_or("");
  normalize_part(&format!("{parent}/{target}"))
}

fn normalize_part(part: &str) -> Option<String> {
  let mut normalized = Vec::new();
  for component in part.trim_start_matches('/').split('/') {
    match component {
      "" | "." => {}
      ".." => normalized.pop().map(|_| ())?,
      value => normalized.push(value),
    }
  }
  (!normalized.is_empty()).then(|| normalized.join("/"))
}

fn extract_wordprocessing_text(xml: &str) -> Option<String> {
  let document = parse_xml_bounded(xml)?;
  let paragraphs = document
    .descendants()
    .filter(|node| {
      is_wordprocessing_node(*node)
        && node.tag_name().name() == "p"
        && !node
          .ancestors()
          .skip(1)
          .any(|ancestor| is_wordprocessing_node(ancestor) && ancestor.tag_name().name() == "p")
    })
    .filter_map(|paragraph| {
      let mut text = String::new();
      for node in paragraph
        .descendants()
        .filter(|node| is_wordprocessing_node(*node))
      {
        match node.tag_name().name() {
          "t" => {
            if let Some(value) = node.text() {
              text.push_str(value);
            }
          }
          "tab" => text.push('\t'),
          "br" | "cr" => text.push('\n'),
          _ => {}
        }
      }
      let text = text.trim();
      (!text.is_empty()).then(|| text.to_string())
    })
    .collect::<Vec<_>>();

  (!paragraphs.is_empty()).then(|| paragraphs.join("\n\n"))
}

fn is_wordprocessing_node(node: roxmltree::Node<'_, '_>) -> bool {
  node.is_element()
    && node
      .tag_name()
      .namespace()
      .is_some_and(|namespace| WORDPROCESSINGML_NAMESPACES.contains(&namespace))
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::io::Write;
  use zip::write::SimpleFileOptions;

  const W: &str = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
  const R: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

  fn nested(depth: usize, leaf: &str) -> String {
    let mut xml = String::new();
    for _ in 0..depth {
      xml.push_str("<a>");
    }
    xml.push_str(leaf);
    for _ in 0..depth {
      xml.push_str("</a>");
    }
    xml
  }

  #[test]
  fn over_deep_part_is_rejected_without_parsing() {
    assert!(parse_xml_bounded(&nested(MAX_XML_DEPTH + 1, "x")).is_none());
    assert!(parse_xml_bounded(&nested(MAX_XML_DEPTH, "x")).is_some());
  }

  #[test]
  fn deep_header_part_does_not_abort_extraction() {
    // Deep enough that a recursive parse would exhaust the stack; the depth
    // scan must turn it away first.
    let header = format!(
      "<w:hdr xmlns:w=\"{W}\">{}</w:hdr>",
      nested(200_000, "<w:p><w:r><w:t>deep</w:t></w:r></w:p>")
    );
    assert!(extract_wordprocessing_text(&header).is_none());
  }

  fn docx_with_header(header_xml: &str) -> Vec<u8> {
    docx_with_parts(header_xml, None)
  }

  fn docx_with_parts(header_xml: &str, footer_xml: Option<&str>) -> Vec<u8> {
    let mut cursor = Cursor::new(Vec::new());
    {
      let mut writer = zip::ZipWriter::new(&mut cursor);
      let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
      let footer_reference = footer_xml
        .map(|_| "<w:footerReference w:type=\"default\" r:id=\"rId3\"/>")
        .unwrap_or("");
      let footer_relationship = footer_xml
        .map(|_| format!("<Relationship Id=\"rId3\" Type=\"{R}/footer\" Target=\"footer1.xml\"/>"))
        .unwrap_or_default();
      let mut parts: Vec<(&str, String)> = vec![
        (
          "_rels/.rels",
          format!(
            "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"{R}/officeDocument\" Target=\"word/document.xml\"/></Relationships>"
          ),
        ),
        (
          "word/document.xml",
          format!(
            "<w:document xmlns:w=\"{W}\" xmlns:r=\"{R}\"><w:body><w:p><w:r><w:t>body</w:t></w:r></w:p><w:sectPr><w:headerReference w:type=\"default\" r:id=\"rId2\"/>{footer_reference}</w:sectPr></w:body></w:document>"
          ),
        ),
        (
          "word/_rels/document.xml.rels",
          format!(
            "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId2\" Type=\"{R}/header\" Target=\"header1.xml\"/>{footer_relationship}</Relationships>"
          ),
        ),
        ("word/header1.xml", header_xml.to_string()),
      ];
      if let Some(footer_xml) = footer_xml {
        parts.push(("word/footer1.xml", footer_xml.to_string()));
      }
      for (name, content) in parts {
        writer.start_file(name, options).unwrap();
        writer.write_all(content.as_bytes()).unwrap();
      }
      writer.finish().unwrap();
    }
    cursor.into_inner()
  }

  #[test]
  fn extracts_a_normal_header() {
    let docx = docx_with_header(&format!(
      "<w:hdr xmlns:w=\"{W}\"><w:p><w:r><w:t>Company Confidential</w:t></w:r></w:p></w:hdr>"
    ));
    let (headers, footers) = extract_docx_headers_and_footers(&docx);
    assert_eq!(headers, "Company Confidential");
    assert_eq!(footers, "");
  }

  #[test]
  fn skips_an_over_deep_header_and_keeps_going() {
    let docx = docx_with_parts(
      &format!(
        "<w:hdr xmlns:w=\"{W}\">{}</w:hdr>",
        nested(200_000, "<w:p><w:r><w:t>deep</w:t></w:r></w:p>")
      ),
      Some(&format!(
        "<w:ftr xmlns:w=\"{W}\"><w:p><w:r><w:t>Page 1</w:t></w:r></w:p></w:ftr>"
      )),
    );
    let (headers, footers) = extract_docx_headers_and_footers(&docx);
    assert_eq!(headers, "");
    assert_eq!(footers, "Page 1");
  }
}
