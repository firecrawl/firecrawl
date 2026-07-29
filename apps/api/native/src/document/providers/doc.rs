//! Legacy Word binary (.doc) provider, following the MS-DOC piece table and
//! formatting bin table (FKP) formats.

use crate::document::encoding::{encoding_for_codepage, encoding_for_lid};
use crate::document::model::*;
use crate::document::oleps::parse_summary_information;
use crate::document::providers::DocumentProvider;
use cfb::CompoundFile;
use encoding_rs::Encoding;
use std::error::Error;
use std::io::{Cursor, Read, Seek};
use std::num::NonZeroU32;

const MAGIC_WORD_97: u16 = 0xA5EC;
const MAGIC_WORD_6_95: u16 = 0xA5DC;

/// Upper bound on text extracted from one document.
const MAX_TEXT_CHARS: usize = 10_000_000;

const FKP_PAGE_SIZE: usize = 512;
const MAX_FIELD_INSTRUCTION_CHARS: usize = 2048;

pub struct DocProvider;

impl DocProvider {
  pub fn new() -> Self {
    Self
  }
}

impl DocumentProvider for DocProvider {
  fn parse_buffer(&self, data: &[u8]) -> Result<Document, Box<dyn Error + Send + Sync>> {
    let mut cfb = CompoundFile::open(Cursor::new(data))?;

    let summary = read_stream(&mut cfb, "\x05SummaryInformation")
      .ok()
      .and_then(|bytes| parse_summary_information(&bytes));

    let word_doc = read_stream(&mut cfb, "WordDocument")?;
    let fib = Fib::parse(&word_doc)?;

    let (primary, secondary) = if fib.table_stream_1 {
      ("1Table", "0Table")
    } else {
      ("0Table", "1Table")
    };
    let table = read_stream(&mut cfb, primary)
      .or_else(|_| read_stream(&mut cfb, secondary))
      .ok();

    let ansi = summary
      .as_ref()
      .and_then(|s| s.codepage)
      .and_then(encoding_for_codepage)
      .unwrap_or_else(|| encoding_for_lid(fib.lid));

    let segments = extract_segments(&word_doc, table.as_deref(), &fib, ansi);
    let formatting = if fib.legacy {
      Formatting::default()
    } else {
      table
        .as_deref()
        .map(|table| Formatting::parse(&word_doc, table, &fib))
        .unwrap_or_default()
    };

    let mut metadata = DocumentMetadata::default();
    if let Some(summary) = summary {
      metadata.title = summary.title;
      metadata.author = summary.author;
      metadata.created = summary.created;
    }

    Ok(Document {
      blocks: build_blocks(&segments, &formatting),
      metadata,
      notes: Vec::new(),
      comments: Vec::new(),
    })
  }

  fn name(&self) -> &'static str {
    "doc"
  }
}

fn read_stream<R: Read + Seek>(
  cfb: &mut CompoundFile<R>,
  name: &str,
) -> Result<Vec<u8>, Box<dyn Error + Send + Sync>> {
  let mut stream = cfb.open_stream(name)?;
  let mut buf = Vec::new();
  stream.read_to_end(&mut buf)?;
  Ok(buf)
}

struct Fib {
  legacy: bool,
  lid: u16,
  table_stream_1: bool,
  ext_char: bool,
  fc_min: usize,
  fc_mac: usize,
  ccp_text: usize,
  fc_clx: usize,
  lcb_clx: usize,
  fc_plcf_bte_chpx: usize,
  lcb_plcf_bte_chpx: usize,
  fc_plcf_bte_papx: usize,
  lcb_plcf_bte_papx: usize,
}

impl Fib {
  fn parse(word_doc: &[u8]) -> Result<Self, Box<dyn Error + Send + Sync>> {
    if word_doc.len() < 0x20 {
      return Err("WordDocument stream too short".into());
    }
    let magic = read_u16(word_doc, 0x00);
    let legacy = match magic {
      MAGIC_WORD_97 => false,
      MAGIC_WORD_6_95 => true,
      _ => return Err(format!("not a Word document (magic {magic:#06X})").into()),
    };

    let flags = read_u16(word_doc, 0x0A);
    if flags & 0x0100 != 0 {
      return Err("encrypted .doc files are not supported".into());
    }

    let u32_at = |offset: usize| {
      if word_doc.len() >= offset + 4 {
        read_u32(word_doc, offset) as usize
      } else {
        0
      }
    };

    Ok(Fib {
      legacy,
      lid: read_u16(word_doc, 0x06),
      table_stream_1: flags & 0x0200 != 0,
      ext_char: flags & 0x1000 != 0,
      fc_min: read_u32(word_doc, 0x18) as usize,
      fc_mac: read_u32(word_doc, 0x1C) as usize,
      ccp_text: u32_at(0x4C),
      fc_clx: u32_at(0x1A2),
      lcb_clx: u32_at(0x1A6),
      fc_plcf_bte_chpx: u32_at(0xFA),
      lcb_plcf_bte_chpx: u32_at(0xFE),
      fc_plcf_bte_papx: u32_at(0x102),
      lcb_plcf_bte_papx: u32_at(0x106),
    })
  }
}

/// Decoded text run and the stream offset its bytes came from.
struct TextSegment {
  text: String,
  fc_start: u32,
  bytes_per_char: u8,
}

fn extract_segments(
  word_doc: &[u8],
  table: Option<&[u8]>,
  fib: &Fib,
  ansi: &'static Encoding,
) -> Vec<TextSegment> {
  if !fib.legacy {
    if let Some(table) = table {
      if let Some(pieces) = parse_piece_table(table, fib) {
        return decode_pieces(word_doc, &pieces, fib.ccp_text, ansi);
      }
    }
  }

  // Word 6/95 files and corrupt piece tables: text is at fcMin..fcMac.
  let start = fib.fc_min.min(word_doc.len());
  let end = fib.fc_mac.clamp(start, word_doc.len());
  let bytes = &word_doc[start..end];
  let (text, bytes_per_char) = if fib.ext_char {
    (decode_utf16le(bytes), 2)
  } else {
    (ansi.decode_without_bom_handling(bytes).0.into_owned(), 1)
  };
  vec![TextSegment {
    text,
    fc_start: start as u32,
    bytes_per_char,
  }]
}

struct Piece {
  start_cp: u32,
  end_cp: u32,
  offset: usize,
  compressed: bool,
}

