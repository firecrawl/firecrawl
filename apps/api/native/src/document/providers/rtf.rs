//! RTF provider. Tokenizes the RTF control stream and decodes 8-bit text
//! through the code page the document declares with \ansicpg.

use crate::document::encoding::encoding_for_codepage;
use crate::document::fields::hyperlink_target;
use crate::document::model::*;
use crate::document::providers::DocumentProvider;
use chrono::{DateTime, NaiveDate, NaiveDateTime, Utc};
use encoding_rs::{Encoding, WINDOWS_1252};
use std::collections::HashMap;
use std::error::Error;
use std::num::NonZeroU32;

pub struct RtfProvider;

impl RtfProvider {
  pub fn new() -> Self {
    Self
  }
}

impl DocumentProvider for RtfProvider {
  fn parse_buffer(&self, data: &[u8]) -> Result<Document, Box<dyn Error + Send + Sync>> {
    let encoding = detect_encoding(data);
    let metadata = extract_metadata(data, encoding);
    let heading_styles = parse_heading_styles(data);
    let blocks = parse_body(data, encoding, &heading_styles);

    Ok(Document {
      blocks,
      metadata,
      notes: Vec::new(),
      comments: Vec::new(),
    })
  }

  fn name(&self) -> &'static str {
    "rtf"
  }
}

/// Code page declared by the first \ansicpg control word.
fn detect_encoding(src: &[u8]) -> &'static Encoding {
  for token in Tokens::new(src) {
    if let Token::Control("ansicpg", Some(codepage)) = token {
      return u16::try_from(codepage)
        .ok()
        .and_then(encoding_for_codepage)
        .unwrap_or(WINDOWS_1252);
    }
  }
  WINDOWS_1252
}

#[derive(Debug, PartialEq)]
enum Token<'a> {
  Open,
  Close,
  Control(&'a str, Option<i32>),
  Symbol(u8),
  Hex(u8),
  Byte(u8),
}

struct Tokens<'a> {
  src: &'a [u8],
  pos: usize,
}

impl<'a> Tokens<'a> {
  fn new(src: &'a [u8]) -> Self {
    Self { src, pos: 0 }
  }
}

impl<'a> Iterator for Tokens<'a> {
  type Item = Token<'a>;

  fn next(&mut self) -> Option<Token<'a>> {
    loop {
      let b = *self.src.get(self.pos)?;
      self.pos += 1;
      match b {
        b'\r' | b'\n' => continue,
        b'{' => return Some(Token::Open),
        b'}' => return Some(Token::Close),
        b'\\' => return self.next_after_backslash(),
        b => return Some(Token::Byte(b)),
      }
    }
  }
}

impl<'a> Tokens<'a> {
  fn next_after_backslash(&mut self) -> Option<Token<'a>> {
    let b = *self.src.get(self.pos)?;
    self.pos += 1;
    match b {
      b'\'' => {
        let hi = self.src.get(self.pos).copied().and_then(hex_val);
        let lo = self.src.get(self.pos + 1).copied().and_then(hex_val);
        match (hi, lo) {
          (Some(hi), Some(lo)) => {
            self.pos += 2;
            Some(Token::Hex((hi << 4) | lo))
          }
          // malformed escape; drop it and keep tokenizing
          _ => Some(Token::Symbol(b'\'')),
        }
      }
      b'a'..=b'z' | b'A'..=b'Z' => {
        let start = self.pos - 1;
        while self.src.get(self.pos).is_some_and(u8::is_ascii_alphabetic) {
          self.pos += 1;
        }
        let word = std::str::from_utf8(&self.src[start..self.pos]).ok()?;

        let mut value = None;
        let negative = self.src.get(self.pos) == Some(&b'-');
        let num_start = self.pos + negative as usize;
        let mut num_end = num_start;
        while self.src.get(num_end).is_some_and(u8::is_ascii_digit) {
          num_end += 1;
        }
        if num_end > num_start {
          // consumed even when the value overflows i32
          self.pos = num_end;
          if let Some(n) = std::str::from_utf8(&self.src[num_start..num_end])
            .ok()
            .and_then(|s| s.parse::<i32>().ok())
          {
            value = Some(if negative { -n } else { n });
          }
        }
        if self.src.get(self.pos) == Some(&b' ') {
          self.pos += 1;
        }
        Some(Token::Control(word, value))
      }
      b => {
        if b == b'*' && self.src.get(self.pos) == Some(&b' ') {
          self.pos += 1;
        }
        Some(Token::Symbol(b))
      }
    }
  }
}

