//! DOCX (Office Open XML) provider.

use crate::document::model::*;
use crate::document::providers::DocumentProvider;
use crate::document::xml::{attr, child, children, is_tag, read_zip_text, strip_bom};
use chrono::{DateTime, Utc};
use roxmltree::{Document as XmlDoc, Node};
use std::collections::{BTreeSet, HashMap};
use std::error::Error;
use std::io::{Cursor, Read, Seek};
use std::num::NonZeroU32;
use zip::read::ZipArchive;

pub struct DocxProvider;

impl DocxProvider {
  pub fn new() -> Self {
    Self
  }
}

/// Everything block parsing needs besides the XML itself.
#[derive(Clone, Copy)]
struct Ctx<'a> {
  rels: &'a Relationships,
  styles: &'a StylesInfo,
  size_buckets: &'a HashMap<String, Vec<u32>>,
  numbering: &'a NumberingInfo,
}

impl DocumentProvider for DocxProvider {
  fn parse_buffer(&self, data: &[u8]) -> Result<Document, Box<dyn Error + Send + Sync>> {
    let mut zip = ZipArchive::new(Cursor::new(data))?;

    let metadata = read_core_properties(&mut zip).unwrap_or_default();
    let styles = read_styles(&mut zip);
    let numbering = read_numbering(&mut zip);
    let rels = read_relationships(&mut zip, "word/_rels/document.xml.rels");

    let document_xml = read_zip_text(&mut zip, "word/document.xml")
      .ok_or("Missing word/document.xml in document")?;
    let xml = XmlDoc::parse(strip_bom(&document_xml))?;

    let size_buckets = compute_style_size_buckets(&xml, &styles);
    let ctx = Ctx {
      rels: &rels,
      styles: &styles,
      size_buckets: &size_buckets,
      numbering: &numbering,
    };

    let blocks = xml
      .descendants()
      .find(|n| is_tag(n, "body"))
      .map(|body| parse_blocks(&body, ctx))
      .unwrap_or_default();

    let mut notes = read_notes(&mut zip, NoteKind::Footnote, ctx);
    notes.extend(read_notes(&mut zip, NoteKind::Endnote, ctx));
    let comments = read_comments(&mut zip, ctx);

    Ok(Document {
      blocks,
      metadata,
      notes,
      comments,
    })
  }

  fn name(&self) -> &'static str {
    "docx"
  }
}

#[derive(Debug, Clone, Default)]
struct Relationships {
  targets: HashMap<String, String>,
}

impl Relationships {
  fn get(&self, id: &str) -> Option<&str> {
    self.targets.get(id).map(|s| s.as_str())
  }
}

fn read_relationships<R: Read + Seek>(zip: &mut ZipArchive<R>, path: &str) -> Relationships {
  let mut rels = Relationships::default();
  let Some(text) = read_zip_text(zip, path) else {
    return rels;
  };
  let Ok(xml) = XmlDoc::parse(strip_bom(&text)) else {
    return rels;
  };
  for rel in xml.descendants().filter(|n| is_tag(n, "Relationship")) {
    if let (Some(id), Some(target)) = (attr(&rel, "Id"), attr(&rel, "Target")) {
      rels.targets.insert(id.to_string(), target.to_string());
    }
  }
  rels
}

fn read_core_properties<R: Read + Seek>(zip: &mut ZipArchive<R>) -> Option<DocumentMetadata> {
  let text = read_zip_text(zip, "docProps/core.xml")?;
  let xml = XmlDoc::parse(strip_bom(&text)).ok()?;
  let element_text = |local: &str| {
    xml
      .descendants()
      .find(|n| is_tag(n, local))
      .and_then(|n| n.text())
  };

  let mut meta = DocumentMetadata::default();
  if let Some(title) = element_text("title") {
    let trimmed = title.trim();
    if !trimmed.is_empty() {
      meta.title = Some(trimmed.to_string());
    }
  }
  if let Some(author) = element_text("creator") {
    let trimmed = author.trim();
    if !trimmed.is_empty() && !trimmed.eq_ignore_ascii_case("unknown") {
      meta.author = Some(trimmed.to_string());
    }
  }
  if let Some(created) = element_text("created") {
    if let Ok(dt) = DateTime::parse_from_rfc3339(created) {
      meta.created = Some(DateTime::<Utc>::from(dt));
    }
  }
  Some(meta)
}

