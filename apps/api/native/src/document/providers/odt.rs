//! ODT (OpenDocument text) provider.

use crate::document::model::*;
use crate::document::providers::DocumentProvider;
use crate::document::xml::{attr, child, children, is_tag, read_zip_text, strip_bom};
use chrono::{DateTime, Utc};
use roxmltree::{Document as XmlDoc, Node};
use std::collections::{HashMap, HashSet};
use std::error::Error;
use std::io::{Cursor, Read, Seek};
use std::num::NonZeroU32;
use zip::read::ZipArchive;

pub struct OdtProvider;

impl OdtProvider {
  pub fn new() -> Self {
    Self
  }
}

impl DocumentProvider for OdtProvider {
  fn parse_buffer(&self, data: &[u8]) -> Result<Document, Box<dyn Error + Send + Sync>> {
    let mut zip = ZipArchive::new(Cursor::new(data))?;

    let metadata = read_meta(&mut zip).unwrap_or_default();
    let styles = read_styles(&mut zip);

    let content =
      read_zip_text(&mut zip, "content.xml").ok_or("Missing content.xml in document")?;
    let xml = XmlDoc::parse(strip_bom(&content))?;

    let mut parser = Parser {
      styles: &styles,
      notes: Vec::new(),
      comments: Vec::new(),
    };
    let blocks = xml
      .descendants()
      .find(|n| is_tag(n, "text") && n.ancestors().any(|a| is_tag(&a, "body")))
      .map(|body| parser.parse_blocks(&body))
      .unwrap_or_default();

    Ok(Document {
      blocks,
      metadata,
      notes: parser.notes,
      comments: parser.comments,
    })
  }

  fn name(&self) -> &'static str {
    "odt"
  }
}

fn read_meta<R: Read + Seek>(zip: &mut ZipArchive<R>) -> Option<DocumentMetadata> {
  let text = read_zip_text(zip, "meta.xml")?;
  let xml = XmlDoc::parse(strip_bom(&text)).ok()?;
  let element_text = |local: &str| {
    xml
      .descendants()
      .find(|n| is_tag(n, local))
      .and_then(|n| n.text())
  };

  let mut meta = DocumentMetadata::default();
  if let Some(title) = element_text("title") {
    if !title.trim().is_empty() {
      meta.title = Some(title.to_string());
    }
  }
  if let Some(author) = element_text("creator").or_else(|| element_text("initial-creator")) {
    let trimmed = author.trim();
    if !trimmed.is_empty() && !trimmed.eq_ignore_ascii_case("unknown") {
      meta.author = Some(trimmed.to_string());
    }
  }
  if let Some(created) = element_text("creation-date") {
    if let Ok(dt) = DateTime::parse_from_rfc3339(created) {
      meta.created = Some(DateTime::<Utc>::from(dt));
    }
  }
  Some(meta)
}

#[derive(Debug, Default)]
struct OdtStylesInfo {
  paragraph_style_names: HashSet<String>,
  paragraph_outline_level: HashMap<String, u8>,
  paragraph_text_props: HashMap<String, TextStyleProps>,
  text_props: HashMap<String, TextStyleProps>,
  list_is_ordered: HashMap<String, bool>,
}

#[derive(Debug, Default, Clone, Copy)]
struct TextStyleProps {
  bold: bool,
  italic: bool,
  strike: bool,
  sup: bool,
  sub: bool,
  code: bool,
}

fn read_styles<R: Read + Seek>(zip: &mut ZipArchive<R>) -> OdtStylesInfo {
  let mut info = OdtStylesInfo::default();
  for path in ["styles.xml", "content.xml"] {
    if let Some(text) = read_zip_text(zip, path) {
      if let Ok(xml) = XmlDoc::parse(strip_bom(&text)) {
        harvest_styles(&xml, &mut info);
      }
    }
  }
  info
}