fn parse_piece_table(table: &[u8], fib: &Fib) -> Option<Vec<Piece>> {
  if fib.lcb_clx == 0 {
    return None;
  }
  let clx = table.get(fib.fc_clx..fib.fc_clx.checked_add(fib.lcb_clx)?)?;

  // Clx: zero or more Prc (0x01) blocks, then the Pcdt (0x02) piece table.
  let mut i = 0;
  while i < clx.len() {
    match clx[i] {
      0x01 => {
        let cb = read_u16(clx.get(i + 1..i + 3)?, 0) as usize;
        i += 3 + cb;
      }
      0x02 => {
        let lcb = read_u32(clx.get(i + 1..i + 5)?, 0) as usize;
        let plc = clx.get(i + 5..(i + 5).checked_add(lcb)?)?;
        return parse_plc_pcd(plc);
      }
      _ => return None,
    }
  }
  None
}

fn parse_plc_pcd(plc: &[u8]) -> Option<Vec<Piece>> {
  // n+1 CPs (4 bytes each) followed by n PCDs (8 bytes each)
  if plc.len() < 16 || (plc.len() - 4) % 12 != 0 {
    return None;
  }
  let n = (plc.len() - 4) / 12;

  let mut pieces = Vec::with_capacity(n);
  for k in 0..n {
    let start_cp = read_u32(plc, k * 4);
    let end_cp = read_u32(plc, (k + 1) * 4);
    if end_cp < start_cp {
      return None;
    }
    let fc = read_u32(plc, 4 * (n + 1) + 8 * k + 2);
    let compressed = fc & 0x4000_0000 != 0;
    let offset = if compressed {
      ((fc & 0x3FFF_FFFF) / 2) as usize
    } else {
      (fc & 0x3FFF_FFFF) as usize
    };
    pieces.push(Piece {
      start_cp,
      end_cp,
      offset,
      compressed,
    });
  }
  Some(pieces)
}

fn decode_pieces(
  word_doc: &[u8],
  pieces: &[Piece],
  ccp_text: usize,
  ansi: &'static Encoding,
) -> Vec<TextSegment> {
  // piece cp ranges are contiguous, so this clamp bounds total output
  let ccp_text = ccp_text.min(MAX_TEXT_CHARS);
  let mut segments = Vec::new();
  for piece in pieces {
    // body text only; cps past ccpText are headers, footnotes etc.
    if piece.start_cp as usize >= ccp_text {
      continue;
    }
    let count = (piece.end_cp as usize).min(ccp_text) - piece.start_cp as usize;
    let available = word_doc.len().saturating_sub(piece.offset);
    let start = piece.offset.min(word_doc.len());
    let (text, bytes_per_char) = if piece.compressed {
      let bytes = &word_doc[start..][..count.min(available)];
      (ansi.decode_without_bom_handling(bytes).0.into_owned(), 1)
    } else {
      let bytes = &word_doc[start..][..(count * 2).min(available)];
      (decode_utf16le(bytes), 2)
    };
    segments.push(TextSegment {
      text,
      fc_start: start as u32,
      bytes_per_char,
    });
  }
  segments
}

fn decode_utf16le(bytes: &[u8]) -> String {
  let units: Vec<u16> = bytes
    .chunks_exact(2)
    .map(|c| u16::from_le_bytes([c[0], c[1]]))
    .collect();
  String::from_utf16_lossy(&units)
}

#[derive(Clone, Copy, Default, PartialEq, Eq)]
struct CharProps {
  bold: bool,
  italic: bool,
  strike: bool,
}

#[derive(Clone, Copy, Default)]
struct ParaProps {
  in_table: bool,
  row_end: bool,
  heading: Option<u8>,
}

struct FcRun<T> {
  fc_start: u32,
  fc_end: u32,
  props: T,
}

#[derive(Default)]
struct Formatting {
  char_runs: Vec<FcRun<CharProps>>,
  para_runs: Vec<FcRun<ParaProps>>,
}

impl Formatting {
  fn parse(word_doc: &[u8], table: &[u8], fib: &Fib) -> Self {
    Self {
      char_runs: parse_bin_table(
        word_doc,
        table,
        fib.fc_plcf_bte_chpx,
        fib.lcb_plcf_bte_chpx,
        parse_chpx_fkp,
      ),
      para_runs: parse_bin_table(
        word_doc,
        table,
        fib.fc_plcf_bte_papx,
        fib.lcb_plcf_bte_papx,
        parse_papx_fkp,
      ),
    }
  }
}

/// Walks a bin table: a PLC of page numbers of FKPs in the WordDocument
/// stream.
fn parse_bin_table<T>(
  word_doc: &[u8],
  table: &[u8],
  fc: usize,
  lcb: usize,
  parse_fkp: impl Fn(&[u8], &mut Vec<FcRun<T>>),
) -> Vec<FcRun<T>> {
  let mut runs = Vec::new();
  let Some(end) = fc.checked_add(lcb) else {
    return runs;
  };
  let Some(plc) = table.get(fc..end) else {
    return runs;
  };
  if lcb < 12 || (lcb - 4) % 8 != 0 {
    return runs;
  }
  let n = (lcb - 4) / 8;
  for k in 0..n {
    let pn = read_u32(plc, 4 * (n + 1) + 4 * k) as usize;
    let Some(page_start) = pn.checked_mul(FKP_PAGE_SIZE) else {
      continue;
    };
    if let Some(page) = word_doc.get(page_start..page_start + FKP_PAGE_SIZE) {
      parse_fkp(page, &mut runs);
    }
  }
  runs.sort_by_key(|run| run.fc_start);
  runs
}

fn parse_chpx_fkp(page: &[u8], runs: &mut Vec<FcRun<CharProps>>) {
  let crun = page[FKP_PAGE_SIZE - 1] as usize;
  if crun == 0 || 4 * (crun + 1) + crun >= FKP_PAGE_SIZE {
    return;
  }
  for i in 0..crun {
    let fc_start = read_u32(page, 4 * i);
    let fc_end = read_u32(page, 4 * (i + 1));
    if fc_end <= fc_start {
      continue;
    }
    // rgb entry: word offset of the Chpx within the page; 0 means default
    let rgb = page[4 * (crun + 1) + i] as usize;
    let mut props = CharProps::default();
    if rgb != 0 {
      let offset = rgb * 2;
      if let Some(&cb) = page.get(offset) {
        if let Some(grpprl) = page.get(offset + 1..offset + 1 + cb as usize) {
          props = char_props_from_grpprl(grpprl);
        }
      }
    }
    runs.push(FcRun {
      fc_start,
      fc_end,
      props,
    });
  }
}