/// Fallback byte count declared by \uc.
fn uc_count(value: Option<i32>) -> usize {
  value.unwrap_or(1).max(0) as usize
}

fn hex_val(b: u8) -> Option<u8> {
  match b {
    b'0'..=b'9' => Some(b - b'0'),
    b'a'..=b'f' => Some(10 + b - b'a'),
    b'A'..=b'F' => Some(10 + b - b'A'),
    _ => None,
  }
}

/// Text accumulator; raw bytes are buffered and decoded as a unit.
struct TextAccum {
  encoding: &'static Encoding,
  pending: Vec<u8>,
  text: String,
}

impl TextAccum {
  fn new(encoding: &'static Encoding) -> Self {
    Self {
      encoding,
      pending: Vec::new(),
      text: String::new(),
    }
  }

  fn push_byte(&mut self, b: u8) {
    self.pending.push(b);
  }

  fn push_char(&mut self, c: char) {
    self.flush_pending();
    self.text.push(c);
  }

  fn flush_pending(&mut self) {
    if self.pending.is_empty() {
      return;
    }
    let (decoded, _) = self.encoding.decode_without_bom_handling(&self.pending);
    for ch in decoded.chars() {
      if ch == '\t' || ch == '\u{00A0}' || ch as u32 >= 0x20 {
        self.text.push(ch);
      }
    }
    self.pending.clear();
  }

  fn take(&mut self) -> String {
    self.flush_pending();
    std::mem::take(&mut self.text)
  }

  fn is_empty(&mut self) -> bool {
    self.flush_pending();
    self.text.is_empty()
  }
}

#[derive(Clone, Default)]
struct CharState {
  bold: bool,
  italic: bool,
  strike: bool,
  sup: bool,
  sub: bool,
}

struct Group {
  saved: CharState,
  skip: bool,
  name_seen: bool,
  starred: bool,
  dest: GroupDest,
}

#[derive(Default)]
struct TableBuilder {
  rows: Vec<TableRow>,
  current_row: Vec<TableCell>,
  current_cell_blocks: Vec<Block>,
}

impl TableBuilder {
  fn start_row(&mut self) {
    self.current_cell_blocks.clear();
    self.current_row.clear();
  }

  fn push_block(&mut self, block: Block) {
    self.current_cell_blocks.push(block);
  }

  fn finish_cell(&mut self) {
    if self.current_cell_blocks.is_empty() {
      return;
    }
    self.current_row.push(TableCell {
      blocks: std::mem::take(&mut self.current_cell_blocks),
      colspan: NonZeroU32::MIN,
      rowspan: NonZeroU32::MIN,
    });
  }

  fn finish_row(&mut self) {
    self.finish_cell();
    if self.current_row.is_empty() {
      return;
    }
    self.rows.push(TableRow {
      cells: std::mem::take(&mut self.current_row),
      kind: TableRowKind::Body,
    });
  }

  fn finalize(mut self) -> Option<Block> {
    self.finish_row();
    if self.rows.is_empty() {
      None
    } else {
      Some(Block::Table(Table { rows: self.rows }))
    }
  }
}

const SKIP_DESTS: &[&str] = &[
  "fonttbl",
  "colortbl",
  "stylesheet",
  "listtable",
  "listoverridetable",
  "themedata",
  "latentstyles",
  "rsidtbl",
  "xmlnstbl",
  "mmathPr",
  "wgrffmtfilter",
  "datastore",
  "filetbl",
  "colorschememapping",
  "pnseclvl1",
  "pnseclvl2",
  "pnseclvl3",
  "pnseclvl4",
  "pnseclvl5",
  "pnseclvl6",
  "pnseclvl7",
  "pnseclvl8",
  "pnseclvl9",
  "pict",
  "object",
  "info",
];

#[derive(Clone, Copy, PartialEq, Eq)]
enum GroupDest {
  None,
  Field,
  FldInst,
  ListText,
}

struct RtfField {
  instruction: String,
  result_start: usize,
}