#[derive(Debug, Default)]
struct StylesInfo {
  outline_level_by_style_id: HashMap<String, u8>,
  name_by_style_id: HashMap<String, String>,
  default_size_by_style_id: HashMap<String, u32>,
}

fn read_styles<R: Read + Seek>(zip: &mut ZipArchive<R>) -> StylesInfo {
  let mut info = StylesInfo::default();
  let Some(text) = read_zip_text(zip, "word/styles.xml") else {
    return info;
  };
  let Ok(xml) = XmlDoc::parse(strip_bom(&text)) else {
    return info;
  };

  for style in xml.descendants().filter(|n| is_tag(n, "style")) {
    if attr(&style, "type") != Some("paragraph") {
      continue;
    }
    let Some(style_id) = attr(&style, "styleId") else {
      continue;
    };

    if let Some(name) = child(&style, "name").and_then(|n| attr(&n, "val")) {
      info
        .name_by_style_id
        .insert(style_id.to_string(), name.to_string());
    }
    if let Some(size) = child(&style, "rPr")
      .and_then(|rpr| child(&rpr, "sz"))
      .and_then(|n| attr(&n, "val"))
      .and_then(|v| v.parse::<u32>().ok())
    {
      info
        .default_size_by_style_id
        .insert(style_id.to_string(), size);
    }
    if let Some(level) = child(&style, "pPr")
      .and_then(|ppr| child(&ppr, "outlineLvl"))
      .and_then(|n| attr(&n, "val"))
      .and_then(|v| v.parse::<u8>().ok())
    {
      info
        .outline_level_by_style_id
        .insert(style_id.to_string(), (level + 1).min(6));
    }
  }
  info
}

enum StyleKind {
  Heading(u8),
  Blockquote,
}

/// Heading or quote semantics of a paragraph style, from the style's outline
/// level when declared and name/id conventions otherwise.
fn style_kind(style_id: &str, styles: &StylesInfo) -> Option<StyleKind> {
  if let Some(level) = styles.outline_level_by_style_id.get(style_id) {
    return Some(StyleKind::Heading(*level));
  }

  let name = styles.name_by_style_id.get(style_id);
  if let Some(name) = name {
    if let Some(level) = parse_heading_level(name) {
      return Some(StyleKind::Heading(level));
    }
    if name.to_ascii_lowercase().contains("quote") {
      return Some(StyleKind::Blockquote);
    }
  }
  if let Some(level) = parse_heading_level(style_id) {
    return Some(StyleKind::Heading(level));
  }

  let id_lower = style_id.to_ascii_lowercase();
  let name_lower = name.map(|s| s.to_ascii_lowercase()).unwrap_or_default();
  if name_lower.contains("title") || id_lower.contains("title") {
    Some(StyleKind::Heading(1))
  } else if name_lower.contains("heading") || id_lower.contains("heading") {
    Some(StyleKind::Heading(2))
  } else if name_lower.contains("quote") || id_lower.contains("quote") {
    Some(StyleKind::Blockquote)
  } else {
    None
  }
}

fn parse_heading_level(s: &str) -> Option<u8> {
  let lower = s.to_ascii_lowercase();
  let rest = &lower[lower.find("heading")? + "heading".len()..];
  let digits: String = rest
    .chars()
    .skip_while(|c| c.is_whitespace() || *c == '-')
    .take_while(|c| c.is_ascii_digit())
    .collect();
  match digits.parse::<u8>() {
    Ok(n) if n >= 1 => Some(n.min(6)),
    _ => None,
  }
}