fn parse_papx_fkp(page: &[u8], runs: &mut Vec<FcRun<ParaProps>>) {
  let cpara = page[FKP_PAGE_SIZE - 1] as usize;
  if cpara == 0 || 4 * (cpara + 1) + 13 * cpara >= FKP_PAGE_SIZE {
    return;
  }
  for i in 0..cpara {
    let fc_start = read_u32(page, 4 * i);
    let fc_end = read_u32(page, 4 * (i + 1));
    if fc_end <= fc_start {
      continue;
    }
    // BxPap: first byte is the word offset of the PapxInFkp; 0 means default
    let bx = page[4 * (cpara + 1) + 13 * i] as usize;
    let mut props = ParaProps::default();
    if bx != 0 {
      let offset = bx * 2;
      // PapxInFkp: grpprl length is cb*2 - 1, or cb2*2 when cb is 0
      if let Some(&cb) = page.get(offset) {
        let (start, len) = if cb == 0 {
          match page.get(offset + 1) {
            Some(&cb2) => (offset + 2, cb2 as usize * 2),
            None => (offset, 0),
          }
        } else {
          (offset + 1, (cb as usize) * 2 - 1)
        };
        if let Some(grpprl) = page.get(start..start + len) {
          props = para_props_from_grpprl(grpprl);
        }
      }
    }
    runs.push(FcRun {
      fc_start,
      fc_end,
      props,
    });
  }
}

fn char_props_from_grpprl(grpprl: &[u8]) -> CharProps {
  let mut props = CharProps::default();
  walk_sprms(grpprl, |sprm, operand| {
    // toggle operand: 1 = on, 0x81 = invert style (assume on)
    let on = matches!(operand.first(), Some(1) | Some(0x81));
    match sprm {
      0x0835 => props.bold = on,
      0x0836 => props.italic = on,
      0x0837 => props.strike = on,
      _ => {}
    }
  });
  props
}

fn para_props_from_grpprl(grpprl: &[u8]) -> ParaProps {
  let mut props = ParaProps::default();
  if grpprl.len() < 2 {
    return props;
  }
  props.heading = heading_from_istd(read_u16(grpprl, 0));
  walk_sprms(&grpprl[2..], |sprm, operand| match sprm {
    // sprmPFInTable, sprmPFTtp, sprmPOutLvl, sprmPIstd
    0x2416 => props.in_table = operand.first().is_some_and(|&v| v != 0),
    0x2417 => props.row_end = operand.first().is_some_and(|&v| v != 0),
    0x2640 => {
      if let Some(&level) = operand.first() {
        if level < 9 {
          props.heading = Some((level + 1).min(6));
        }
      }
    }
    0x4600 => {
      if operand.len() >= 2 {
        if let Some(level) = heading_from_istd(read_u16(operand, 0)) {
          props.heading = Some(level);
        }
      }
    }
    _ => {}
  });
  props
}

/// Built-in style indexes 1..=9 are "heading 1".."heading 9".
fn heading_from_istd(istd: u16) -> Option<u8> {
  if (1..=9).contains(&istd) {
    Some((istd as u8).min(6))
  } else {
    None
  }
}

/// Visits each sprm in a grpprl; operand size comes from the top 3 bits.
fn walk_sprms(grpprl: &[u8], mut visit: impl FnMut(u16, &[u8])) {
  let mut i = 0;
  while i + 2 <= grpprl.len() {
    let sprm = read_u16(grpprl, i);
    i += 2;
    let size = match sprm >> 13 {
      0 | 1 => 1,
      2 | 4 | 5 => 2,
      7 => 3,
      3 => 4,
      _ => {
        // variable size: length byte first (u16 + 1 for sprmTDefTable)
        if sprm == 0xD608 {
          if i + 2 > grpprl.len() {
            return;
          }
          read_u16(grpprl, i) as usize + 1
        } else {
          match grpprl.get(i) {
            Some(&cb) => cb as usize + 1,
            None => return,
          }
        }
      }
    };
    let Some(operand) = grpprl.get(i..i + size) else {
      return;
    };
    visit(sprm, operand);
    i += size;
  }
}

/// Props for the run containing `fc`, with a cursor for sequential lookups.
fn run_lookup<T: Copy + Default>(runs: &[FcRun<T>], fc: u32, cursor: &mut usize) -> T {
  if runs.is_empty() {
    return T::default();
  }
  if *cursor >= runs.len() || fc < runs[*cursor].fc_start {
    *cursor = runs.partition_point(|run| run.fc_end <= fc);
  } else {
    while *cursor < runs.len() && runs[*cursor].fc_end <= fc {
      *cursor += 1;
    }
  }
  match runs.get(*cursor) {
    Some(run) if fc >= run.fc_start && fc < run.fc_end => run.props,
    _ => T::default(),
  }
}

fn build_blocks(segments: &[TextSegment], formatting: &Formatting) -> Vec<Block> {
  let mut builder = BlockBuilder {
    formatting,
    blocks: Vec::new(),
    inlines: Vec::new(),
    run_text: String::new(),
    run_props: CharProps::default(),
    char_cursor: 0,
    para_cursor: 0,
    fields: Vec::new(),
    table_rows: Vec::new(),
    row_cells: Vec::new(),
    cell_blocks: Vec::new(),
  };

  for segment in segments {
    let mut fc = segment.fc_start;
    for ch in segment.text.chars() {
      builder.handle_char(ch, fc);
      fc = fc.saturating_add(match segment.bytes_per_char {
        1 => 1,
        _ => 2 * ch.len_utf16() as u32,
      });
    }
  }
  builder.finish()
}

struct FieldFrame {
  in_instruction: bool,
  instruction: String,
  result_inline_start: usize,
}

struct BlockBuilder<'a> {
  formatting: &'a Formatting,
  blocks: Vec<Block>,
  inlines: Vec<Inline>,
  run_text: String,
  run_props: CharProps,
  char_cursor: usize,
  para_cursor: usize,
  fields: Vec<FieldFrame>,
  table_rows: Vec<TableRow>,
  row_cells: Vec<TableCell>,
  cell_blocks: Vec<Block>,
}