fn harvest_styles(xml: &XmlDoc, out: &mut OdtStylesInfo) {
  for style in xml.descendants().filter(|n| is_tag(n, "style")) {
    let (Some(family), Some(name)) = (attr(&style, "family"), attr(&style, "name")) else {
      continue;
    };

    match family {
      "paragraph" => {
        out.paragraph_style_names.insert(name.to_string());

        let outline_level = child(&style, "paragraph-properties")
          .and_then(|pp| attr(&pp, "outline-level"))
          .and_then(|v| v.parse::<u8>().ok())
          .map(|v| v.min(6))
          .or_else(|| attr(&style, "parent-style-name").and_then(parse_heading_level));
        if let Some(level) = outline_level {
          out.paragraph_outline_level.insert(name.to_string(), level);
        }

        if let Some(tp) = child(&style, "text-properties") {
          out
            .paragraph_text_props
            .insert(name.to_string(), parse_text_properties(&tp));
        }
      }
      "text" => {
        if let Some(tp) = child(&style, "text-properties") {
          out
            .text_props
            .insert(name.to_string(), parse_text_properties(&tp));
        }
      }
      "list" => {
        let is_ordered = style
          .children()
          .any(|c| is_tag(&c, "list-level-style-number"));
        out.list_is_ordered.insert(name.to_string(), is_ordered);
      }
      _ => {}
    }
  }

  for list_style in xml.descendants().filter(|n| is_tag(n, "list-style")) {
    if let Some(name) = attr(&list_style, "name") {
      let is_ordered = list_style
        .children()
        .any(|c| is_tag(&c, "list-level-style-number"));
      out.list_is_ordered.insert(name.to_string(), is_ordered);
    }
  }
}

fn parse_text_properties(tp: &Node) -> TextStyleProps {
  let mut props = TextStyleProps::default();

  if attr(tp, "font-weight").is_some_and(|v| v.eq_ignore_ascii_case("bold")) {
    props.bold = true;
  }
  if attr(tp, "font-style").is_some_and(|v| v.eq_ignore_ascii_case("italic")) {
    props.italic = true;
  }
  if attr(tp, "text-line-through-type")
    .or_else(|| attr(tp, "text-line-through-style"))
    .is_some_and(|v| v != "none")
  {
    props.strike = true;
  }
  if let Some(v) = attr(tp, "text-position") {
    let lower = v.to_ascii_lowercase();
    if lower.contains("sup") {
      props.sup = true;
    } else if lower.contains("sub") {
      props.sub = true;
    }
  }
  if let Some(font) = attr(tp, "font-name") {
    let lower = font.to_ascii_lowercase();
    if lower.contains("courier") || lower.contains("mono") {
      props.code = true;
    }
  }
  props
}

/// Heading level from a style name like "Heading_20_2" or "Title".
fn parse_heading_level(style_name: &str) -> Option<u8> {
  let normalized = style_name.replace("_20_", " ").replace('_', " ");
  let lower = normalized.to_ascii_lowercase();
  if lower.contains("title") {
    return Some(1);
  }
  let tail = &lower[lower.find("heading")? + "heading".len()..];
  let digits: String = tail.chars().filter(|c| c.is_ascii_digit()).collect();
  digits.parse::<u8>().ok().map(|n| n.clamp(1, 6))
}

struct Parser<'a> {
  styles: &'a OdtStylesInfo,
  notes: Vec<Note>,
  comments: Vec<Comment>,
}