fn paragraph_style_id<'a>(p: &Node<'a, 'a>) -> Option<&'a str> {
  child(p, "pPr")
    .and_then(|ppr| child(&ppr, "pStyle"))
    .and_then(|n| attr(&n, "val"))
}

fn paragraph_kind(p: &Node, ctx: Ctx) -> ParagraphKind {
  let Some(ppr) = child(p, "pPr") else {
    return ParagraphKind::Normal;
  };

  if let Some(level) = child(&ppr, "outlineLvl")
    .and_then(|n| attr(&n, "val"))
    .and_then(|v| v.parse::<u8>().ok())
  {
    return ParagraphKind::Heading((level + 1).min(6));
  }

  let Some(style_id) = paragraph_style_id(p) else {
    return ParagraphKind::Normal;
  };
  match style_kind(style_id, ctx.styles) {
    Some(StyleKind::Blockquote) => ParagraphKind::Blockquote,
    Some(StyleKind::Heading(mut level)) => {
      // Same style at distinct font sizes: demote the smaller sizes.
      if let (Some(buckets), Some(size)) = (
        ctx.size_buckets.get(style_id),
        paragraph_effective_size(p, ctx.styles, style_id),
      ) {
        if let Some(index) = buckets.iter().position(|&s| s == size) {
          level = (level + index as u8).min(6);
        }
      }
      ParagraphKind::Heading(level)
    }
    None => ParagraphKind::Normal,
  }
}

fn paragraph_effective_size(p: &Node, styles: &StylesInfo, style_id: &str) -> Option<u32> {
  let run_sizes = children(p, "r")
    .filter_map(|r| child(&r, "rPr"))
    .chain(child(p, "pPr").and_then(|ppr| child(&ppr, "rPr")))
    .filter_map(|rpr| child(&rpr, "sz"))
    .filter_map(|n| attr(&n, "val"))
    .filter_map(|v| v.parse::<u32>().ok());
  run_sizes
    .max()
    .or_else(|| styles.default_size_by_style_id.get(style_id).copied())
}

/// Distinct font sizes seen per heading/title style, largest first.
fn compute_style_size_buckets(xml: &XmlDoc, styles: &StylesInfo) -> HashMap<String, Vec<u32>> {
  let mut sets: HashMap<String, BTreeSet<u32>> = HashMap::new();

  for p in xml.descendants().filter(|n| is_tag(n, "p")) {
    let Some(style_id) = paragraph_style_id(&p) else {
      continue;
    };
    let id_lower = style_id.to_ascii_lowercase();
    let name_lower = styles
      .name_by_style_id
      .get(style_id)
      .map(|s| s.to_ascii_lowercase())
      .unwrap_or_default();
    if !(id_lower.contains("heading")
      || id_lower.contains("title")
      || name_lower.contains("heading")
      || name_lower.contains("title"))
    {
      continue;
    }
    if let Some(size) = paragraph_effective_size(&p, styles, style_id) {
      sets.entry(style_id.to_string()).or_default().insert(size);
    }
  }

  sets
    .into_iter()
    .map(|(style_id, sizes)| {
      let mut sizes: Vec<u32> = sizes.into_iter().collect();
      sizes.reverse();
      (style_id, sizes)
    })
    .collect()
}

#[derive(Clone, Default)]
struct RunStyle {
  bold: Option<bool>,
  italic: Option<bool>,
  strike: Option<bool>,
  code: Option<bool>,
  vert_align: Option<VerticalAlign>,
}

#[derive(Clone, Copy)]
enum VerticalAlign {
  Baseline,
  Superscript,
  Subscript,
}

impl RunStyle {
  fn merged(&self, overrides: &RunStyle) -> RunStyle {
    RunStyle {
      bold: overrides.bold.or(self.bold),
      italic: overrides.italic.or(self.italic),
      strike: overrides.strike.or(self.strike),
      code: overrides.code.or(self.code),
      vert_align: overrides.vert_align.or(self.vert_align),
    }
  }