impl BlockBuilder<'_> {
  fn handle_char(&mut self, ch: char, fc: u32) {
    match ch {
      '\u{13}' => {
        self.fields.push(FieldFrame {
          in_instruction: true,
          instruction: String::new(),
          result_inline_start: usize::MAX,
        });
        return;
      }
      '\u{14}' => {
        self.flush_run();
        let start = self.inlines.len();
        if let Some(frame) = self.fields.last_mut() {
          frame.in_instruction = false;
          frame.result_inline_start = start;
        }
        return;
      }
      '\u{15}' => {
        self.flush_run();
        if let Some(frame) = self.fields.pop() {
          self.close_field(frame);
        }
        return;
      }
      _ => {}
    }

    if let Some(frame) = self.fields.iter_mut().rev().find(|f| f.in_instruction) {
      if frame.instruction.len() < MAX_FIELD_INSTRUCTION_CHARS {
        frame.instruction.push(ch);
      }
      return;
    }

    match ch {
      '\r' | '\n' | '\u{c}' | '\u{e}' => {
        let props = self.para_props(fc);
        self.end_paragraph(props);
      }
      '\u{7}' => {
        let props = self.para_props(fc);
        if props.row_end {
          self.end_row();
        } else if props.in_table {
          self.end_cell(props);
        } else {
          // no table context: behave like a paragraph mark
          self.end_paragraph(props);
        }
      }
      '\u{b}' => {
        self.flush_run();
        if !self.inlines.is_empty() {
          self.inlines.push(Inline::LineBreak);
        }
      }
      '\t' => self.push_char('\t', fc),
      '\u{1e}' => self.push_char('-', fc),
      c if c.is_control() || c == '\u{1f}' => {}
      c => self.push_char(c, fc),
    }
  }

  fn push_char(&mut self, ch: char, fc: u32) {
    let props = run_lookup(&self.formatting.char_runs, fc, &mut self.char_cursor);
    if props != self.run_props {
      self.flush_run();
      self.run_props = props;
    }
    self.run_text.push(ch);
  }

  fn para_props(&mut self, fc: u32) -> ParaProps {
    run_lookup(&self.formatting.para_runs, fc, &mut self.para_cursor)
  }

  fn flush_run(&mut self) {
    if self.run_text.is_empty() {
      return;
    }
    let mut node = Inline::Text(std::mem::take(&mut self.run_text));
    if self.run_props.strike {
      node = Inline::Del(vec![node]);
    }
    if self.run_props.italic {
      node = Inline::Em(vec![node]);
    }
    if self.run_props.bold {
      node = Inline::Strong(vec![node]);
    }
    self.inlines.push(node);
  }

  fn close_field(&mut self, frame: FieldFrame) {
    let Some(href) = hyperlink_target(&frame.instruction) else {
      return;
    };
    let start = frame.result_inline_start.min(self.inlines.len());
    let children = self.inlines.split_off(start);
    if has_visible_content(&children) {
      self.inlines.push(Inline::Link { href, children });
    } else {
      self.inlines.extend(children);
    }
  }

  /// Takes the pending inlines as a paragraph, or `None` when nothing
  /// visible accumulated.
  fn take_paragraph(&mut self, props: ParaProps) -> Option<Block> {
    self.flush_run();
    // links cannot span paragraphs
    for frame in &mut self.fields {
      frame.result_inline_start = 0;
    }
    while matches!(self.inlines.last(), Some(Inline::LineBreak)) {
      self.inlines.pop();
    }
    if !has_visible_content(&self.inlines) {
      self.inlines.clear();
      return None;
    }
    if let Some(Inline::Text(first)) = self.inlines.first_mut() {
      *first = first.trim_start().to_string();
    }
    if let Some(Inline::Text(last)) = self.inlines.last_mut() {
      *last = last.trim_end().to_string();
    }
    let kind = match props.heading {
      Some(level) => ParagraphKind::Heading(level),
      None => ParagraphKind::Normal,
    };
    Some(Block::Paragraph(Paragraph {
      kind,
      inlines: std::mem::take(&mut self.inlines),
    }))
  }

  fn end_paragraph(&mut self, props: ParaProps) {
    let paragraph = self.take_paragraph(props);
    if props.in_table {
      if let Some(paragraph) = paragraph {
        self.cell_blocks.push(paragraph);
      }
    } else {
      self.flush_table();
      if let Some(paragraph) = paragraph {
        self.blocks.push(paragraph);
      }
    }
  }

  fn end_cell(&mut self, props: ParaProps) {
    if let Some(paragraph) = self.take_paragraph(props) {
      self.cell_blocks.push(paragraph);
    }
    self.row_cells.push(TableCell {
      blocks: std::mem::take(&mut self.cell_blocks),
      colspan: NonZeroU32::MIN,
      rowspan: NonZeroU32::MIN,
    });
  }

  /// Row terminator: the TTP mark's own paragraph carries no cell content.
  fn end_row(&mut self) {
    self.flush_run();
    self.inlines.clear();
    if !self.cell_blocks.is_empty() {
      self.row_cells.push(TableCell {
        blocks: std::mem::take(&mut self.cell_blocks),
        colspan: NonZeroU32::MIN,
        rowspan: NonZeroU32::MIN,
      });
    }
    if !self.row_cells.is_empty() {
      self.table_rows.push(TableRow {
        cells: std::mem::take(&mut self.row_cells),
        kind: TableRowKind::Body,
      });
    }
  }

  fn flush_table(&mut self) {
    if !self.cell_blocks.is_empty() || !self.row_cells.is_empty() {
      self.end_row();
    }
    if !self.table_rows.is_empty() {
      self.blocks.push(Block::Table(Table {
        rows: std::mem::take(&mut self.table_rows),
      }));
    }
  }

  fn finish(mut self) -> Vec<Block> {
    self.end_paragraph(ParaProps::default());
    self.flush_table();
    self.blocks
  }
}

/// Target of a HYPERLINK field instruction.
fn hyperlink_target(instruction: &str) -> Option<String> {
  let rest = instruction.trim_start();
  if !rest
    .get(..9)
    .is_some_and(|p| p.eq_ignore_ascii_case("HYPERLINK"))
  {
    return None;
  }
  let mut tokens = field_tokens(&rest[9..]);
  let mut anchor = false;
  while let Some(token) = tokens.next() {
    match token.as_str() {
      "\\l" => anchor = true,
      // switches whose argument is not the target
      "\\o" | "\\t" => {
        tokens.next();
      }
      t if t.starts_with('\\') => {}
      t => {
        return Some(if anchor {
          format!("#{t}")
        } else {
          t.to_string()
        });
      }
    }
  }
  None
}