impl Parser<'_> {
  fn parse_blocks(&mut self, node: &Node) -> Vec<Block> {
    let mut blocks = Vec::new();

    for c in node.children().filter(|n| n.is_element()) {
      if is_tag(&c, "h") {
        self.push_paragraph(&c, &mut blocks);
      } else if is_tag(&c, "p") {
        if let Some(image) = image_from_paragraph(&c) {
          blocks.push(Block::Image(image));
        } else {
          self.push_paragraph(&c, &mut blocks);
        }
      } else if is_tag(&c, "list") {
        self.push_list(&c, &mut blocks);
      } else if is_tag(&c, "table") {
        blocks.push(Block::Table(self.parse_table(&c)));
      } else {
        blocks.extend(self.parse_blocks(&c));
      }
    }
    blocks
  }

  fn push_paragraph(&mut self, node: &Node, blocks: &mut Vec<Block>) {
    let para = self.parse_paragraph(node);
    if has_visible_content(&para.inlines) {
      blocks.push(Block::Paragraph(para));
    }
  }

  fn push_list(&mut self, list: &Node, blocks: &mut Vec<Block>) {
    // Writers wrap continuation sublists in a single-item shell list; unwrap
    // and attach them to the previous list's last item.
    let mut effective = *list;
    let mut inherited_style_name = attr(&effective, "style-name");
    let mut unwrapped = false;
    while let Some(inner) = unwrap_single_nested_list(&effective) {
      effective = inner;
      unwrapped = true;
      if inherited_style_name.is_none() {
        inherited_style_name = attr(&effective, "style-name");
      }
    }

    if is_heading_list(&effective) {
      for li in children(&effective, "list-item") {
        let headings: Vec<Node> = li.descendants().filter(|n| is_tag(n, "h")).collect();
        if let Some(h) = headings.first() {
          self.push_paragraph(h, blocks);
        }
      }
      return;
    }

    let parsed = self.parse_list(&effective, inherited_style_name);
    if unwrapped {
      if let Some(Block::List(prev)) = blocks.last_mut() {
        if let Some(last_item) = prev.items.last_mut() {
          last_item.blocks.push(Block::List(parsed));
          return;
        }
      }
    }
    blocks.push(Block::List(parsed));
  }

  fn parse_list(&mut self, node: &Node, inherited_style_name: Option<&str>) -> List {
    let style_name = attr(node, "style-name").or(inherited_style_name);
    let list_type = match style_name.and_then(|n| self.styles.list_is_ordered.get(n)) {
      Some(true) => ListType::Ordered,
      _ => ListType::Unordered,
    };

    let items = children(node, "list-item")
      .map(|li| ListItem {
        blocks: self.parse_blocks(&li),
      })
      .collect();
    List { items, list_type }
  }

  fn parse_table(&mut self, node: &Node) -> Table {
    let mut rows = Vec::new();
    for tr in children(node, "table-row") {
      let cells = children(&tr, "table-cell")
        .map(|tc| TableCell {
          blocks: self.parse_blocks(&tc),
          colspan: span_attr(&tc, "number-columns-spanned"),
          rowspan: span_attr(&tc, "number-rows-spanned"),
        })
        .collect();
      rows.push(TableRow {
        cells,
        kind: TableRowKind::Body,
      });
    }
    Table { rows }
  }

  fn parse_paragraph(&mut self, node: &Node) -> Paragraph {
    let kind = self.paragraph_kind(node);
    let base = attr(node, "style-name")
      .and_then(|name| self.styles.paragraph_text_props.get(name))
      .copied()
      .unwrap_or_default();
    let inlines = self.parse_inlines(node);
    Paragraph {
      kind,
      inlines: apply_text_style(inlines, None, self.styles, base),
    }
  }

  fn paragraph_kind(&self, p: &Node) -> ParagraphKind {
    if p.tag_name().name() == "h" {
      let level = attr(p, "outline-level")
        .and_then(|v| v.parse::<u8>().ok())
        .unwrap_or(1);
      return ParagraphKind::Heading(level.clamp(1, 6));
    }

    if let Some(style_name) = attr(p, "style-name") {
      if let Some(level) = self.styles.paragraph_outline_level.get(style_name) {
        return ParagraphKind::Heading((*level).min(6));
      }
      if self.styles.paragraph_style_names.contains(style_name)
        && style_name.to_ascii_lowercase().contains("quote")
      {
        return ParagraphKind::Blockquote;
      }
    }
    ParagraphKind::Normal
  }

  fn parse_inlines(&mut self, node: &Node) -> Vec<Inline> {
    let mut out = Vec::new();

    for c in node.children() {
      if c.is_text() {
        if let Some(t) = c.text() {
          if !t.is_empty() {
            out.push(Inline::Text(t.to_string()));
          }
        }
        continue;
      }
      if !c.is_element() {
        continue;
      }

      if is_tag(&c, "span") {
        let inner = self.parse_inlines(&c);
        let style_name = attr(&c, "style-name");
        out.extend(apply_text_style(
          inner,
          style_name,
          self.styles,
          TextStyleProps::default(),
        ));
      } else if is_tag(&c, "a") {
        let link_children = self.parse_inlines(&c);
        match attr(&c, "href") {
          Some(href) => out.push(Inline::Link {
            href: href.to_string(),
            children: link_children,
          }),
          None => out.extend(link_children),
        }
      } else if is_tag(&c, "line-break") {
        out.push(Inline::LineBreak);
      } else if is_tag(&c, "s") {
        let count = attr(&c, "c")
          .and_then(|v| v.parse::<usize>().ok())
          .unwrap_or(1)
          .min(1000);
        out.push(Inline::Text(" ".repeat(count)));
      } else if is_tag(&c, "tab") {
        out.push(Inline::Text("\t".to_string()));
      } else if is_tag(&c, "bookmark-start") {
        if let Some(name) = attr(&c, "name") {
          out.push(Inline::Bookmark(BookmarkId(name.to_string())));
        }
      } else if is_tag(&c, "note") {
        out.push(self.parse_note(&c));
      } else if is_tag(&c, "annotation") {
        out.push(self.parse_annotation(&c));
      } else {
        out.extend(self.parse_inlines(&c));
      }
    }
    out
  }

  fn parse_note(&mut self, node: &Node) -> Inline {
    let kind = match attr(node, "note-class") {
      Some("endnote") => NoteKind::Endnote,
      _ => NoteKind::Footnote,
    };
    let id = attr(node, "id")
      .map(|s| s.to_string())
      .unwrap_or_else(|| format!("odt-note-{}", self.notes.len() + 1));

    let blocks = child(node, "note-body")
      .map(|body| self.parse_note_body(&body))
      .unwrap_or_default();
    self.notes.push(Note {
      id: NoteId(id.clone()),
      kind,
      blocks,
    });

    match kind {
      NoteKind::Footnote => Inline::FootnoteRef(NoteId(id)),
      NoteKind::Endnote => Inline::EndnoteRef(NoteId(id)),
    }
  }

  fn parse_note_body(&mut self, node: &Node) -> Vec<Block> {
    let mut blocks = Vec::new();
    let paragraphs: Vec<Node> = node
      .children()
      .filter(|n| is_tag(n, "p") || is_tag(n, "h"))
      .collect();
    for p in paragraphs {
      let para = self.parse_paragraph(&p);
      if has_visible_content(&para.inlines) {
        blocks.push(Block::Paragraph(para));
      }
    }
    blocks
  }

  fn parse_annotation(&mut self, node: &Node) -> Inline {
    let id = format!("odt-comment-{}", self.comments.len() + 1);
    let descendant_text = |local: &str| {
      node
        .descendants()
        .find(|n| is_tag(n, local))
        .and_then(|n| n.text())
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(str::to_string)
    };
    let author = descendant_text("creator");
    let initials = descendant_text("initials");

    let mut blocks = Vec::new();
    let paragraphs: Vec<Node> = node.children().filter(|n| is_tag(n, "p")).collect();
    for p in paragraphs {
      let inlines = self.parse_inlines(&p);
      if !inlines.is_empty() {
        blocks.push(Block::Paragraph(Paragraph {
          kind: ParagraphKind::Normal,
          inlines,
        }));
      }
    }

    self.comments.push(Comment {
      id: CommentId(id.clone()),
      author_name: author,
      author_initials: initials,
      blocks,
    });
    Inline::CommentRef(CommentId(id))
  }
}

