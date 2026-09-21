use napi::bindgen_prelude::*;
use napi_derive::napi;
use roxmltree::Document;
use std::collections::{HashMap, HashSet};
use std::io::{Cursor, Read};
use std::path::{Component, Path, PathBuf};

const MAX_OOXML_PART_BYTES: u64 = 128 * 1024 * 1024;
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

/// Convert a document (doc, docx, odt/ods/odp, rtf, xls/xlsx, ppt/pptx, epub,
/// csv, ...) to GitHub-Flavored Markdown using anydoc. The format is detected
/// from the file content; `extension_hint` (with or without a leading dot) is
/// only consulted for signature-less formats like CSV.
#[napi]
pub fn convert_document_to_markdown(data: &[u8], extension_hint: Option<String>) -> Result<String> {
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

  let main_part = read_zip_text(&mut archive, "_rels/.rels")
    .and_then(|xml| office_document_target(&xml))
    .unwrap_or_else(|| "word/document.xml".to_string());
  let Some(document_xml) = read_zip_text(&mut archive, &main_part) else {
    return (String::new(), String::new());
  };
  let relationship_part = relationship_part_for(&main_part);
  let Some(relationships_xml) = read_zip_text(&mut archive, &relationship_part) else {
    return (String::new(), String::new());
  };
  let relationships = parse_repeating_relationships(&relationships_xml);
  let Ok(document) = Document::parse(&document_xml) else {
    return (String::new(), String::new());
  };

  let mut seen = HashSet::new();
  let mut headers = Vec::new();
  let mut footers = Vec::new();

  for reference in document
    .descendants()
    .filter(|node| is_wordprocessing_node(*node))
  {
    let reference_kind = match reference.tag_name().name() {
      "headerReference" => RepeatingPartKind::Header,
      "footerReference" => RepeatingPartKind::Footer,
      _ => continue,
    };
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
    let Some(xml) = read_zip_text(&mut archive, &part) else {
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

fn read_zip_text<R: Read + std::io::Seek>(
  archive: &mut zip::ZipArchive<R>,
  name: &str,
) -> Option<String> {
  let mut file = archive.by_name(name.trim_start_matches('/')).ok()?;
  if file.size() > MAX_OOXML_PART_BYTES {
    return None;
  }
  let mut bytes = Vec::with_capacity(file.size() as usize);
  file
    .by_ref()
    .take(MAX_OOXML_PART_BYTES + 1)
    .read_to_end(&mut bytes)
    .ok()?;
  if bytes.len() as u64 > MAX_OOXML_PART_BYTES {
    return None;
  }
  String::from_utf8(bytes).ok()
}

fn office_document_target(xml: &str) -> Option<String> {
  let document = Document::parse(xml).ok()?;
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
  let Ok(document) = Document::parse(xml) else {
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
  let path = Path::new(part);
  let file_name = path
    .file_name()
    .and_then(|name| name.to_str())
    .unwrap_or(part);
  match path.parent().and_then(|parent| parent.to_str()) {
    Some(parent) if !parent.is_empty() => format!("{parent}/_rels/{file_name}.rels"),
    _ => format!("_rels/{file_name}.rels"),
  }
}

fn resolve_part(base: &str, target: &str) -> Option<String> {
  if target.starts_with('/') {
    return normalize_part(target);
  }
  let base = Path::new(base).parent().unwrap_or_else(|| Path::new(""));
  normalize_part(base.join(target).to_str()?)
}

fn normalize_part(part: &str) -> Option<String> {
  let mut normalized = PathBuf::new();
  for component in Path::new(part.trim_start_matches('/')).components() {
    match component {
      Component::Normal(value) => normalized.push(value),
      Component::CurDir => {}
      Component::ParentDir => {
        if !normalized.pop() {
          return None;
        }
      }
      Component::RootDir | Component::Prefix(_) => return None,
    }
  }
  normalized.to_str().map(str::to_string)
}

fn extract_wordprocessing_text(xml: &str) -> Option<String> {
  let document = Document::parse(xml).ok()?;
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