struct BodyParser<'a> {
  heading_styles: &'a HashMap<i32, u8>,
  state: CharState,
  stack: Vec<Group>,
  blocks: Vec<Block>,
  inlines: Vec<Inline>,
  text: TextAccum,
  table: Option<TableBuilder>,
  in_table_cell: bool,
  uc_skip: usize,
  pending_uc_skip: usize,
  para_style: Option<i32>,
  para_outline: Option<u8>,
  para_list: Option<ListType>,
  para_ilvl: u8,
  list_stack: Vec<(u8, List)>,
  fields: Vec<RtfField>,
  instr: TextAccum,
  marker: TextAccum,
}

fn parse_body(
  src: &[u8],
  encoding: &'static Encoding,
  heading_styles: &HashMap<i32, u8>,
) -> Vec<Block> {
  let mut p = BodyParser {
    heading_styles,
    state: CharState::default(),
    stack: Vec::new(),
    blocks: Vec::new(),
    inlines: Vec::new(),
    text: TextAccum::new(encoding),
    table: None,
    in_table_cell: false,
    uc_skip: 1,
    pending_uc_skip: 0,
    para_style: None,
    para_outline: None,
    para_list: None,
    para_ilvl: 0,
    list_stack: Vec::new(),
    fields: Vec::new(),
    instr: TextAccum::new(encoding),
    marker: TextAccum::new(encoding),
  };

  for token in Tokens::new(src) {
    p.handle_token(token);
  }

  if !p.text.is_empty() || !p.inlines.is_empty() {
    p.flush_paragraph();
  }
  p.flush_table();
  p.flush_lists();
  p.blocks
}