fn span_attr(node: &Node, local: &str) -> NonZeroU32 {
  attr(node, local)
    .and_then(|v| v.parse::<u32>().ok())
    .and_then(NonZeroU32::new)
    .unwrap_or(NonZeroU32::MIN)
}

fn unwrap_single_nested_list<'a>(list: &Node<'a, 'a>) -> Option<Node<'a, 'a>> {
  let mut items = children(list, "list-item");
  let first = items.next()?;
  if items.next().is_some() {
    return None;
  }
  let mut inner_lists = first.children().filter(|n| is_tag(n, "list"));
  let inner = inner_lists.next()?;
  if inner_lists.next().is_some() {
    return None;
  }
  Some(inner)
}

fn is_heading_list(list: &Node) -> bool {
  let mut any = false;
  for li in children(list, "list-item") {
    any = true;
    if !li.descendants().any(|n| is_tag(&n, "h")) {
      return false;
    }
  }
  any
}

fn apply_text_style(
  mut inlines: Vec<Inline>,
  style_name: Option<&str>,
  styles: &OdtStylesInfo,
  base: TextStyleProps,
) -> Vec<Inline> {
  let mut props = base;
  if let Some(name) = style_name {
    let mut style_props = styles.text_props.get(name).copied().unwrap_or_default();
    if name.to_ascii_lowercase().contains("code") {
      style_props.code = true;
    }
    props.bold |= style_props.bold;
    props.italic |= style_props.italic;
    props.strike |= style_props.strike;
    props.sup |= style_props.sup;
    props.sub |= style_props.sub;
    props.code |= style_props.code;
  }

  if props.code {
    let code_text: String = inlines
      .iter()
      .filter_map(|i| match i {
        Inline::Text(s) => Some(s.as_str()),
        _ => None,
      })
      .collect();
    if !code_text.is_empty() {
      return vec![Inline::Code(code_text)];
    }
  }

  if props.strike {
    inlines = vec![Inline::Del(inlines)];
  }
  if props.italic {
    inlines = vec![Inline::Em(inlines)];
  }
  if props.bold {
    inlines = vec![Inline::Strong(inlines)];
  }
  if props.sup {
    inlines = vec![Inline::Sup(inlines)];
  }
  if props.sub {
    inlines = vec![Inline::Sub(inlines)];
  }
  inlines
}

fn image_from_paragraph(p: &Node) -> Option<Image> {
  let image = p.descendants().find(|n| is_tag(n, "image"))?;
  let href = attr(&image, "href")?;
  // only external images are representable in the output
  if href.starts_with("http://") || href.starts_with("https://") {
    Some(Image {
      src: href.to_string(),
      alt: None,
    })
  } else {
    None
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::io::Write;

  #[test]
  fn huge_space_count_is_clamped() {
    let content = r#"<?xml version="1.0"?>
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0">
<office:body><office:text><text:p>a<text:s text:c="4000000000"/>b</text:p></office:text></office:body>
</office:document-content>"#;
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    zip
      .start_file("content.xml", zip::write::SimpleFileOptions::default())
      .unwrap();
    zip.write_all(content.as_bytes()).unwrap();
    let data = zip.finish().unwrap().into_inner();

    let document = OdtProvider::new().parse_buffer(&data).unwrap();
    let Block::Paragraph(p) = &document.blocks[0] else {
      panic!("expected paragraph");
    };
    let text: String = p
      .inlines
      .iter()
      .map(|i| match i {
        Inline::Text(t) => t.as_str(),
        _ => "",
      })
      .collect();
    assert_eq!(text.len(), "ab".len() + 1000);
  }
}