  fn apply(&self, local: &RunStyle, mut inlines: Vec<Inline>) -> Vec<Inline> {
    let resolved = self.merged(local);

    if resolved.code.unwrap_or(false) {
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

    if resolved.strike.unwrap_or(false) {
      inlines = vec![Inline::Del(inlines)];
    }
    if resolved.italic.unwrap_or(false) {
      inlines = vec![Inline::Em(inlines)];
    }
    if resolved.bold.unwrap_or(false) {
      inlines = vec![Inline::Strong(inlines)];
    }
    match resolved.vert_align.unwrap_or(VerticalAlign::Baseline) {
      VerticalAlign::Superscript => vec![Inline::Sup(inlines)],
      VerticalAlign::Subscript => vec![Inline::Sub(inlines)],
      VerticalAlign::Baseline => inlines,
    }
  }
}

fn read_on_off(node: &Node) -> bool {
  !matches!(
    attr(node, "val").map(|v| v.to_ascii_lowercase()).as_deref(),
    Some("0") | Some("false") | Some("off")
  )
}

fn run_style_from_rpr(rpr: &Node) -> RunStyle {
  let mut style = RunStyle::default();
  if let Some(b) = child(rpr, "b") {
    style.bold = Some(read_on_off(&b));
  }
  if let Some(i) = child(rpr, "i") {
    style.italic = Some(read_on_off(&i));
  }
  if let Some(s) = child(rpr, "strike") {
    style.strike = Some(read_on_off(&s));
  }
  if let Some(rstyle) = child(rpr, "rStyle").and_then(|n| attr(&n, "val")) {
    if rstyle.to_ascii_lowercase().contains("code") {
      style.code = Some(true);
    }
  }
  if let Some(va) = child(rpr, "vertAlign").and_then(|n| attr(&n, "val")) {
    style.vert_align = Some(match va.to_ascii_lowercase().as_str() {
      "sup" | "superscript" => VerticalAlign::Superscript,
      "sub" | "subscript" => VerticalAlign::Subscript,
      _ => VerticalAlign::Baseline,
    });
  }
  style
}

fn paragraph_run_style(p: &Node) -> RunStyle {
  child(p, "pPr")
    .and_then(|ppr| child(&ppr, "rPr"))
    .map(|rpr| run_style_from_rpr(&rpr))
    .unwrap_or_default()
}

fn parse_paragraph(node: &Node, ctx: Ctx) -> Paragraph {
  let kind = paragraph_kind(node, ctx);
  let base_style = paragraph_run_style(node);
  let mut inlines = Vec::new();

  for c in node.children().filter(|n| n.is_element()) {
    if is_tag(&c, "r") {
      inlines.extend(parse_run(&c, &base_style));
    } else if is_tag(&c, "hyperlink") {
      if let Some(link) = parse_hyperlink(&c, ctx.rels, &base_style) {
        inlines.push(link);
      }
    } else if is_tag(&c, "bookmarkStart") {
      if let Some(name) = attr(&c, "name") {
        inlines.push(Inline::Bookmark(BookmarkId(name.to_string())));
      }
    } else if is_tag(&c, "br") {
      inlines.push(Inline::LineBreak);
    }
  }

  Paragraph { kind, inlines }
}

fn parse_run(run: &Node, base_style: &RunStyle) -> Vec<Inline> {
  let local_style = child(run, "rPr")
    .map(|rpr| run_style_from_rpr(&rpr))
    .unwrap_or_default();

  let mut out = Vec::new();
  for c in run.children().filter(|n| n.is_element()) {
    if is_tag(&c, "t") {
      if let Some(text) = c.text() {
        out.push(Inline::Text(text.to_string()));
      }
    } else if is_tag(&c, "br") {
      out.push(Inline::LineBreak);
    } else if is_tag(&c, "tab") {
      out.push(Inline::Text("\t".to_string()));
    } else if is_tag(&c, "footnoteReference") {
      if let Some(id) = attr(&c, "id") {
        out.push(Inline::FootnoteRef(NoteId(id.to_string())));
      }
    } else if is_tag(&c, "endnoteReference") {
      if let Some(id) = attr(&c, "id") {
        out.push(Inline::EndnoteRef(NoteId(id.to_string())));
      }
    } else if is_tag(&c, "commentReference") {
      if let Some(id) = attr(&c, "id") {
        out.push(Inline::CommentRef(CommentId(id.to_string())));
      }
    }
  }

  base_style.apply(&local_style, out)
}

fn parse_hyperlink(node: &Node, rels: &Relationships, base_style: &RunStyle) -> Option<Inline> {
  let href = if let Some(id) = attr(node, "id") {
    rels.get(id).map(|s| s.to_string())
  } else {
    attr(node, "anchor").map(|anchor| format!("#{anchor}"))
  }?;

  let link_style = child(node, "rPr")
    .map(|rpr| run_style_from_rpr(&rpr))
    .unwrap_or_default();
  let combined_style = base_style.merged(&link_style);

  let mut link_children = Vec::new();
  for run in children(node, "r") {
    link_children.extend(parse_run(&run, &combined_style));
  }

  Some(Inline::Link {
    href,
    children: link_children,
  })
}

fn parse_blocks(parent: &Node, ctx: Ctx) -> Vec<Block> {
  let nodes: Vec<Node> = parent.children().filter(|n| n.is_element()).collect();
  let mut out = Vec::new();
  let mut i = 0;

  while i < nodes.len() {
    let node = &nodes[i];
    if is_tag(node, "p") {
      if paragraph_list_info(node, ctx.numbering).is_some() {
        let (list, next_i) = parse_list(&nodes, i, ctx);
        if !list.items.is_empty() {
          out.push(Block::List(list));
        }
        i = next_i;
        continue;
      }
      if let Some(image) = parse_image_paragraph(node, ctx.rels) {
        out.push(Block::Image(image));
      } else {
        let para = parse_paragraph(node, ctx);
        if has_visible_content(&para.inlines) {
          out.push(Block::Paragraph(para));
        }
      }
    } else if is_tag(node, "tbl") {
      out.push(Block::Table(parse_table(node, ctx)));
    }
    i += 1;
  }
  out
}

fn parse_table(node: &Node, ctx: Ctx) -> Table {
  let mut rows = Vec::new();
  for tr in children(node, "tr") {
    let header = child(&tr, "trPr")
      .and_then(|trpr| child(&trpr, "tblHeader"))
      .is_some();
    let cells = children(&tr, "tc")
      .map(|tc| TableCell {
        blocks: parse_blocks(&tc, ctx),
        colspan: NonZeroU32::MIN,
        rowspan: NonZeroU32::MIN,
      })
      .collect();
    rows.push(TableRow {
      cells,
      kind: if header {
        TableRowKind::Header
      } else {
        TableRowKind::Body
      },
    });
  }

  if rows.iter().any(|r| matches!(r.kind, TableRowKind::Header)) {
    if let Some(last) = rows.last_mut() {
      last.kind = TableRowKind::Footer;
    }
  }
  Table { rows }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ListInfo {
  list_type: ListType,
  num_id: String,
  ilvl: u32,
}

#[derive(Debug, Default)]
struct NumberingInfo {
  num_to_abstract: HashMap<String, String>,
  abstract_levels: HashMap<String, HashMap<String, ListType>>,
}

impl NumberingInfo {
  fn list_type(&self, num_id: &str, ilvl: &str) -> Option<ListType> {
    self
      .abstract_levels
      .get(self.num_to_abstract.get(num_id)?)?
      .get(ilvl)
      .copied()
  }
}

fn read_numbering<R: Read + Seek>(zip: &mut ZipArchive<R>) -> NumberingInfo {
  let mut info = NumberingInfo::default();
  let Some(text) = read_zip_text(zip, "word/numbering.xml") else {
    return info;
  };
  let Ok(xml) = XmlDoc::parse(strip_bom(&text)) else {
    return info;
  };

  for num in xml.descendants().filter(|n| is_tag(n, "num")) {
    if let (Some(num_id), Some(abs)) = (
      attr(&num, "numId"),
      child(&num, "abstractNumId").and_then(|n| attr(&n, "val")),
    ) {
      info
        .num_to_abstract
        .insert(num_id.to_string(), abs.to_string());
    }
  }

  for abs in xml.descendants().filter(|n| is_tag(n, "abstractNum")) {
    let Some(abs_id) = attr(&abs, "abstractNumId") else {
      continue;
    };
    let mut levels = HashMap::new();
    for lvl in children(&abs, "lvl") {
      if let Some(ilvl) = attr(&lvl, "ilvl") {
        let fmt = child(&lvl, "numFmt").and_then(|n| attr(&n, "val"));
        let list_type = match fmt.unwrap_or("") {
          "bullet" => ListType::Unordered,
          _ => ListType::Ordered,
        };
        levels.insert(ilvl.to_string(), list_type);
      }
    }
    info.abstract_levels.insert(abs_id.to_string(), levels);
  }
  info
}

fn paragraph_list_info(p: &Node, numbering: &NumberingInfo) -> Option<ListInfo> {
  let numpr = child(p, "pPr").and_then(|ppr| child(&ppr, "numPr"))?;
  let ilvl_str = child(&numpr, "ilvl").and_then(|n| attr(&n, "val"))?;
  let num_id = child(&numpr, "numId").and_then(|n| attr(&n, "val"))?;
  Some(ListInfo {
    list_type: numbering
      .list_type(num_id, ilvl_str)
      .unwrap_or(ListType::Unordered),
    num_id: num_id.to_string(),
    ilvl: ilvl_str.parse().unwrap_or(0),
  })
}

/// Consumes consecutive numbered paragraphs at one level into a list,
/// recursing for deeper levels. Returns the list and the next unconsumed
/// node index.
fn parse_list(nodes: &[Node], mut i: usize, ctx: Ctx) -> (List, usize) {
  let mut list = List {
    items: Vec::new(),
    list_type: ListType::Unordered,
  };
  let Some(base) = nodes
    .get(i)
    .and_then(|n| paragraph_list_info(n, ctx.numbering))
  else {
    return (list, i + 1);
  };
  list.list_type = base.list_type;

  while i < nodes.len() {
    let node = &nodes[i];
    if !is_tag(node, "p") {
      break;
    }
    let Some(info) = paragraph_list_info(node, ctx.numbering) else {
      break;
    };
    if info.ilvl < base.ilvl
      || (info.ilvl == base.ilvl
        && (info.list_type != base.list_type || info.num_id != base.num_id))
    {
      break;
    }
    if info.ilvl > base.ilvl {
      // deeper level with no parent item yet; let the caller handle it
      break;
    }

    let mut blocks = Vec::new();
    if let Some(image) = parse_image_paragraph(node, ctx.rels) {
      blocks.push(Block::Image(image));
    } else {
      let para = parse_paragraph(node, ctx);
      if has_visible_content(&para.inlines) {
        blocks.push(Block::Paragraph(para));
      }
    }
    list.items.push(ListItem { blocks });
    i += 1;

    while i < nodes.len() && is_tag(&nodes[i], "p") {
      match paragraph_list_info(&nodes[i], ctx.numbering) {
        Some(sub) if sub.ilvl > base.ilvl => {
          let (sublist, next_i) = parse_list(nodes, i, ctx);
          if let Some(last) = list.items.last_mut() {
            last.blocks.push(Block::List(sublist));
          }
          i = next_i;
        }
        _ => break,
      }
    }

    if list.items.last().is_some_and(|last| last.blocks.is_empty()) {
      list.items.pop();
    }
  }

  (list, i)
}

fn parse_image_paragraph(p: &Node, rels: &Relationships) -> Option<Image> {
  let has_text = p
    .descendants()
    .filter(|n| is_tag(n, "t"))
    .any(|t| t.text().map(|s| !s.trim().is_empty()).unwrap_or(false));
  if has_text {
    return None;
  }

  if let Some(drawing) = p.descendants().find(|n| is_tag(n, "drawing")) {
    let blip = drawing.descendants().find(|n| is_tag(n, "blip"))?;
    let rel_id = attr(&blip, "embed").or_else(|| attr(&blip, "link"))?;
    let alt = drawing
      .descendants()
      .find(|n| is_tag(n, "docPr"))
      .and_then(|n| attr(&n, "descr").or_else(|| attr(&n, "title")))
      .map(|s| s.to_string());
    return external_image(rels.get(rel_id)?, alt);
  }

  if let Some(pict) = p.descendants().find(|n| is_tag(n, "pict")) {
    let imagedata = pict.descendants().find(|n| is_tag(n, "imagedata"))?;
    let rel_id = attr(&imagedata, "id")?;
    let alt = attr(&imagedata, "title").map(|s| s.to_string());
    return external_image(rels.get(rel_id)?, alt);
  }
  None
}

/// Only external (http/https) images are representable in the output.
fn external_image(target: &str, alt: Option<String>) -> Option<Image> {
  if target.starts_with("http://") || target.starts_with("https://") {
    Some(Image {
      src: target.to_string(),
      alt,
    })
  } else {
    None
  }
}

fn read_notes<R: Read + Seek>(zip: &mut ZipArchive<R>, kind: NoteKind, ctx: Ctx) -> Vec<Note> {
  let (xml_path, rels_path, root_tag) = match kind {
    NoteKind::Footnote => (
      "word/footnotes.xml",
      "word/_rels/footnotes.xml.rels",
      "footnote",
    ),
    NoteKind::Endnote => (
      "word/endnotes.xml",
      "word/_rels/endnotes.xml.rels",
      "endnote",
    ),
  };
  let Some(text) = read_zip_text(zip, xml_path) else {
    return Vec::new();
  };
  let Ok(xml) = XmlDoc::parse(strip_bom(&text)) else {
    return Vec::new();
  };
  let rels = read_relationships(zip, rels_path);
  let ctx = Ctx { rels: &rels, ..ctx };

  let mut notes = Vec::new();
  for n in xml.descendants().filter(|n| is_tag(n, root_tag)) {
    let Some(id) = attr(&n, "id") else {
      continue;
    };
    if matches!(
      attr(&n, "type"),
      Some("separator" | "continuationSeparator")
    ) {
      continue;
    }
    notes.push(Note {
      id: NoteId(id.to_string()),
      kind,
      blocks: parse_blocks(&n, ctx),
    });
  }
  notes
}

fn read_comments<R: Read + Seek>(zip: &mut ZipArchive<R>, ctx: Ctx) -> Vec<Comment> {
  let Some(text) = read_zip_text(zip, "word/comments.xml") else {
    return Vec::new();
  };
  let Ok(xml) = XmlDoc::parse(strip_bom(&text)) else {
    return Vec::new();
  };
  let rels = read_relationships(zip, "word/_rels/comments.xml.rels");
  let ctx = Ctx { rels: &rels, ..ctx };

  let mut comments = Vec::new();
  for c in xml.descendants().filter(|n| is_tag(n, "comment")) {
    let Some(id) = attr(&c, "id") else {
      continue;
    };
    comments.push(Comment {
      id: CommentId(id.to_string()),
      author_name: attr(&c, "author").map(|s| s.to_string()),
      author_initials: attr(&c, "initials").map(|s| s.to_string()),
      blocks: parse_blocks(&c, ctx),
    });
  }
  comments
}