impl BodyParser<'_> {
  fn skipping(&self) -> bool {
    self.stack.last().map(|g| g.skip).unwrap_or(false)
  }

  fn in_dest(&self, dest: GroupDest) -> bool {
    self.stack.iter().any(|g| g.dest == dest)
  }

  fn handle_token(&mut self, token: Token) {
    if self.pending_uc_skip > 0 {
      match token {
        Token::Byte(_) | Token::Hex(_) => {
          self.pending_uc_skip -= 1;
          return;
        }
        _ => self.pending_uc_skip = 0,
      }
    }

    match token {
      Token::Open => {
        let inherited_skip = self.skipping();
        self.stack.push(Group {
          saved: self.state.clone(),
          skip: inherited_skip,
          name_seen: false,
          starred: false,
          dest: GroupDest::None,
        });
      }
      Token::Close => {
        if !self.skipping() {
          self.flush_text();
        }
        if let Some(group) = self.stack.pop() {
          self.state = group.saved;
          match group.dest {
            GroupDest::FldInst => {
              let instruction = self.instr.take();
              if let Some(field) = self.fields.last_mut() {
                field.instruction.push_str(&instruction);
              }
            }
            GroupDest::ListText => {
              let marker = self.marker.take();
              self.para_list = Some(if marker.chars().any(|c| c.is_ascii_digit()) {
                ListType::Ordered
              } else {
                ListType::Unordered
              });
            }
            GroupDest::Field => self.close_field(),
            GroupDest::None => {}
          }
        }
      }
      Token::Byte(b) | Token::Hex(b) => {
        if self.skipping() {
          return;
        }
        if self.in_dest(GroupDest::FldInst) {
          self.instr.push_byte(b);
        } else if self.in_dest(GroupDest::ListText) {
          self.marker.push_byte(b);
        } else {
          self.text.push_byte(b);
        }
      }
      Token::Symbol(b'*') => {
        if let Some(group) = self.stack.last_mut() {
          if !group.name_seen {
            group.starred = true;
          }
        }
      }
      Token::Symbol(b @ (b'\\' | b'{' | b'}')) => {
        if !self.skipping() && !self.in_dest(GroupDest::ListText) {
          if self.in_dest(GroupDest::FldInst) {
            self.instr.push_byte(b);
          } else {
            self.text.push_byte(b);
          }
        }
      }
      Token::Symbol(b'~') => {
        if !self.skipping() {
          self.text.push_char('\u{00A0}');
        }
      }
      Token::Symbol(b'-') => {
        if !self.skipping() {
          self.text.push_char('\u{00AD}');
        }
      }
      Token::Symbol(_) => {}
      Token::Control(word, value) => self.handle_control(word, value),
    }
  }

  /// First control word of a group decides what the group is.
  fn name_group(&mut self, word: &str) {
    let Some(group) = self.stack.last_mut() else {
      return;
    };
    if group.name_seen {
      return;
    }
    group.name_seen = true;

    if group.starred {
      if word == "fldinst" && !self.fields.is_empty() {
        group.dest = GroupDest::FldInst;
      } else {
        group.skip = true;
      }
      return;
    }
    if SKIP_DESTS.contains(&word) {
      group.skip = true;
      return;
    }
    match word {
      "field" => {
        group.dest = GroupDest::Field;
        self.fields.push(RtfField {
          instruction: String::new(),
          result_start: usize::MAX,
        });
      }
      "listtext" | "pntext" => group.dest = GroupDest::ListText,
      _ => {}
    }
  }

  fn handle_control(&mut self, word: &str, value: Option<i32>) {
    self.name_group(word);

    if self.skipping() {
      return;
    }
    if word == "fldrslt" {
      self.flush_text();
      let start = self.inlines.len();
      if let Some(field) = self.fields.last_mut() {
        field.result_start = start;
      }
      return;
    }
    if self.in_dest(GroupDest::FldInst) || self.in_dest(GroupDest::ListText) {
      return;
    }
    if word == "par" {
      self.flush_paragraph();
      return;
    }

    let on = |value: Option<i32>| value.map(|v| v != 0).unwrap_or(true);
    match word {
      "rquote" => self.text.push_char('\u{2019}'),
      "lquote" => self.text.push_char('\u{2018}'),
      "rdblquote" => self.text.push_char('\u{201D}'),
      "ldblquote" => self.text.push_char('\u{201C}'),
      "emdash" => self.text.push_char('\u{2014}'),
      "endash" => self.text.push_char('\u{2013}'),
      "bullet" => self.text.push_char('\u{2022}'),
      "tab" => self.text.push_char('\t'),
      "line" => {
        self.flush_text();
        self.inlines.push(Inline::LineBreak);
      }
      "u" => {
        if let Some(mut code) = value {
          if code < 0 {
            code += 65536;
          }
          if let Some(ch) = char::from_u32(code as u32) {
            self.text.push_char(ch);
          }
          self.pending_uc_skip = self.uc_skip;
        }
      }
      "uc" => self.uc_skip = uc_count(value),
      "b" => {
        self.flush_text();
        self.state.bold = on(value);
      }
      "i" => {
        self.flush_text();
        self.state.italic = on(value);
      }
      "strike" | "striked" | "striked1" => {
        self.flush_text();
        self.state.strike = on(value);
      }
      "super" => {
        self.flush_text();
        self.state.sup = on(value);
        if self.state.sup {
          self.state.sub = false;
        }
      }
      "sub" => {
        self.flush_text();
        self.state.sub = on(value);
        if self.state.sub {
          self.state.sup = false;
        }
      }
      "nosupersub" => {
        self.flush_text();
        self.state.sup = false;
        self.state.sub = false;
      }
      "plain" => {
        self.flush_text();
        self.state = CharState::default();
      }
      "pard" => {
        self.para_style = None;
        self.para_outline = None;
        self.para_list = None;
        self.para_ilvl = 0;
      }
      "s" => self.para_style = value,
      "outlinelevel" => {
        self.para_outline = value
          .and_then(|v| u8::try_from(v).ok())
          .filter(|v| *v < 9)
          .map(|v| (v + 1).min(6));
      }
      "ilvl" => {
        self.para_ilvl = value.and_then(|v| u8::try_from(v).ok()).unwrap_or(0).min(8);
      }
      "trowd" => {
        self
          .table
          .get_or_insert_with(TableBuilder::default)
          .start_row();
        self.in_table_cell = false;
      }
      "intbl" => self.in_table_cell = true,
      "cell" => {
        self.in_table_cell = true;
        self.flush_paragraph();
        if let Some(table) = self.table.as_mut() {
          table.finish_cell();
        }
        self.in_table_cell = false;
      }
      "row" => {
        if let Some(table) = self.table.as_mut() {
          table.finish_row();
        }
        self.in_table_cell = false;
      }
      _ => {}
    }
  }

  fn flush_text(&mut self) {
    let text = self.text.take();
    if text.is_empty() {
      return;
    }
    let mut node = Inline::Text(text);
    if self.state.strike {
      node = Inline::Del(vec![node]);
    }
    if self.state.italic {
      node = Inline::Em(vec![node]);
    }
    if self.state.bold {
      node = Inline::Strong(vec![node]);
    }
    if self.state.sup {
      node = Inline::Sup(vec![node]);
    } else if self.state.sub {
      node = Inline::Sub(vec![node]);
    }
    self.inlines.push(node);
  }

  fn close_field(&mut self) {
    self.flush_text();
    let Some(field) = self.fields.pop() else {
      return;
    };
    let Some(href) = hyperlink_target(&field.instruction) else {
      return;
    };
    let start = field.result_start.min(self.inlines.len());
    let children = self.inlines.split_off(start);
    if has_visible_content(&children) {
      self.inlines.push(Inline::Link { href, children });
    } else {
      self.inlines.extend(children);
    }
  }

  fn paragraph_kind(&self) -> ParagraphKind {
    if let Some(level) = self.para_outline {
      return ParagraphKind::Heading(level);
    }
    match self
      .para_style
      .and_then(|style| self.heading_styles.get(&style))
    {
      Some(level) => ParagraphKind::Heading(*level),
      None => ParagraphKind::Normal,
    }
  }

  fn flush_paragraph(&mut self) {
    self.flush_text();
    // links cannot span paragraphs
    for field in &mut self.fields {
      field.result_start = 0;
    }
    let kind = self.paragraph_kind();
    let list_type = self.para_list.take();
    if has_visible_content(&self.inlines) {
      let block = Block::Paragraph(Paragraph {
        kind,
        inlines: std::mem::take(&mut self.inlines),
      });
      if self.in_table_cell {
        if let Some(table) = self.table.as_mut() {
          table.push_block(block);
        } else {
          self.blocks.push(block);
        }
      } else if let (Some(list_type), ParagraphKind::Normal) = (list_type, kind) {
        self.flush_table();
        self.push_list_item(block, self.para_ilvl, list_type);
      } else {
        self.flush_table();
        self.flush_lists();
        self.blocks.push(block);
      }
    } else {
      self.inlines.clear();
      if !self.in_table_cell {
        self.flush_table();
      }
    }
  }

  fn push_list_item(&mut self, paragraph: Block, ilvl: u8, list_type: ListType) {
    while self
      .list_stack
      .last()
      .is_some_and(|(level, _)| *level > ilvl)
    {
      self.collapse_list();
    }
    let start_new = match self.list_stack.last() {
      Some((level, _)) => *level < ilvl,
      None => true,
    };
    if start_new {
      self.list_stack.push((
        ilvl,
        List {
          items: Vec::new(),
          list_type,
        },
      ));
    }
    if let Some((_, list)) = self.list_stack.last_mut() {
      list.items.push(ListItem {
        blocks: vec![paragraph],
      });
    }
  }

  fn collapse_list(&mut self) {
    let Some((_, list)) = self.list_stack.pop() else {
      return;
    };
    let block = Block::List(list);
    match self.list_stack.last_mut() {
      Some((_, parent)) => match parent.items.last_mut() {
        Some(item) => item.blocks.push(block),
        None => parent.items.push(ListItem {
          blocks: vec![block],
        }),
      },
      None => self.blocks.push(block),
    }
  }

  fn flush_lists(&mut self) {
    while !self.list_stack.is_empty() {
      self.collapse_list();
    }
  }

  fn flush_table(&mut self) {
    if let Some(table) = self.table.take() {
      if let Some(block) = table.finalize() {
        self.flush_lists();
        self.blocks.push(block);
      }
    }
  }
}

