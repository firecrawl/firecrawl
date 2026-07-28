use crate::document::model::*;
use crate::document::providers::DocumentProvider;
use chrono::{DateTime, Utc};
use roxmltree::{Document as XmlDoc, Node};
use std::collections::HashMap;
use std::error::Error;
use std::io::{Read, Seek};
use std::num::NonZeroU32;
use zip::read::ZipArchive;

pub struct DocxProvider;

impl DocxProvider {
  pub fn new() -> Self {
    Self
  }
}

impl DocumentProvider for DocxProvider {
  fn parse_buffer(&self, data: &[u8]) -> Result<Document, Box<dyn Error + Send + Sync>> {
    let cursor = std::io::Cursor::new(data);
    let mut zip = ZipArchive::new(cursor)?;

    let relationships = read_relationships(&mut zip, "word/_rels/document.xml.rels");
    let styles = read_styles(&mut zip);
    let numbering = read_numbering(&mut zip);

    let document_xml = read_zip_text(&mut zip, "word/document.xml")
      .ok_or("Missing word/document.xml in document")?;
    let xml = XmlDoc::parse(strip_bom(&document_xml))?;

    let metadata = read_core_properties(&mut zip).unwrap_or_default();

    let size_buckets = compute_style_size_buckets_for_doc(&xml, &styles);
    let mut blocks = Vec::new();
    if let Some(body) = xml.descendants().find(|n| is_tag(n, "body")) {
      blocks = parse_block_children(
        &body,
        &relationships,
        &styles,
        &size_buckets,
        &numbering,
        &mut zip,
      );
    }

    let mut notes = Vec::new();
    notes.extend(read_notes(
      &mut zip,
      "word/footnotes.xml",
      "word/_rels/footnotes.xml.rels",
      NoteKind::Footnote,
      &styles,
      &size_buckets,
      &numbering,
    ));
    notes.extend(read_notes(
      &mut zip,
      "word/endnotes.xml",
      "word/_rels/endnotes.xml.rels",
      NoteKind::Endnote,
      &styles,
      &size_buckets,
      &numbering,
    ));

    let comments = read_comments(
      &mut zip,
      "word/comments.xml",
      "word/_rels/comments.xml.rels",
      &styles,
      &size_buckets,
      &numbering,
    );

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

fn read_zip_text<R: Read + std::io::Seek>(zip: &mut ZipArchive<R>, path: &str) -> Option<String> {
  let mut file = zip.by_name(path).ok()?;
  let mut s = String::new();
  file.read_to_string(&mut s).ok()?;
  Some(s)
}

fn strip_bom(s: &str) -> &str {
  const BOM: char = '\u{FEFF}';
  s.strip_prefix(BOM).unwrap_or(s)
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

fn read_relationships<R: Read + std::io::Seek>(
  zip: &mut ZipArchive<R>,
  path: &str,
) -> Relationships {
  let xml_text = match read_zip_text(zip, path) {
    Some(s) => s,
    None => return Relationships::default(),
  };
  let xml = match XmlDoc::parse(strip_bom(&xml_text)) {
    Ok(d) => d,
    Err(_) => return Relationships::default(),
  };
  let mut map = HashMap::new();
  for rel in xml.descendants().filter(|n| is_tag(n, "Relationship")) {
    if let (Some(id), Some(target)) = (get_attr_local(&rel, "Id"), get_attr_local(&rel, "Target")) {
      map.insert(id.to_string(), target.to_string());
    }
  }
  Relationships { targets: map }
}

fn read_core_properties<R: Read + std::io::Seek>(
  zip: &mut ZipArchive<R>,
) -> Option<DocumentMetadata> {
  let text = read_zip_text(zip, "docProps/core.xml")?;
  let xml = XmlDoc::parse(strip_bom(&text)).ok()?;
  let mut meta = DocumentMetadata::default();

  if let Some(title) = xml
    .descendants()
    .find(|n| is_tag(n, "title"))
    .and_then(|n| n.text())
  {
    let trimmed = title.trim();
    if !trimmed.is_empty() {
      meta.title = Some(trimmed.to_string());
    }
  }
  if let Some(author) = xml
    .descendants()
    .find(|n| is_tag(n, "creator"))
    .and_then(|n| n.text())
  {
    let trimmed = author.trim();
    if !trimmed.is_empty() && !trimmed.eq_ignore_ascii_case("unknown") {
      meta.author = Some(trimmed.to_string());
    }
  }
  if let Some(created) = xml
    .descendants()
    .find(|n| is_tag(n, "created"))
    .and_then(|n| n.text())
  {
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(created) {
      meta.created = Some(DateTime::<Utc>::from(dt));
    }
  }

  Some(meta)
}

#[derive(Debug, Default)]
struct StylesInfo {
  heading_level_by_style_id: HashMap<String, u8>,
  name_by_style_id: HashMap<String, String>,
  default_size_by_style_id: HashMap<String, u32>,
}

fn read_styles<R: Read + Seek>(zip: &mut ZipArchive<R>) -> StylesInfo {
  let text = match read_zip_text(zip, "word/styles.xml") {
    Some(t) => t,
    None => return StylesInfo::default(),
  };
  let doc = match XmlDoc::parse(strip_bom(&text)) {
    Ok(d) => d,
    Err(_) => return StylesInfo::default(),
  };
  let mut info = StylesInfo::default();

  for style in doc.descendants().filter(|n| is_tag(n, "style")) {
    if get_attr_local(&style, "type") != Some("paragraph") {
      continue;
    }
    let Some(style_id) = get_attr_local(&style, "styleId") else {
      continue;
    };
    let style_id = style_id.to_string();

    if let Some(name) = child(&style, "name").and_then(|n| get_attr_local(&n, "val")) {
      info
        .name_by_style_id
        .insert(style_id.clone(), name.to_string());
    }

    if let Some(rpr) = child(&style, "rPr") {
      if let Some(sz) = child(&rpr, "sz").and_then(|n| get_attr_local(&n, "val")) {
        if let Ok(v) = sz.parse::<u32>() {
          info.default_size_by_style_id.insert(style_id.clone(), v);
        }
      }
    }

    if let Some(ppr) = child(&style, "pPr") {
      if let Some(ol) = child(&ppr, "outlineLvl").and_then(|n| get_attr_local(&n, "val")) {
        if let Ok(v) = ol.parse::<u8>() {
          info
            .heading_level_by_style_id
            .insert(style_id.clone(), (v + 1).min(6));
        }
      }
    }

    if !info.heading_level_by_style_id.contains_key(&style_id) {
      let mut assigned: Option<u8> = None;
      if let Some(name) = info.name_by_style_id.get(&style_id) {
        assigned = parse_heading_level(name);
      }
      if assigned.is_none() {
        assigned = parse_heading_level(&style_id);
      }
      if assigned.is_none() {
        let name_l = info
          .name_by_style_id
          .get(&style_id)
          .map(|s| s.to_ascii_lowercase())
          .unwrap_or_default();
        let id_l = style_id.to_ascii_lowercase();
        if name_l.contains("title") || id_l.contains("title") {
          assigned = Some(1);
        } else if name_l.contains("heading") || id_l.contains("heading") {
          assigned = Some(2);
        }
      }
      if let Some(l) = assigned {
        info.heading_level_by_style_id.insert(style_id, l);
      }
    }
  }
  info
}

fn is_tag(node: &Node, local: &str) -> bool {
  node.is_element() && node.tag_name().name() == local
}

fn get_attr_local<'a>(node: &Node<'a, 'a>, local: &str) -> Option<&'a str> {
  node
    .attributes()
    .find(|a| {
      let name = a.name();
      match name.rsplit_once(':') {
        Some((_, l)) => l == local,
        None => name == local,
      }
    })
    .map(|a| a.value())
}

fn child<'a>(node: &Node<'a, 'a>, local: &str) -> Option<Node<'a, 'a>> {
  node
    .children()
    .find(|n| n.is_element() && n.tag_name().name() == local)
}

fn children<'a, 'b>(
  node: &Node<'a, 'a>,
  local: &'b str,
) -> impl Iterator<Item = Node<'a, 'a>> + use<'a, 'b> {
  node
    .children()
    .filter(move |n| n.is_element() && n.tag_name().name() == local)
}

fn normalize_inline(inline: Inline) -> Inline {
  match inline {
    Inline::Link { href, children } => Inline::Link {
      href,
      children: normalize_inlines(children),
    },
    Inline::Strong(children) => Inline::Strong(normalize_inlines(children)),
    Inline::Em(children) => Inline::Em(normalize_inlines(children)),
    Inline::Del(children) => Inline::Del(normalize_inlines(children)),
    Inline::Sup(children) => Inline::Sup(normalize_inlines(children)),
    Inline::Sub(children) => Inline::Sub(normalize_inlines(children)),
    inline => inline,
  }
}

fn is_mergeable_format(inline: &Inline) -> bool {
  matches!(
    inline,
    Inline::Strong(_) | Inline::Em(_) | Inline::Del(_) | Inline::Sup(_) | Inline::Sub(_)
  )
}

fn has_same_mergeable_format(left: &Inline, right: &Inline) -> bool {
  matches!(
    (left, right),
    (Inline::Strong(_), Inline::Strong(_))
      | (Inline::Em(_), Inline::Em(_))
      | (Inline::Del(_), Inline::Del(_))
      | (Inline::Sup(_), Inline::Sup(_))
      | (Inline::Sub(_), Inline::Sub(_))
  )
}

fn merge_formatted_inlines(target: &mut Inline, source: Inline, separator: Option<String>) {
  let (target_children, mut source_children) = match (target, source) {
    (Inline::Strong(target), Inline::Strong(source)) => (target, source),
    (Inline::Em(target), Inline::Em(source)) => (target, source),
    (Inline::Del(target), Inline::Del(source)) => (target, source),
    (Inline::Sup(target), Inline::Sup(source)) => (target, source),
    (Inline::Sub(target), Inline::Sub(source)) => (target, source),
    _ => unreachable!("formatted inline variants must match before merging"),
  };

  if let Some(separator) = separator {
    target_children.push(Inline::Text(separator));
  }
  target_children.append(&mut source_children);

  let children = std::mem::take(target_children);
  *target_children = normalize_inlines(children);
}

fn normalize_inlines(inlines: Vec<Inline>) -> Vec<Inline> {
  // Word may split visually identical formatting into arbitrary runs. Collapse
  // those run boundaries before HTML rendering so Markdown does not emit
  // adjacent delimiters such as `**10****th**`.
  let mut output: Vec<Inline> = Vec::with_capacity(inlines.len());
  let mut pending_whitespace: Option<String> = None;

  for inline in inlines.into_iter().map(normalize_inline) {
    let is_whitespace_after_format = match &inline {
      Inline::Text(value) => {
        !value.is_empty()
          && value.chars().all(char::is_whitespace)
          && output.last().map(is_mergeable_format).unwrap_or(false)
      }
      _ => false,
    };

    if is_whitespace_after_format {
      let Inline::Text(value) = inline else {
        unreachable!();
      };
      pending_whitespace
        .get_or_insert_with(String::new)
        .push_str(&value);
      continue;
    }

    if let Some(separator) = pending_whitespace.take() {
      let can_merge_across_whitespace = output
        .last()
        .map(|previous| has_same_mergeable_format(previous, &inline))
        .unwrap_or(false);

      if can_merge_across_whitespace {
        let previous = output.last_mut().expect("checked above");
        merge_formatted_inlines(previous, inline, Some(separator));
        continue;
      }

      output.push(Inline::Text(separator));
    }

    let can_merge_directly = output
      .last()
      .map(|previous| has_same_mergeable_format(previous, &inline))
      .unwrap_or(false);

    if can_merge_directly {
      let previous = output.last_mut().expect("checked above");
      merge_formatted_inlines(previous, inline, None);
    } else {
      output.push(inline);
    }
  }

  if let Some(whitespace) = pending_whitespace {
    output.push(Inline::Text(whitespace));
  }

  output
}

fn parse_paragraph_with_listinfo(
  node: &Node,
  rels: &Relationships,
  styles: &StylesInfo,
  size_buckets: &HashMap<String, Vec<u32>>,
  numbering: &NumberingInfo,
) -> Option<(Paragraph, Option<ListInfo>)> {
  let kind = paragraph_kind(node, styles, size_buckets);
  let base_style = paragraph_run_style(node);
  let mut inlines = Vec::new();

  for child in node.children().filter(|n| n.is_element()) {
    if is_tag(&child, "r") {
      let run_inlines = parse_run(&child, rels, &base_style);
      inlines.extend(run_inlines);
    } else if is_tag(&child, "hyperlink") {
      if let Some(link) = parse_hyperlink(&child, rels, &base_style) {
        inlines.push(link);
      }
    } else if is_tag(&child, "bookmarkStart") {
      if let Some(name) = get_attr_local(&child, "name") {
        inlines.push(Inline::Bookmark(BookmarkId(name.to_string())));
      }
    } else if is_tag(&child, "br") {
      inlines.push(Inline::LineBreak);
    }
  }

  let list_info = paragraph_list_info(node, numbering);
  Some((
    Paragraph {
      kind,
      inlines: normalize_inlines(inlines),
    },
    list_info,
  ))
}

fn paragraph_kind(
  p: &Node,
  styles: &StylesInfo,
  size_buckets: &HashMap<String, Vec<u32>>,
) -> ParagraphKind {
  let Some(ppr) = child(p, "pPr") else {
    return ParagraphKind::Normal;
  };

  if let Some(level) = child(&ppr, "outlineLvl").and_then(|n| get_attr_local(&n, "val")) {
    if let Ok(v) = level.parse::<u8>() {
      return ParagraphKind::Heading((v + 1).min(6));
    }
  }

  if let Some(style_id) = child(&ppr, "pStyle").and_then(|n| get_attr_local(&n, "val")) {
    let mut base_level: Option<u8> = styles.heading_level_by_style_id.get(style_id).copied();

    if base_level.is_none() {
      if let Some(name) = styles.name_by_style_id.get(style_id) {
        if let Some(l) = parse_heading_level(name) {
          base_level = Some(l);
        }
        if base_level.is_none() && name.to_ascii_lowercase().contains("quote") {
          return ParagraphKind::Blockquote;
        }
      }
    }
    if base_level.is_none() {
      if let Some(l) = parse_heading_level(style_id) {
        base_level = Some(l);
      }
    }
    if base_level.is_none() {
      let id_l = style_id.to_ascii_lowercase();
      let name_l = styles
        .name_by_style_id
        .get(style_id)
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();
      if name_l.contains("title") || id_l.contains("title") {
        base_level = Some(1);
      } else if name_l.contains("heading") || id_l.contains("heading") {
        base_level = Some(2);
      } else if name_l.contains("quote") || id_l.contains("quote") {
        return ParagraphKind::Blockquote;
      }
    }

    if let Some(mut level) = base_level {
      let para_size = paragraph_effective_size(p, styles, style_id);
      if let Some(buckets) = size_buckets.get(style_id) {
        if let Some(size) = para_size {
          if let Some(index) = buckets.iter().position(|&s| s == size) {
            level = (level + index as u8).min(6);
          }
        }
      }
      return ParagraphKind::Heading(level);
    }
  }

  ParagraphKind::Normal
}

fn parse_heading_level(s: &str) -> Option<u8> {
  let lower = s.to_ascii_lowercase();
  let idx = lower.find("heading")?;
  let rest = &lower[idx + "heading".len()..];
  let digits: String = rest
    .chars()
    .skip_while(|c| c.is_whitespace() || *c == '-')
    .take_while(|c| c.is_ascii_digit())
    .collect();
  if let Ok(n) = digits.parse::<u8>() {
    if n >= 1 {
      return Some(n.min(6));
    }
  }
  None
}

fn paragraph_effective_size(p: &Node, styles: &StylesInfo, style_id: &str) -> Option<u32> {
  let mut max_sz: Option<u32> = None;

  if let Some(ppr) = child(p, "pPr") {
    if let Some(rpr) = child(&ppr, "rPr") {
      if let Some(sz) = child(&rpr, "sz").and_then(|n| get_attr_local(&n, "val")) {
        if let Ok(v) = sz.parse::<u32>() {
          max_sz = Some(max_sz.map_or(v, |m| m.max(v)));
        }
      }
    }
  }

  for r in children(p, "r") {
    if let Some(rpr) = child(&r, "rPr") {
      if let Some(sz) = child(&rpr, "sz").and_then(|n| get_attr_local(&n, "val")) {
        if let Ok(v) = sz.parse::<u32>() {
          max_sz = Some(max_sz.map_or(v, |m| m.max(v)));
        }
      }
    }
  }

  max_sz.or_else(|| styles.default_size_by_style_id.get(style_id).copied())
}

fn compute_style_size_buckets_for_doc(
  xml: &XmlDoc,
  styles: &StylesInfo,
) -> HashMap<String, Vec<u32>> {
  let mut sets: HashMap<String, std::collections::BTreeSet<u32>> = HashMap::new();

  for p in xml.descendants().filter(|n| is_tag(n, "p")) {
    let Some(style_id) = child(&p, "pPr")
      .and_then(|n| child(&n, "pStyle"))
      .and_then(|n| get_attr_local(&n, "val"))
    else {
      continue;
    };

    let id_l = style_id.to_ascii_lowercase();
    let name_l = styles
      .name_by_style_id
      .get(style_id)
      .map(|s| s.to_ascii_lowercase())
      .unwrap_or_default();

    if !(id_l.contains("heading")
      || id_l.contains("title")
      || name_l.contains("heading")
      || name_l.contains("title"))
    {
      continue;
    }

    if let Some(sz) = paragraph_effective_size(&p, styles, style_id) {
      sets.entry(style_id.to_string()).or_default().insert(sz);
    }
  }

  sets
    .into_iter()
    .map(|(k, vset)| {
      let mut v: Vec<u32> = vset.into_iter().collect();
      v.sort_by(|a, b| b.cmp(a));
      (k, v)
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

#[derive(Clone, Copy)]
struct ResolvedRunStyle {
  bold: bool,
  italic: bool,
  strike: bool,
  code: bool,
  vert_align: VerticalAlign,
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

  fn resolve_with(&self, local: &RunStyle) -> ResolvedRunStyle {
    ResolvedRunStyle {
      bold: local.bold.or(self.bold).unwrap_or(false),
      italic: local.italic.or(self.italic).unwrap_or(false),
      strike: local.strike.or(self.strike).unwrap_or(false),
      code: local.code.or(self.code).unwrap_or(false),
      vert_align: local
        .vert_align
        .or(self.vert_align)
        .unwrap_or(VerticalAlign::Baseline),
    }
  }
}

impl ResolvedRunStyle {
  fn apply(self, mut inlines: Vec<Inline>) -> Vec<Inline> {
    if self.strike {
      inlines = vec![Inline::Del(inlines)];
    }
    if self.italic {
      inlines = vec![Inline::Em(inlines)];
    }
    if self.bold {
      inlines = vec![Inline::Strong(inlines)];
    }
    match self.vert_align {
      VerticalAlign::Superscript => vec![Inline::Sup(inlines)],
      VerticalAlign::Subscript => vec![Inline::Sub(inlines)],
      VerticalAlign::Baseline => inlines,
    }
  }
}

fn read_on_off(node: &Node) -> Option<bool> {
  let value = get_attr_local(node, "val").map(|v| v.to_ascii_lowercase());
  match value.as_deref() {
    None => Some(true),
    Some("0") | Some("false") | Some("off") => Some(false),
    Some(_) => Some(true),
  }
}

fn run_style_from_rpr(rpr: &Node) -> RunStyle {
  let mut style = RunStyle::default();

  if let Some(b) = child(rpr, "b").and_then(|n| read_on_off(&n)) {
    style.bold = Some(b);
  }
  if let Some(i) = child(rpr, "i").and_then(|n| read_on_off(&n)) {
    style.italic = Some(i);
  }
  if let Some(s) = child(rpr, "strike").and_then(|n| read_on_off(&n)) {
    style.strike = Some(s);
  }
  if let Some(rstyle) = child(rpr, "rStyle").and_then(|n| get_attr_local(&n, "val")) {
    if rstyle.to_ascii_lowercase().contains("code") {
      style.code = Some(true);
    }
  }
  if let Some(va) = child(rpr, "vertAlign").and_then(|n| get_attr_local(&n, "val")) {
    let lower = va.to_ascii_lowercase();
    let val = if lower == "sup" || lower == "superscript" {
      VerticalAlign::Superscript
    } else if lower == "sub" || lower == "subscript" {
      VerticalAlign::Subscript
    } else {
      VerticalAlign::Baseline
    };
    style.vert_align = Some(val);
  }

  style
}

fn paragraph_run_style(p: &Node) -> RunStyle {
  child(p, "pPr")
    .and_then(|ppr| child(&ppr, "rPr"))
    .map(|rpr| run_style_from_rpr(&rpr))
    .unwrap_or_default()
}

fn parse_run(run: &Node, _rels: &Relationships, base_style: &RunStyle) -> Vec<Inline> {
  let local_style = child(run, "rPr")
    .map(|rpr| run_style_from_rpr(&rpr))
    .unwrap_or_default();
  let resolved = base_style.resolve_with(&local_style);

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
      if let Some(id) = get_attr_local(&c, "id") {
        out.push(Inline::FootnoteRef(NoteId(id.to_string())));
      }
    } else if is_tag(&c, "endnoteReference") {
      if let Some(id) = get_attr_local(&c, "id") {
        out.push(Inline::EndnoteRef(NoteId(id.to_string())));
      }
    } else if is_tag(&c, "commentReference") {
      if let Some(id) = get_attr_local(&c, "id") {
        out.push(Inline::CommentRef(CommentId(id.to_string())));
      }
    }
  }

  if resolved.code {
    let code_text: String = out
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

  resolved.apply(out)
}

fn parse_hyperlink(node: &Node, rels: &Relationships, base_style: &RunStyle) -> Option<Inline> {
  let href = if let Some(id) = get_attr_local(node, "id") {
    rels.get(id).map(|s| s.to_string())
  } else {
    get_attr_local(node, "anchor").map(|anchor| format!("#{anchor}"))
  }?;

  let link_style = child(node, "rPr")
    .map(|rpr| run_style_from_rpr(&rpr))
    .unwrap_or_default();
  let combined_style = base_style.merged(&link_style);

  let mut children = Vec::new();
  for child in node.children().filter(|n| n.is_element()) {
    if is_tag(&child, "r") {
      children.extend(parse_run(&child, rels, &combined_style));
    }
  }

  Some(Inline::Link { href, children })
}

fn parse_table<R: Read + Seek>(
  node: &Node,
  rels: &Relationships,
  styles: &StylesInfo,
  size_buckets: &HashMap<String, Vec<u32>>,
  numbering: &NumberingInfo,
  zip: &mut ZipArchive<R>,
) -> Option<Table> {
  let mut rows = Vec::new();
  for tr in children(node, "tr") {
    let kind = table_row_kind(&tr);
    let mut cells = Vec::new();
    for tc in children(&tr, "tc") {
      let cell_blocks = parse_block_children(&tc, rels, styles, size_buckets, numbering, zip);
      let cell = TableCell {
        blocks: cell_blocks,
        colspan: NonZeroU32::new(1).unwrap(),
        rowspan: NonZeroU32::new(1).unwrap(),
      };
      cells.push(cell);
    }
    rows.push(TableRow { cells, kind });
  }

  if !rows.is_empty() && rows.iter().any(|r| matches!(r.kind, TableRowKind::Header)) {
    if let Some(last) = rows.last_mut() {
      last.kind = TableRowKind::Footer;
    }
  }
  Some(Table { rows })
}

fn table_row_kind(tr: &Node) -> TableRowKind {
  if let Some(trpr) = child(tr, "trPr") {
    if child(&trpr, "tblHeader").is_some() {
      return TableRowKind::Header;
    }
  }
  TableRowKind::Body
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
    let abs = self.num_to_abstract.get(num_id)?;
    let levels = self.abstract_levels.get(abs)?;
    levels.get(ilvl).copied()
  }
}

fn read_numbering<R: Read + Seek>(zip: &mut ZipArchive<R>) -> NumberingInfo {
  let text = match read_zip_text(zip, "word/numbering.xml") {
    Some(t) => t,
    None => return NumberingInfo::default(),
  };
  let doc = match XmlDoc::parse(strip_bom(&text)) {
    Ok(d) => d,
    Err(_) => return NumberingInfo::default(),
  };

  let mut info = NumberingInfo::default();

  for num in doc.descendants().filter(|n| is_tag(n, "num")) {
    if let Some(num_id) = get_attr_local(&num, "numId") {
      if let Some(abs) = child(&num, "abstractNumId").and_then(|n| get_attr_local(&n, "val")) {
        info
          .num_to_abstract
          .insert(num_id.to_string(), abs.to_string());
      }
    }
  }

  for abs in doc.descendants().filter(|n| is_tag(n, "abstractNum")) {
    if let Some(abs_id) = get_attr_local(&abs, "abstractNumId") {
      let mut levels: HashMap<String, ListType> = HashMap::new();
      for lvl in children(&abs, "lvl") {
        if let Some(ilvl) = get_attr_local(&lvl, "ilvl") {
          let fmt = child(&lvl, "numFmt").and_then(|n| get_attr_local(&n, "val"));
          let list_type = match fmt.unwrap_or("") {
            "bullet" => ListType::Unordered,
            _ => ListType::Ordered,
          };
          levels.insert(ilvl.to_string(), list_type);
        }
      }
      info.abstract_levels.insert(abs_id.to_string(), levels);
    }
  }

  info
}

fn paragraph_list_info(p: &Node, numbering: &NumberingInfo) -> Option<ListInfo> {
  let ppr = child(p, "pPr")?;
  let numpr = child(&ppr, "numPr")?;
  let ilvl_str = child(&numpr, "ilvl").and_then(|n| get_attr_local(&n, "val"))?;
  let num_id = child(&numpr, "numId").and_then(|n| get_attr_local(&n, "val"))?;
  let ilvl: u32 = ilvl_str.parse().unwrap_or(0);
  let list_type = numbering
    .list_type(num_id, ilvl_str)
    .unwrap_or(ListType::Unordered);
  Some(ListInfo {
    list_type,
    num_id: num_id.to_string(),
    ilvl,
  })
}

fn parse_block_children<R: Read + Seek>(
  parent: &Node,
  rels: &Relationships,
  styles: &StylesInfo,
  size_buckets: &HashMap<String, Vec<u32>>,
  numbering: &NumberingInfo,
  zip: &mut ZipArchive<R>,
) -> Vec<Block> {
  let nodes: Vec<Node> = parent.children().filter(|n| n.is_element()).collect();
  let mut out: Vec<Block> = Vec::new();
  let mut i = 0usize;

  while i < nodes.len() {
    let node = &nodes[i];
    if is_tag(node, "p") {
      if paragraph_list_info(node, numbering).is_some() {
        let (list, new_i) = parse_list(&nodes, i, rels, styles, size_buckets, numbering, zip);
        if !list.items.is_empty() {
          out.push(Block::List(list));
        }
        i = new_i;
        continue;
      }
      if let Some(image) = parse_image_paragraph(node, rels, zip) {
        out.push(Block::Image(image));
        i += 1;
        continue;
      }
      if let Some((para, _)) =
        parse_paragraph_with_listinfo(node, rels, styles, size_buckets, numbering)
      {
        if paragraph_has_visible_content(&para) {
          out.push(Block::Paragraph(para));
        }
      }
      i += 1;
    } else if is_tag(node, "tbl") {
      if let Some(table) = parse_table(node, rels, styles, size_buckets, numbering, zip) {
        out.push(Block::Table(table));
      }
      i += 1;
    } else {
      i += 1;
    }
  }
  out
}

fn parse_list<R: Read + Seek>(
  nodes: &[Node],
  mut i: usize,
  rels: &Relationships,
  styles: &StylesInfo,
  size_buckets: &HashMap<String, Vec<u32>>,
  numbering: &NumberingInfo,
  zip: &mut ZipArchive<R>,
) -> (List, usize) {
  let first_info =
    paragraph_list_info(&nodes[i], numbering).expect("parse_list called at non-list paragraph");
  let base_ilvl = first_info.ilvl;
  let base_num_id = first_info.num_id.clone();
  let base_type = first_info.list_type;

  let mut list = List {
    items: Vec::new(),
    list_type: base_type,
  };

  while i < nodes.len() {
    let node = &nodes[i];
    if !is_tag(node, "p") {
      break;
    }
    let info = match paragraph_list_info(node, numbering) {
      Some(x) => x,
      None => break,
    };
    if info.ilvl < base_ilvl {
      break;
    }
    if info.ilvl == base_ilvl && (info.list_type != base_type || info.num_id != base_num_id) {
      break;
    }

    if info.ilvl == base_ilvl {
      let mut blocks: Vec<Block> = Vec::new();
      if let Some(image) = parse_image_paragraph(node, rels, zip) {
        blocks.push(Block::Image(image));
      } else if let Some((para, _)) =
        parse_paragraph_with_listinfo(node, rels, styles, size_buckets, numbering)
      {
        if paragraph_has_visible_content(&para) {
          blocks.push(Block::Paragraph(para));
        }
      }
      list.items.push(ListItem { blocks });
      i += 1;

      loop {
        if i >= nodes.len() {
          break;
        }
        let node2 = &nodes[i];
        if !is_tag(node2, "p") {
          break;
        }
        match paragraph_list_info(node2, numbering) {
          Some(sub) if sub.ilvl > base_ilvl => {
            let (sublist, new_i) = parse_list(nodes, i, rels, styles, size_buckets, numbering, zip);
            if let Some(last) = list.items.last_mut() {
              last.blocks.push(Block::List(sublist));
            }
            i = new_i;
          }
          _ => break,
        }
      }

      if list.items.last().is_some_and(|last| last.blocks.is_empty()) {
        list.items.pop();
      }
    }
  }

  (list, i)
}

fn paragraph_has_visible_content(p: &Paragraph) -> bool {
  inlines_have_visible_content(&p.inlines)
}

fn inlines_have_visible_content(inlines: &[Inline]) -> bool {
  inlines.iter().any(inline_is_visible)
}

fn inline_is_visible(i: &Inline) -> bool {
  match i {
    Inline::Text(t) => !t.trim().is_empty(),
    Inline::LineBreak => false,
    Inline::Link { children, .. } => inlines_have_visible_content(children),
    Inline::Strong(c) | Inline::Em(c) | Inline::Del(c) | Inline::Sup(c) | Inline::Sub(c) => {
      inlines_have_visible_content(c)
    }
    Inline::Code(c) => !c.trim().is_empty(),
    Inline::FootnoteRef(_) | Inline::EndnoteRef(_) | Inline::CommentRef(_) => true,
    Inline::Bookmark(_) => false,
  }
}

fn parse_image_paragraph<R: Read + Seek>(
  p: &Node,
  rels: &Relationships,
  zip: &mut ZipArchive<R>,
) -> Option<Image> {
  let has_text = p
    .descendants()
    .filter(|n| is_tag(n, "t"))
    .any(|t| t.text().map(|s| !s.trim().is_empty()).unwrap_or(false));
  if has_text {
    return None;
  }

  if let Some(drawing) = p.descendants().find(|n| is_tag(n, "drawing")) {
    if let Some(img) = image_from_drawing(&drawing, rels, zip) {
      return Some(img);
    }
  }

  if let Some(pict) = p.descendants().find(|n| is_tag(n, "pict")) {
    if let Some(img) = image_from_vml(&pict, rels, zip) {
      return Some(img);
    }
  }
  None
}

fn image_from_drawing<R: Read + Seek>(
  drawing: &Node,
  rels: &Relationships,
  zip: &mut ZipArchive<R>,
) -> Option<Image> {
  let blip = drawing.descendants().find(|n| is_tag(n, "blip"))?;
  let rel_id = get_attr_local(&blip, "embed").or_else(|| get_attr_local(&blip, "link"))?;
  let alt = drawing
    .descendants()
    .find(|n| is_tag(n, "docPr"))
    .and_then(|n| get_attr_local(&n, "descr").or_else(|| get_attr_local(&n, "title")))
    .map(|s| s.to_string());
  image_from_relationship_id(rel_id, rels, zip, alt)
}

fn image_from_vml<R: Read + Seek>(
  pict: &Node,
  rels: &Relationships,
  zip: &mut ZipArchive<R>,
) -> Option<Image> {
  let imagedata = pict.descendants().find(|n| is_tag(n, "imagedata"))?;
  let rel_id = get_attr_local(&imagedata, "id")?;
  let alt = get_attr_local(&imagedata, "title").map(|s| s.to_string());
  image_from_relationship_id(rel_id, rels, zip, alt)
}

fn image_from_relationship_id<R: Read + Seek>(
  rid: &str,
  rels: &Relationships,
  _zip: &mut ZipArchive<R>,
  alt: Option<String>,
) -> Option<Image> {
  let target = rels.get(rid)?;
  // only include external images (http/https URLs)
  if target.starts_with("http://") || target.starts_with("https://") {
    return Some(Image {
      src: target.to_string(),
      alt,
    });
  }
  None
}

fn read_notes<R: Read + Seek>(
  zip: &mut ZipArchive<R>,
  xml_path: &str,
  rels_path: &str,
  kind: NoteKind,
  styles: &StylesInfo,
  size_buckets: &HashMap<String, Vec<u32>>,
  numbering: &NumberingInfo,
) -> Vec<Note> {
  let text = match read_zip_text(zip, xml_path) {
    Some(t) => t,
    None => return Vec::new(),
  };
  let doc = match XmlDoc::parse(strip_bom(&text)) {
    Ok(d) => d,
    Err(_) => return Vec::new(),
  };
  let rels = read_relationships(zip, rels_path);

  let mut notes = Vec::new();
  let root_tag = match kind {
    NoteKind::Footnote => "footnote",
    NoteKind::Endnote => "endnote",
  };
  for n in doc.descendants().filter(|n| is_tag(n, root_tag)) {
    let Some(id) = get_attr_local(&n, "id") else {
      continue;
    };

    if let Some(t) = get_attr_local(&n, "type") {
      if t == "separator" || t == "continuationSeparator" {
        continue;
      }
    }
    let blocks = parse_block_children(&n, &rels, styles, size_buckets, numbering, zip);
    notes.push(Note {
      id: NoteId(id.to_string()),
      kind,
      blocks,
    });
  }
  notes
}

fn read_comments<R: Read + Seek>(
  zip: &mut ZipArchive<R>,
  xml_path: &str,
  rels_path: &str,
  styles: &StylesInfo,
  size_buckets: &HashMap<String, Vec<u32>>,
  numbering: &NumberingInfo,
) -> Vec<Comment> {
  let text = match read_zip_text(zip, xml_path) {
    Some(t) => t,
    None => return Vec::new(),
  };
  let doc = match XmlDoc::parse(strip_bom(&text)) {
    Ok(d) => d,
    Err(_) => return Vec::new(),
  };
  let rels = read_relationships(zip, rels_path);

  let mut out = Vec::new();
  for c in doc.descendants().filter(|n| is_tag(n, "comment")) {
    let Some(id) = get_attr_local(&c, "id") else {
      continue;
    };

    let author = get_attr_local(&c, "author").map(|s| s.to_string());
    let initials = get_attr_local(&c, "initials").map(|s| s.to_string());
    let blocks = parse_block_children(&c, &rels, styles, size_buckets, numbering, zip);
    out.push(Comment {
      id: CommentId(id.to_string()),
      author_name: author,
      author_initials: initials,
      blocks,
    });
  }
  out
}

#[cfg(test)]
mod tests {
  use super::*;

  fn text(value: &str) -> Inline {
    Inline::Text(value.to_string())
  }

  fn strong(value: &str) -> Inline {
    Inline::Strong(vec![text(value)])
  }

  fn inlines_text(inlines: &[Inline]) -> String {
    let mut output = String::new();
    for inline in inlines {
      output.push_str(&inline_text(inline));
    }
    output
  }

  fn inline_text(inline: &Inline) -> String {
    match inline {
      Inline::Text(value) | Inline::Code(value) => value.clone(),
      Inline::LineBreak => "\n".to_string(),
      Inline::Link { children, .. }
      | Inline::Strong(children)
      | Inline::Em(children)
      | Inline::Del(children)
      | Inline::Sup(children)
      | Inline::Sub(children) => inlines_text(children),
      Inline::FootnoteRef(_)
      | Inline::EndnoteRef(_)
      | Inline::CommentRef(_)
      | Inline::Bookmark(_) => String::new(),
    }
  }

  #[test]
  fn merges_adjacent_strong_runs_and_preserves_whitespace() {
    let normalized = normalize_inlines(vec![
      strong("Milton Keynes University Hospital - (10"),
      strong("th"),
      text(" "),
      strong("June "),
      strong("2024 - Present) Senior Specialist Diagnostic Radiographer"),
    ]);

    assert_eq!(normalized.len(), 1);
    let Inline::Strong(children) = &normalized[0] else {
      panic!("expected a single strong inline");
    };
    assert_eq!(
      inlines_text(children),
      "Milton Keynes University Hospital - (10th June 2024 - Present) Senior Specialist Diagnostic Radiographer",
    );
  }

  #[test]
  fn merges_fragmented_bold_runs_when_parsing_word_xml() {
    let xml = XmlDoc::parse(
      r#"
        <w:p xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
          <w:r>
            <w:rPr><w:b/></w:rPr>
            <w:t>10</w:t>
          </w:r>
          <w:r>
            <w:rPr><w:b/></w:rPr>
            <w:t>th</w:t>
          </w:r>
          <w:r>
            <w:t xml:space="preserve"> </w:t>
          </w:r>
          <w:r>
            <w:rPr><w:b/></w:rPr>
            <w:t>June</w:t>
          </w:r>
        </w:p>
      "#,
    )
    .expect("valid WordprocessingML fixture");
    let size_buckets = std::collections::HashMap::new();
    let (paragraph, _) = parse_paragraph_with_listinfo(
      &xml.root_element(),
      &Relationships::default(),
      &StylesInfo::default(),
      &size_buckets,
      &NumberingInfo::default(),
    )
    .expect("paragraph should parse");

    let [Inline::Strong(children)] = paragraph.inlines.as_slice() else {
      panic!("expected fragmented Word runs to become one strong inline");
    };
    assert_eq!(inlines_text(children), "10th June");
  }

  #[test]
  fn recursively_merges_matching_nested_formatting() {
    let normalized = normalize_inlines(vec![
      Inline::Strong(vec![Inline::Em(vec![text("frag")])]),
      Inline::Strong(vec![Inline::Em(vec![text("mented")])]),
    ]);

    let [Inline::Strong(strong_children)] = normalized.as_slice() else {
      panic!("expected a single strong inline");
    };
    let [Inline::Em(em_children)] = strong_children.as_slice() else {
      panic!("expected nested emphasis to be merged");
    };
    assert_eq!(inlines_text(em_children), "fragmented");
  }

  #[test]
  fn does_not_merge_across_semantic_boundaries() {
    let normalized = normalize_inlines(vec![
      strong("before"),
      Inline::LineBreak,
      strong("after"),
      Inline::Link {
        href: "https://example.com".to_string(),
        children: vec![strong("linked")],
      },
      strong("tail"),
    ]);

    assert_eq!(normalized.len(), 5);
    assert!(matches!(normalized[0], Inline::Strong(_)));
    assert!(matches!(normalized[1], Inline::LineBreak));
    assert!(matches!(normalized[2], Inline::Strong(_)));
    assert!(matches!(normalized[3], Inline::Link { .. }));
    assert!(matches!(normalized[4], Inline::Strong(_)));
  }

  #[test]
  fn leaves_different_formatting_separate() {
    let normalized = normalize_inlines(vec![
      strong("bold"),
      Inline::Em(vec![text("italic")]),
      Inline::Del(vec![text("deleted")]),
    ]);

    assert_eq!(normalized.len(), 3);
    assert!(matches!(normalized[0], Inline::Strong(_)));
    assert!(matches!(normalized[1], Inline::Em(_)));
    assert!(matches!(normalized[2], Inline::Del(_)));
  }
}