/// Whitespace-separated tokens; quoted strings stay together, unquoted.
fn field_tokens(input: &str) -> impl Iterator<Item = String> + '_ {
  let mut chars = input.chars().peekable();
  std::iter::from_fn(move || {
    while chars.peek().is_some_and(|c| c.is_whitespace()) {
      chars.next();
    }
    match chars.peek() {
      None => None,
      Some('"') => {
        chars.next();
        let mut token = String::new();
        for c in chars.by_ref() {
          if c == '"' {
            break;
          }
          token.push(c);
        }
        Some(token)
      }
      Some(_) => {
        let mut token = String::new();
        while let Some(&c) = chars.peek() {
          if c.is_whitespace() {
            break;
          }
          token.push(c);
          chars.next();
        }
        Some(token)
      }
    }
  })
}

fn read_u16(data: &[u8], offset: usize) -> u16 {
  u16::from_le_bytes([data[offset], data[offset + 1]])
}

fn read_u32(data: &[u8], offset: usize) -> u32 {
  u32::from_le_bytes([
    data[offset],
    data[offset + 1],
    data[offset + 2],
    data[offset + 3],
  ])
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::io::Write;

  enum TestPiece {
    Compressed(Vec<u8>),
    Unicode(&'static str),
  }

  /// Contiguous formatting runs: (fc_start, fc_end, grpprl). An empty grpprl
  /// becomes a default (offset 0) FKP entry.
  #[derive(Default)]
  struct TestFmt {
    char_runs: Vec<(u32, u32, Vec<u8>)>,
    para_runs: Vec<(u32, u32, Vec<u8>)>,
  }

  fn utf16_bytes(text: &str) -> Vec<u8> {
    text.encode_utf16().flat_map(u16::to_le_bytes).collect()
  }

  const TEXT_START: usize = 0x200;

  /// FC of the i-th UTF-16 unit of a single Unicode test piece.
  fn ufc(i: usize) -> u32 {
    (TEXT_START + 2 * i) as u32
  }

  fn sprm1(code: u16, value: u8) -> Vec<u8> {
    let mut out = code.to_le_bytes().to_vec();
    out.push(value);
    out
  }

  fn papx(istd: u16, sprms: &[Vec<u8>]) -> Vec<u8> {
    let mut out = istd.to_le_bytes().to_vec();
    for sprm in sprms {
      out.extend_from_slice(sprm);
    }
    out
  }

  fn build_chpx_fkp(runs: &[(u32, u32, Vec<u8>)]) -> Vec<u8> {
    let mut page = vec![0u8; FKP_PAGE_SIZE];
    let crun = runs.len();
    for (i, (fc_start, fc_end, _)) in runs.iter().enumerate() {
      page[4 * i..4 * i + 4].copy_from_slice(&fc_start.to_le_bytes());
      page[4 * (i + 1)..4 * (i + 1) + 4].copy_from_slice(&fc_end.to_le_bytes());
    }
    let mut blob_end = FKP_PAGE_SIZE - 1;
    for (i, (_, _, grpprl)) in runs.iter().enumerate() {
      if grpprl.is_empty() {
        continue;
      }
      let blob_len = 1 + grpprl.len();
      let mut pos = blob_end - blob_len;
      pos &= !1;
      page[pos] = grpprl.len() as u8;
      page[pos + 1..pos + 1 + grpprl.len()].copy_from_slice(grpprl);
      page[4 * (crun + 1) + i] = (pos / 2) as u8;
      blob_end = pos;
    }
    page[FKP_PAGE_SIZE - 1] = crun as u8;
    page
  }

  fn build_papx_fkp(runs: &[(u32, u32, Vec<u8>)]) -> Vec<u8> {
    let mut page = vec![0u8; FKP_PAGE_SIZE];
    let cpara = runs.len();
    for (i, (fc_start, fc_end, _)) in runs.iter().enumerate() {
      page[4 * i..4 * i + 4].copy_from_slice(&fc_start.to_le_bytes());
      page[4 * (i + 1)..4 * (i + 1) + 4].copy_from_slice(&fc_end.to_le_bytes());
    }
    let mut blob_end = FKP_PAGE_SIZE - 1;
    for (i, (_, _, grpprl)) in runs.iter().enumerate() {
      if grpprl.is_empty() {
        continue;
      }
      let blob = if grpprl.len() % 2 == 1 {
        let mut b = vec![((grpprl.len() + 1) / 2) as u8];
        b.extend_from_slice(grpprl);
        b
      } else {
        let mut b = vec![0, (grpprl.len() / 2) as u8];
        b.extend_from_slice(grpprl);
        b
      };
      let mut pos = blob_end - blob.len();
      pos &= !1;
      page[pos..pos + blob.len()].copy_from_slice(&blob);
      page[4 * (cpara + 1) + 13 * i] = (pos / 2) as u8;
      blob_end = pos;
    }
    page[FKP_PAGE_SIZE - 1] = cpara as u8;
    page
  }

  fn build_word_doc_streams(pieces: &[TestPiece], lid: u16) -> (Vec<u8>, Vec<u8>) {
    build_word_doc_streams_fmt(pieces, lid, &TestFmt::default())
  }

  fn build_word_doc_streams_fmt(
    pieces: &[TestPiece],
    lid: u16,
    fmt: &TestFmt,
  ) -> (Vec<u8>, Vec<u8>) {
    let mut word_doc = vec![0u8; TEXT_START];
    let mut cps = vec![0u32];
    let mut pcds = Vec::new();

    for piece in pieces {
      let offset = word_doc.len();
      let (count, fc) = match piece {
        TestPiece::Compressed(bytes) => {
          word_doc.extend_from_slice(bytes);
          (bytes.len() as u32, (offset as u32 * 2) | 0x4000_0000)
        }
        TestPiece::Unicode(text) => {
          let bytes = utf16_bytes(text);
          word_doc.extend_from_slice(&bytes);
          (text.encode_utf16().count() as u32, offset as u32)
        }
      };
      cps.push(cps.last().unwrap() + count);
      pcds.push(fc);
    }

    let ccp_text = *cps.last().unwrap();
    let mut plc = Vec::new();
    for cp in &cps {
      plc.extend_from_slice(&cp.to_le_bytes());
    }
    for fc in &pcds {
      plc.extend_from_slice(&0u16.to_le_bytes());
      plc.extend_from_slice(&fc.to_le_bytes());
      plc.extend_from_slice(&0u16.to_le_bytes());
    }
    let mut table = vec![0x02];
    table.extend_from_slice(&(plc.len() as u32).to_le_bytes());
    table.extend_from_slice(&plc);
    let lcb_clx = table.len() as u32;

    let append_fkp =
      |word_doc: &mut Vec<u8>, table: &mut Vec<u8>, page: Vec<u8>, runs: &[(u32, u32, Vec<u8>)]| {
        while word_doc.len() % FKP_PAGE_SIZE != 0 {
          word_doc.push(0);
        }
        let pn = (word_doc.len() / FKP_PAGE_SIZE) as u32;
        word_doc.extend_from_slice(&page);
        let bin_table_offset = table.len() as u32;
        table.extend_from_slice(&runs[0].0.to_le_bytes());
        table.extend_from_slice(&runs.last().unwrap().1.to_le_bytes());
        table.extend_from_slice(&pn.to_le_bytes());
        (bin_table_offset, 12u32)
      };

    let chpx_bt = (!fmt.char_runs.is_empty()).then(|| {
      let page = build_chpx_fkp(&fmt.char_runs);
      append_fkp(&mut word_doc, &mut table, page, &fmt.char_runs)
    });
    let papx_bt = (!fmt.para_runs.is_empty()).then(|| {
      let page = build_papx_fkp(&fmt.para_runs);
      append_fkp(&mut word_doc, &mut table, page, &fmt.para_runs)
    });

    word_doc[0x00..0x02].copy_from_slice(&MAGIC_WORD_97.to_le_bytes());
    word_doc[0x02..0x04].copy_from_slice(&0x00C1u16.to_le_bytes());
    word_doc[0x06..0x08].copy_from_slice(&lid.to_le_bytes());
    word_doc[0x0A..0x0C].copy_from_slice(&0x0200u16.to_le_bytes());
    word_doc[0x4C..0x50].copy_from_slice(&ccp_text.to_le_bytes());
    word_doc[0x1A2..0x1A6].copy_from_slice(&0u32.to_le_bytes());
    word_doc[0x1A6..0x1AA].copy_from_slice(&lcb_clx.to_le_bytes());
    if let Some((fc, lcb)) = chpx_bt {
      word_doc[0xFA..0xFE].copy_from_slice(&fc.to_le_bytes());
      word_doc[0xFE..0x102].copy_from_slice(&lcb.to_le_bytes());
    }
    if let Some((fc, lcb)) = papx_bt {
      word_doc[0x102..0x106].copy_from_slice(&fc.to_le_bytes());
      word_doc[0x106..0x10A].copy_from_slice(&lcb.to_le_bytes());
    }

    (word_doc, table)
  }

  fn build_cfb(streams: &[(&str, &[u8])]) -> Vec<u8> {
    let mut comp = CompoundFile::create(Cursor::new(Vec::new())).unwrap();
    for (name, data) in streams {
      let mut stream = comp.create_stream(name).unwrap();
      stream.write_all(data).unwrap();
    }
    comp.into_inner().into_inner()
  }

  fn build_doc(pieces: &[TestPiece], lid: u16, summary: Option<&[u8]>) -> Vec<u8> {
    build_doc_fmt(pieces, lid, summary, &TestFmt::default())
  }

  fn build_doc_fmt(
    pieces: &[TestPiece],
    lid: u16,
    summary: Option<&[u8]>,
    fmt: &TestFmt,
  ) -> Vec<u8> {
    let (word_doc, table) = build_word_doc_streams_fmt(pieces, lid, fmt);
    let mut streams: Vec<(&str, &[u8])> = vec![("WordDocument", &word_doc), ("1Table", &table)];
    if let Some(summary) = summary {
      streams.push(("\x05SummaryInformation", summary));
    }
    build_cfb(&streams)
  }

  fn build_summary_information(codepage: u16, title: &[u8], author: &[u8]) -> Vec<u8> {
    let mut props: Vec<(u32, Vec<u8>)> = Vec::new();
    let mut codepage_value = 0x0002u32.to_le_bytes().to_vec();
    codepage_value.extend_from_slice(&(codepage as u32).to_le_bytes());
    props.push((0x0001, codepage_value));
    for (pid, text) in [(0x0002u32, title), (0x0004u32, author)] {
      let mut value = 0x001Eu32.to_le_bytes().to_vec();
      value.extend_from_slice(&((text.len() + 1) as u32).to_le_bytes());
      value.extend_from_slice(text);
      value.push(0);
      props.push((pid, value));
    }

    let section_start = 0x30usize;
    let header_size = 8 + props.len() * 8;
    let mut entries = Vec::new();
    let mut values = Vec::new();
    for (pid, value) in &props {
      entries.extend_from_slice(&pid.to_le_bytes());
      entries.extend_from_slice(&((header_size + values.len()) as u32).to_le_bytes());
      values.extend_from_slice(value);
      while values.len() % 4 != 0 {
        values.push(0);
      }
    }

    let mut data = vec![0u8; section_start];
    data[0x00..0x02].copy_from_slice(&0xFFFEu16.to_le_bytes());
    data[0x18..0x1C].copy_from_slice(&1u32.to_le_bytes());
    data[0x2C..0x30].copy_from_slice(&(section_start as u32).to_le_bytes());
    data.extend_from_slice(&((header_size + values.len()) as u32).to_le_bytes());
    data.extend_from_slice(&(props.len() as u32).to_le_bytes());
    data.extend_from_slice(&entries);
    data.extend_from_slice(&values);
    data
  }

  /// Readable markup for inline assertions, e.g. `a <b>x</b> <a href=u>y</a>`.
  fn inline_markup(inlines: &[Inline]) -> String {
    inlines
      .iter()
      .map(|inline| match inline {
        Inline::Text(t) => t.clone(),
        Inline::LineBreak => "\n".to_string(),
        Inline::Strong(c) => format!("<b>{}</b>", inline_markup(c)),
        Inline::Em(c) => format!("<i>{}</i>", inline_markup(c)),
        Inline::Del(c) => format!("<del>{}</del>", inline_markup(c)),
        Inline::Link { href, children } => {
          format!("<a href={}>{}</a>", href, inline_markup(children))
        }
        _ => String::new(),
      })
      .collect()
  }

  fn inline_text(inlines: &[Inline]) -> String {
    inlines
      .iter()
      .map(|inline| match inline {
        Inline::Text(t) => t.clone(),
        Inline::LineBreak => "\n".to_string(),
        Inline::Link { children, .. } => inline_text(children),
        Inline::Strong(c) | Inline::Em(c) | Inline::Del(c) | Inline::Sup(c) | Inline::Sub(c) => {
          inline_text(c)
        }
        _ => String::new(),
      })
      .collect()
  }

  fn paragraph_texts(document: &Document) -> Vec<String> {
    document
      .blocks
      .iter()
      .map(|block| match block {
        Block::Paragraph(p) => inline_text(&p.inlines),
        _ => String::new(),
      })
      .collect()
  }

  fn parse(data: &[u8]) -> Document {
    DocProvider::new().parse_buffer(data).unwrap()
  }

  fn cp1251(text: &str) -> Vec<u8> {
    encoding_rs::WINDOWS_1251.encode(text).0.into_owned()
  }

  #[test]
  fn unicode_pieces() {
    let data = build_doc(
      &[TestPiece::Unicode("Указ Президента України\rДодаток\r")],
      0x0409,
      None,
    );
    assert_eq!(
      paragraph_texts(&parse(&data)),
      vec!["Указ Президента України", "Додаток"]
    );
  }

  #[test]
  fn compressed_cp1251_via_summary_codepage() {
    let summary = build_summary_information(1251, &cp1251("Указ"), &cp1251("Автор"));
    let data = build_doc(
      &[TestPiece::Compressed(cp1251("ПРЕЗИДЕНТ УКРАЇНИ\r"))],
      0x0409,
      Some(&summary),
    );
    let document = parse(&data);
    assert_eq!(paragraph_texts(&document), vec!["ПРЕЗИДЕНТ УКРАЇНИ"]);
    assert_eq!(document.metadata.title.as_deref(), Some("Указ"));
    assert_eq!(document.metadata.author.as_deref(), Some("Автор"));
  }

  #[test]
  fn compressed_cp1251_via_lid() {
    let data = build_doc(
      &[TestPiece::Compressed(cp1251("Слава Україні\r"))],
      0x0422,
      None,
    );
    assert_eq!(paragraph_texts(&parse(&data)), vec!["Слава Україні"]);
  }

  #[test]
  fn compressed_defaults_to_cp1252() {
    let data = build_doc(
      &[TestPiece::Compressed(b"Caf\xE9 \x93quoted\x94\r".to_vec())],
      0x0409,
      None,
    );
    assert_eq!(
      paragraph_texts(&parse(&data)),
      vec!["Café \u{201C}quoted\u{201D}"]
    );
  }

  #[test]
  fn mixed_pieces_concatenate_in_cp_order() {
    let data = build_doc(
      &[
        TestPiece::Unicode("Перша частина "),
        TestPiece::Compressed(b"and ASCII tail\r".to_vec()),
      ],
      0x0419,
      None,
    );
    assert_eq!(
      paragraph_texts(&parse(&data)),
      vec!["Перша частина and ASCII tail"]
    );
  }

  #[test]
  fn field_instructions_are_stripped() {
    let data = build_doc(
      &[TestPiece::Unicode(
        "See \u{13} HYPERLINK \"https://example.com\" \u{14}the site\u{15} now\r",
      )],
      0x0409,
      None,
    );
    assert_eq!(paragraph_texts(&parse(&data)), vec!["See the site now"]);
  }

  #[test]
  fn hyperlink_fields_become_links() {
    let data = build_doc(
      &[TestPiece::Unicode(
        "See \u{13} HYPERLINK \"https://example.com\" \u{14}the site\u{15} now\r",
      )],
      0x0409,
      None,
    );
    let document = parse(&data);
    let Block::Paragraph(p) = &document.blocks[0] else {
      panic!("expected paragraph");
    };
    assert_eq!(
      inline_markup(&p.inlines),
      "See <a href=https://example.com>the site</a> now"
    );
  }

  #[test]
  fn anchor_hyperlink_targets_bookmark() {
    let data = build_doc(
      &[TestPiece::Unicode(
        "Go \u{13} HYPERLINK \\l \"section1\" \u{14}there\u{15}\r",
      )],
      0x0409,
      None,
    );
    let document = parse(&data);
    let Block::Paragraph(p) = &document.blocks[0] else {
      panic!("expected paragraph");
    };
    assert_eq!(inline_markup(&p.inlines), "Go <a href=#section1>there</a>");
  }

  #[test]
  fn non_hyperlink_fields_keep_result_text_only() {
    let data = build_doc(
      &[TestPiece::Unicode("Page \u{13} PAGE \u{14}7\u{15} of 9\r")],
      0x0409,
      None,
    );
    let document = parse(&data);
    let Block::Paragraph(p) = &document.blocks[0] else {
      panic!("expected paragraph");
    };
    assert_eq!(inline_markup(&p.inlines), "Page 7 of 9");
  }

  #[test]
  fn cell_marks_and_line_breaks() {
    let data = build_doc(
      &[TestPiece::Unicode(
        "cell one\u{7}cell two\u{7}line\u{b}break\r",
      )],
      0x0409,
      None,
    );
    assert_eq!(
      paragraph_texts(&parse(&data)),
      vec!["cell one", "cell two", "line\nbreak"]
    );
  }

  #[test]
  fn bold_italic_strike_runs() {
    let text = "plain bold and style\r";
    let fmt = TestFmt {
      char_runs: vec![
        (ufc(0), ufc(6), vec![]),
        (ufc(6), ufc(10), sprm1(0x0835, 1)),
        (ufc(10), ufc(15), vec![]),
        (
          ufc(15),
          ufc(20),
          [sprm1(0x0836, 1), sprm1(0x0837, 1)].concat(),
        ),
        (ufc(20), ufc(21), vec![]),
      ],
      ..TestFmt::default()
    };
    let data = build_doc_fmt(&[TestPiece::Unicode(text)], 0x0409, None, &fmt);
    let document = parse(&data);
    let Block::Paragraph(p) = &document.blocks[0] else {
      panic!("expected paragraph");
    };
    assert_eq!(
      inline_markup(&p.inlines),
      "plain <b>bold</b> and <i><del>style</del></i>"
    );
  }

  #[test]
  fn headings_from_istd_and_outline_level() {
    let text = "Title\rSection\rBody\r";
    let fmt = TestFmt {
      para_runs: vec![
        (ufc(0), ufc(6), papx(1, &[])),
        (ufc(6), ufc(14), papx(0, &[sprm1(0x2640, 1)])),
        (ufc(14), ufc(19), papx(0, &[])),
      ],
      ..TestFmt::default()
    };
    let data = build_doc_fmt(&[TestPiece::Unicode(text)], 0x0409, None, &fmt);
    let document = parse(&data);
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
        ParagraphKind::Normal
      ]
    );
  }

  #[test]
  fn table_from_cell_and_row_marks() {
    let text = "A1\u{7}B1\u{7}\u{7}A2\u{7}B2\u{7}\u{7}after\r";
    let in_table = papx(0, &[sprm1(0x2416, 1)]);
    let row_end = papx(0, &[sprm1(0x2416, 1), sprm1(0x2417, 1)]);
    let fmt = TestFmt {
      para_runs: vec![
        (ufc(0), ufc(3), in_table.clone()),
        (ufc(3), ufc(6), in_table.clone()),
        (ufc(6), ufc(7), row_end.clone()),
        (ufc(7), ufc(10), in_table.clone()),
        (ufc(10), ufc(13), in_table),
        (ufc(13), ufc(14), row_end),
        (ufc(14), ufc(20), papx(0, &[])),
      ],
      ..TestFmt::default()
    };
    let data = build_doc_fmt(&[TestPiece::Unicode(text)], 0x0409, None, &fmt);
    let document = parse(&data);

    let Block::Table(table) = &document.blocks[0] else {
      panic!("expected table, got {:?}", document.blocks[0]);
    };
    let cells: Vec<Vec<String>> = table
      .rows
      .iter()
      .map(|row| {
        row
          .cells
          .iter()
          .map(|cell| {
            cell
              .blocks
              .iter()
              .map(|b| match b {
                Block::Paragraph(p) => inline_text(&p.inlines),
                _ => String::new(),
              })
              .collect::<String>()
          })
          .collect()
      })
      .collect();
    assert_eq!(cells, vec![vec!["A1", "B1"], vec!["A2", "B2"]]);
    assert_eq!(paragraph_texts(&parse(&data)).last().unwrap(), "after");
  }

  #[test]
  fn legacy_word_95_contiguous_text() {
    let text_bytes = cp1251("Стаття перша.\rСтаття друга.\r");
    let fc_min = 0x200usize;
    let mut word_doc = vec![0u8; fc_min];
    word_doc.extend_from_slice(&text_bytes);
    word_doc[0x00..0x02].copy_from_slice(&MAGIC_WORD_6_95.to_le_bytes());
    word_doc[0x06..0x08].copy_from_slice(&0x0419u16.to_le_bytes());
    word_doc[0x18..0x1C].copy_from_slice(&(fc_min as u32).to_le_bytes());
    word_doc[0x1C..0x20].copy_from_slice(&((fc_min + text_bytes.len()) as u32).to_le_bytes());
    let data = build_cfb(&[("WordDocument", &word_doc)]);
    assert_eq!(
      paragraph_texts(&parse(&data)),
      vec!["Стаття перша.", "Стаття друга."]
    );
  }

  #[test]
  fn malformed_piece_table_output_is_capped() {
    // 200 pieces of 100k chars all mapped to the same 100k file bytes; the
    // claimed 20M chars must clamp to MAX_TEXT_CHARS
    let text_len = 100_000u32;
    let num_pieces = 200u32;
    let mut word_doc = vec![0u8; TEXT_START];
    word_doc.extend_from_slice(&vec![b'A'; text_len as usize]);

    let mut plc = Vec::new();
    for k in 0..=num_pieces {
      plc.extend_from_slice(&(k * text_len).to_le_bytes());
    }
    let fc = (TEXT_START as u32 * 2) | 0x4000_0000;
    for _ in 0..num_pieces {
      plc.extend_from_slice(&0u16.to_le_bytes());
      plc.extend_from_slice(&fc.to_le_bytes());
      plc.extend_from_slice(&0u16.to_le_bytes());
    }
    let mut table = vec![0x02];
    table.extend_from_slice(&(plc.len() as u32).to_le_bytes());
    table.extend_from_slice(&plc);

    word_doc[0x00..0x02].copy_from_slice(&MAGIC_WORD_97.to_le_bytes());
    word_doc[0x0A..0x0C].copy_from_slice(&0x0200u16.to_le_bytes());
    word_doc[0x4C..0x50].copy_from_slice(&(num_pieces * text_len).to_le_bytes());
    word_doc[0x1A6..0x1AA].copy_from_slice(&(table.len() as u32).to_le_bytes());

    let data = build_cfb(&[("WordDocument", &word_doc), ("1Table", &table)]);
    let total: usize = paragraph_texts(&parse(&data)).iter().map(|t| t.len()).sum();
    assert!(total > 0);
    assert!(total <= MAX_TEXT_CHARS);
  }

  #[test]
  fn encrypted_documents_error() {
    let (mut word_doc, table) = build_word_doc_streams(&[TestPiece::Unicode("secret\r")], 0x0409);
    word_doc[0x0A..0x0C].copy_from_slice(&0x0300u16.to_le_bytes());
    let data = build_cfb(&[("WordDocument", &word_doc), ("1Table", &table)]);
    let err = DocProvider::new().parse_buffer(&data).unwrap_err();
    assert!(err.to_string().contains("encrypted"));
  }

  #[test]
  fn corrupt_piece_table_falls_back_to_fc_range() {
    let (mut word_doc, _) =
      build_word_doc_streams(&[TestPiece::Unicode("good text here\r")], 0x0409);
    word_doc[0x0A..0x0C].copy_from_slice(&0x1200u16.to_le_bytes());
    let fc_mac = word_doc.len() as u32;
    word_doc[0x18..0x1C].copy_from_slice(&(TEXT_START as u32).to_le_bytes());
    word_doc[0x1C..0x20].copy_from_slice(&fc_mac.to_le_bytes());
    let garbage_table = vec![0xFFu8; 64];
    let data = build_cfb(&[("WordDocument", &word_doc), ("1Table", &garbage_table)]);
    assert_eq!(paragraph_texts(&parse(&data)), vec!["good text here"]);
  }
}