/// Style numbers of heading styles, from the stylesheet's style names.
fn parse_heading_styles(src: &[u8]) -> HashMap<i32, u8> {
  let mut map = HashMap::new();
  let Some(sheet) = find_group(src, b"{\\stylesheet") else {
    return map;
  };
  let mut depth = 0usize;
  let mut style: Option<i32> = None;
  let mut name = String::new();
  for token in Tokens::new(sheet) {
    match token {
      Token::Open => {
        depth += 1;
        if depth == 2 {
          style = None;
          name.clear();
        }
      }
      Token::Close => {
        if depth == 2 {
          if let (Some(id), Some(level)) = (style, heading_level_from_style_name(&name)) {
            map.insert(id, level);
          }
        }
        depth = depth.saturating_sub(1);
      }
      Token::Control("s", Some(id)) if depth == 2 && style.is_none() => style = Some(id),
      Token::Byte(b) if depth == 2 && name.len() < 64 => name.push(b as char),
      _ => {}
    }
  }
  map
}

fn heading_level_from_style_name(name: &str) -> Option<u8> {
  let lower = name
    .trim()
    .trim_end_matches(';')
    .trim()
    .to_ascii_lowercase();
  if lower.contains("title") {
    return Some(1);
  }
  let tail = &lower[lower.find("heading")? + "heading".len()..];
  let digits: String = tail.chars().filter(|c| c.is_ascii_digit()).collect();
  digits.parse::<u8>().ok().map(|n| n.clamp(1, 6))
}

fn extract_metadata(src: &[u8], encoding: &'static Encoding) -> DocumentMetadata {
  let mut metadata = DocumentMetadata::default();
  let Some(info) = find_group(src, b"{\\info") else {
    return metadata;
  };

  if let Some(author) = find_group(info, b"{\\author").and_then(|g| group_text(g, encoding)) {
    if !author.eq_ignore_ascii_case("unknown") {
      metadata.author = Some(author);
    }
  }
  if let Some(title) = find_group(info, b"{\\title").and_then(|g| group_text(g, encoding)) {
    metadata.title = Some(title);
  }
  metadata.created = find_group(info, b"{\\creatim").and_then(parse_timestamp);

  metadata
}

fn find_group<'a>(buf: &'a [u8], start_tag: &[u8]) -> Option<&'a [u8]> {
  let start = buf.windows(start_tag.len()).position(|w| w == start_tag)?;
  let mut depth = 0usize;
  for (i, &b) in buf[start..].iter().enumerate() {
    match b {
      b'{' => depth += 1,
      b'}' => {
        depth -= 1;
        if depth == 0 {
          return Some(&buf[start..start + i + 1]);
        }
      }
      _ => {}
    }
  }
  None
}

/// Plain text of a destination group, flattening nested formatting groups
/// and ignoring \*-prefixed destinations.
fn group_text(group: &[u8], encoding: &'static Encoding) -> Option<String> {
  let mut accum = TextAccum::new(encoding);
  let mut depth = 0usize;
  let mut ignored_depth: Option<usize> = None;
  let mut just_opened = false;
  let mut pending_uc_skip = 0usize;
  let mut uc_skip = 1usize;

  for token in Tokens::new(group) {
    if just_opened {
      just_opened = false;
      if matches!(token, Token::Symbol(b'*')) && ignored_depth.is_none() {
        ignored_depth = Some(depth);
        continue;
      }
    }
    match token {
      Token::Open => {
        depth += 1;
        just_opened = true;
        continue;
      }
      Token::Close => {
        depth = depth.saturating_sub(1);
        if ignored_depth.is_some_and(|d| depth < d) {
          ignored_depth = None;
        }
        continue;
      }
      _ => {}
    }
    if ignored_depth.is_some() {
      continue;
    }
    if pending_uc_skip > 0 {
      match token {
        Token::Byte(_) | Token::Hex(_) => {
          pending_uc_skip -= 1;
          continue;
        }
        _ => pending_uc_skip = 0,
      }
    }
    match token {
      Token::Byte(b) | Token::Hex(b) => accum.push_byte(b),
      Token::Symbol(b @ (b'\\' | b'{' | b'}')) => accum.push_byte(b),
      Token::Control("u", Some(mut code)) => {
        if code < 0 {
          code += 65536;
        }
        if let Some(ch) = char::from_u32(code as u32) {
          accum.push_char(ch);
        }
        pending_uc_skip = uc_skip;
      }
      Token::Control("uc", value) => uc_skip = uc_count(value),
      _ => {}
    }
  }

  let text = accum.take().trim().to_string();
  if text.is_empty() {
    None
  } else {
    Some(text)
  }
}

fn parse_timestamp(group: &[u8]) -> Option<DateTime<Utc>> {
  let mut yr = None;
  let mut mo = None;
  let mut dy = None;
  let mut hr = None;
  let mut mi = None;

  for token in Tokens::new(group) {
    if let Token::Control(word, value) = token {
      match word {
        "yr" => yr = value,
        "mo" => mo = value.map(|v| v as u32),
        "dy" => dy = value.map(|v| v as u32),
        "hr" => hr = value.map(|v| v as u32),
        "min" => mi = value.map(|v| v as u32),
        _ => {}
      }
    }
  }

  let date = NaiveDate::from_ymd_opt(yr?, mo?, dy?)?;
  let time = chrono::NaiveTime::from_hms_opt(hr.unwrap_or(0), mi.unwrap_or(0), 0)?;
  Some(DateTime::<Utc>::from_naive_utc_and_offset(
    NaiveDateTime::new(date, time),
    Utc,
  ))
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::document::providers::DocumentProvider;

  fn paragraphs(data: &[u8]) -> Vec<String> {
    let document = RtfProvider::new().parse_buffer(data).unwrap();
    document
      .blocks
      .iter()
      .filter_map(|block| match block {
        Block::Paragraph(p) => Some(inline_text(&p.inlines)),
        _ => None,
      })
      .collect()
  }

  fn inline_text(inlines: &[Inline]) -> String {
    inlines
      .iter()
      .map(|inline| match inline {
        Inline::Text(t) => t.clone(),
        Inline::Link { children, .. } => inline_text(children),
        Inline::Strong(c) | Inline::Em(c) | Inline::Del(c) | Inline::Sup(c) | Inline::Sub(c) => {
          inline_text(c)
        }
        _ => String::new(),
      })
      .collect()
  }

  #[test]
  fn ansicpg1251_hex_escapes() {
    let rtf = b"{\\rtf1\\ansi\\ansicpg1251 \\'d3\\'ea\\'f0\\'e0\\'bf\\'ed\\'e0\\par}";
    assert_eq!(paragraphs(rtf), vec!["Україна"]);
  }

  #[test]
  fn default_cp1252_hex_escapes() {
    let rtf = b"{\\rtf1\\ansi Caf\\'e9 \\'93ok\\'94\\par}";
    assert_eq!(paragraphs(rtf), vec!["Café \u{201C}ok\u{201D}"]);
  }

  #[test]
  fn unicode_escape_with_fallback() {
    let rtf = b"{\\rtf1\\ansi\\uc1 \\u1059?\\u1082?\\u1088? ok\\par}";
    assert_eq!(paragraphs(rtf), vec!["Укр ok"]);
  }

  #[test]
  fn shift_jis_double_byte_pairs() {
    let rtf = b"{\\rtf1\\ansi\\ansicpg932 \\'93\\'fa\\'96\\'7b\\par}";
    assert_eq!(paragraphs(rtf), vec!["日本"]);
  }

  #[test]
  fn styles_and_tables_still_parse() {
    let rtf =
      b"{\\rtf1\\ansi {\\b Bold} and {\\i italic}\\par\\trowd\\intbl A\\cell B\\cell\\row\\par}";
    let document = RtfProvider::new().parse_buffer(rtf).unwrap();
    assert!(matches!(document.blocks[0], Block::Paragraph(_)));
    assert!(document
      .blocks
      .iter()
      .any(|b| matches!(b, Block::Table(t) if t.rows[0].cells.len() == 2)));
  }

  #[test]
  fn info_metadata_decodes_with_document_codepage() {
    let rtf = b"{\\rtf1\\ansi\\ansicpg1251{\\info{\\title \\'d3\\'ea\\'e0\\'e7}{\\author Iryna}{\\creatim\\yr2022\\mo6\\dy9\\hr15\\min24}}Body\\par}";
    let document = RtfProvider::new().parse_buffer(rtf).unwrap();
    assert_eq!(document.metadata.title.as_deref(), Some("Указ"));
    assert_eq!(document.metadata.author.as_deref(), Some("Iryna"));
    assert_eq!(
      document.metadata.created.unwrap().to_rfc3339(),
      "2022-06-09T15:24:00+00:00"
    );
  }

  #[test]
  fn metadata_keeps_text_of_nested_formatting_groups() {
    let rtf = b"{\\rtf1{\\info{\\title Some {\\b Bold} Title{\\*\\junk secret}}}Body\\par}";
    let document = RtfProvider::new().parse_buffer(rtf).unwrap();
    assert_eq!(document.metadata.title.as_deref(), Some("Some Bold Title"));
  }

  #[test]
  fn par_inside_ignored_destination_does_not_split_paragraphs() {
    let rtf = b"{\\rtf1\\ansi Hello{\\*\\junkdest gone\\par gone too} world\\par}";
    assert_eq!(paragraphs(rtf), vec!["Hello world"]);
  }

  #[test]
  fn malformed_hex_escape_does_not_truncate_document() {
    let rtf = b"{\\rtf1\\ansi before \\'zz after\\par}";
    assert_eq!(paragraphs(rtf), vec!["before zz after"]);
  }

  #[test]
  fn escaped_ansicpg_literal_does_not_change_encoding() {
    let rtf = b"{\\rtf1\\ansi text \\\\ansicpg1251 \\'e9\\par}";
    assert_eq!(paragraphs(rtf), vec!["text \\ansicpg1251 é"]);
  }

  #[test]
  fn overflowing_control_parameter_digits_do_not_leak() {
    let rtf = b"{\\rtf1\\ansi a\\u99999999999999x b\\par}";
    assert_eq!(paragraphs(rtf), vec!["ax b"]);
  }

  #[test]
  fn uc_above_eight_skips_declared_fallback_bytes() {
    let rtf = b"{\\rtf1\\ansi\\uc10\\u1059 abcdefghijkl\\par}";
    assert_eq!(paragraphs(rtf), vec!["Уkl"]);
  }

  #[test]
  fn huge_uc_value_stays_bounded_by_input() {
    let rtf = b"{\\rtf1\\ansi\\uc2000000000\\u1059 abc\\par done\\par}";
    assert_eq!(paragraphs(rtf), vec!["У", "done"]);
  }

  #[test]
  fn headings_from_stylesheet_and_outline_level() {
    let rtf = b"{\\rtf1\\ansi{\\stylesheet{Normal;}{\\s1 heading 1;}{\\s2 heading 2;}}\\pard\\s1 Title\\par\\pard\\s2 Section\\par\\pard Body\\par\\pard\\outlinelevel2 Deep\\par}";
    let document = RtfProvider::new().parse_buffer(rtf).unwrap();
    let kinds: Vec<ParagraphKind> = document
      .blocks
      .iter()
      .filter_map(|b| match b {
        Block::Paragraph(p) => Some(p.kind),
        _ => None,
      })
      .collect();
    assert_eq!(
      kinds,
      vec![
        ParagraphKind::Heading(1),
        ParagraphKind::Heading(2),
        ParagraphKind::Normal,
        ParagraphKind::Heading(3)
      ]
    );
  }

  #[test]
  fn hyperlink_fields_become_links() {
    let rtf = b"{\\rtf1\\ansi See {\\field{\\*\\fldinst HYPERLINK \"https://example.com\"}{\\fldrslt the site}} now\\par}";
    let document = RtfProvider::new().parse_buffer(rtf).unwrap();
    let Block::Paragraph(p) = &document.blocks[0] else {
      panic!("expected paragraph");
    };
    let link = p.inlines.iter().find_map(|i| match i {
      Inline::Link { href, children } => Some((href.clone(), inline_text(children))),
      _ => None,
    });
    assert_eq!(
      link,
      Some(("https://example.com".to_string(), "the site".to_string()))
    );
    assert_eq!(inline_text(&p.inlines), "See the site now");
  }

  #[test]
  fn non_hyperlink_fields_keep_result_text() {
    let rtf = b"{\\rtf1\\ansi Page {\\field{\\*\\fldinst PAGE}{\\fldrslt 7}} of 9\\par}";
    assert_eq!(paragraphs(rtf), vec!["Page 7 of 9"]);
  }

  #[test]
  fn listtext_markers_build_lists() {
    let rtf = b"{\\rtf1\\ansi\\pard{\\listtext \\'95\\tab}First\\par\\pard{\\listtext \\'95\\tab}Second\\par\\pard After\\par}";
    let document = RtfProvider::new().parse_buffer(rtf).unwrap();
    let Block::List(list) = &document.blocks[0] else {
      panic!("expected list, got {:?}", document.blocks[0]);
    };
    assert_eq!(list.list_type, ListType::Unordered);
    assert_eq!(list.items.len(), 2);
    assert!(
      matches!(&document.blocks[1], Block::Paragraph(p) if inline_text(&p.inlines) == "After")
    );
  }

  #[test]
  fn numbered_listtext_markers_build_ordered_lists() {
    let rtf = b"{\\rtf1\\ansi\\pard{\\listtext 1.\\tab}One\\par\\pard{\\listtext 2.\\tab}Two\\par}";
    let document = RtfProvider::new().parse_buffer(rtf).unwrap();
    let Block::List(list) = &document.blocks[0] else {
      panic!("expected list, got {:?}", document.blocks[0]);
    };
    assert_eq!(list.list_type, ListType::Ordered);
    assert_eq!(list.items.len(), 2);
  }
}
