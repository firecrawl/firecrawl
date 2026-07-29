//! Legacy Word binary (.doc) provider, following the MS-DOC piece table
//! format.

use crate::document::encoding::{encoding_for_codepage, encoding_for_lid};
use crate::document::model::*;
use crate::document::oleps::parse_summary_information;
use crate::document::providers::DocumentProvider;
use cfb::CompoundFile;
use encoding_rs::Encoding;
use std::error::Error;
use std::io::{Cursor, Read, Seek};

const MAGIC_WORD_97: u16 = 0xA5EC;
const MAGIC_WORD_6_95: u16 = 0xA5DC;

/// Caps text extraction so a malformed piece table cannot force
/// multi-gigabyte output from a small file.
const MAX_TEXT_CHARS: usize = 10_000_000;

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

    let text = extract_text(&word_doc, table.as_deref(), &fib, ansi);

    let mut metadata = DocumentMetadata::default();
    if let Some(summary) = summary {
      metadata.title = summary.title;
      metadata.author = summary.author;
      metadata.created = summary.created;
    }

    Ok(Document {
      blocks: text_to_blocks(&text),
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

    Ok(Fib {
      legacy,
      lid: read_u16(word_doc, 0x06),
      table_stream_1: flags & 0x0200 != 0,
      ext_char: flags & 0x1000 != 0,
      fc_min: read_u32(word_doc, 0x18) as usize,
      fc_mac: read_u32(word_doc, 0x1C) as usize,
      ccp_text: if word_doc.len() >= 0x50 {
        read_u32(word_doc, 0x4C) as usize
      } else {
        0
      },
      fc_clx: if word_doc.len() >= 0x1AA {
        read_u32(word_doc, 0x1A2) as usize
      } else {
        0
      },
      lcb_clx: if word_doc.len() >= 0x1AA {
        read_u32(word_doc, 0x1A6) as usize
      } else {
        0
      },
    })
  }
}

fn extract_text(
  word_doc: &[u8],
  table: Option<&[u8]>,
  fib: &Fib,
  ansi: &'static Encoding,
) -> String {
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
  if fib.ext_char {
    decode_utf16le(bytes)
  } else {
    ansi.decode_without_bom_handling(bytes).0.into_owned()
  }
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
) -> String {
  // piece CP ranges are contiguous and ascending, so clamping ccpText bounds
  // the total output no matter how many pieces the table declares
  let ccp_text = ccp_text.min(MAX_TEXT_CHARS);
  let mut out = String::new();
  for piece in pieces {
    // main document body only; headers, footnotes etc. live past ccpText
    if piece.start_cp as usize >= ccp_text {
      continue;
    }
    let count = (piece.end_cp as usize).min(ccp_text) - piece.start_cp as usize;
    let available = word_doc.len().saturating_sub(piece.offset);
    if piece.compressed {
      let bytes = &word_doc[piece.offset.min(word_doc.len())..][..count.min(available)];
      out.push_str(&ansi.decode_without_bom_handling(bytes).0);
    } else {
      let bytes = &word_doc[piece.offset.min(word_doc.len())..][..(count * 2).min(available)];
      out.push_str(&decode_utf16le(bytes));
    }
  }
  out
}

fn decode_utf16le(bytes: &[u8]) -> String {
  let units: Vec<u16> = bytes
    .chunks_exact(2)
    .map(|c| u16::from_le_bytes([c[0], c[1]]))
    .collect();
  String::from_utf16_lossy(&units)
}

fn text_to_blocks(text: &str) -> Vec<Block> {
  let mut blocks = Vec::new();
  let mut inlines: Vec<Inline> = Vec::new();
  let mut buf = String::new();
  // per-field flag: true while inside the instruction part (before 0x14)
  let mut field_stack: Vec<bool> = Vec::new();

  fn flush_text(buf: &mut String, inlines: &mut Vec<Inline>) {
    if !buf.is_empty() {
      inlines.push(Inline::Text(std::mem::take(buf)));
    }
  }

  fn flush_paragraph(buf: &mut String, inlines: &mut Vec<Inline>, blocks: &mut Vec<Block>) {
    flush_text(buf, inlines);
    while matches!(inlines.last(), Some(Inline::LineBreak)) {
      inlines.pop();
    }
    if has_visible_content(inlines) {
      if let Some(Inline::Text(first)) = inlines.first_mut() {
        *first = first.trim_start().to_string();
      }
      if let Some(Inline::Text(last)) = inlines.last_mut() {
        *last = last.trim_end().to_string();
      }
      blocks.push(Block::Paragraph(Paragraph {
        kind: ParagraphKind::Normal,
        inlines: std::mem::take(inlines),
      }));
    } else {
      inlines.clear();
    }
  }

  for ch in text.chars() {
    match ch {
      '\u{13}' => {
        field_stack.push(true);
        continue;
      }
      '\u{14}' => {
        if let Some(top) = field_stack.last_mut() {
          *top = false;
        }
        continue;
      }
      '\u{15}' => {
        field_stack.pop();
        continue;
      }
      _ => {}
    }
    if field_stack.iter().any(|&in_instruction| in_instruction) {
      continue;
    }
    match ch {
      // paragraph mark, cell/row mark, page break, column break
      '\r' | '\n' | '\u{7}' | '\u{c}' | '\u{e}' => {
        flush_paragraph(&mut buf, &mut inlines, &mut blocks)
      }
      '\u{b}' => {
        flush_text(&mut buf, &mut inlines);
        if !inlines.is_empty() {
          inlines.push(Inline::LineBreak);
        }
      }
      '\t' => buf.push('\t'),
      '\u{1e}' => buf.push('-'),
      c if c.is_control() || c == '\u{1f}' => {}
      c => buf.push(c),
    }
  }
  flush_paragraph(&mut buf, &mut inlines, &mut blocks);

  blocks
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

  fn utf16_bytes(text: &str) -> Vec<u8> {
    text.encode_utf16().flat_map(u16::to_le_bytes).collect()
  }

  const TEXT_START: usize = 0x200;

  fn build_word_doc_streams(pieces: &[TestPiece], lid: u16) -> (Vec<u8>, Vec<u8>) {
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

    word_doc[0x00..0x02].copy_from_slice(&MAGIC_WORD_97.to_le_bytes());
    word_doc[0x02..0x04].copy_from_slice(&0x00C1u16.to_le_bytes());
    word_doc[0x06..0x08].copy_from_slice(&lid.to_le_bytes());
    word_doc[0x0A..0x0C].copy_from_slice(&0x0200u16.to_le_bytes());
    word_doc[0x4C..0x50].copy_from_slice(&ccp_text.to_le_bytes());
    word_doc[0x1A2..0x1A6].copy_from_slice(&0u32.to_le_bytes());
    word_doc[0x1A6..0x1AA].copy_from_slice(&(table.len() as u32).to_le_bytes());

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
    let (word_doc, table) = build_word_doc_streams(pieces, lid);
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

  fn paragraph_texts(document: &Document) -> Vec<String> {
    document
      .blocks
      .iter()
      .map(|block| match block {
        Block::Paragraph(p) => p
          .inlines
          .iter()
          .map(|inline| match inline {
            Inline::Text(t) => t.as_str(),
            Inline::LineBreak => "\n",
            _ => "",
          })
          .collect::<String>(),
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
    assert_eq!(paragraph_texts(&parse(&data)), vec!["Café \u{201C}quoted\u{201D}"]);
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
  fn cell_marks_and_line_breaks() {
    let data = build_doc(
      &[TestPiece::Unicode("cell one\u{7}cell two\u{7}line\u{b}break\r")],
      0x0409,
      None,
    );
    assert_eq!(
      paragraph_texts(&parse(&data)),
      vec!["cell one", "cell two", "line\nbreak"]
    );
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
    let (mut word_doc, _) = build_word_doc_streams(&[TestPiece::Unicode("good text here\r")], 0x0409);
    word_doc[0x0A..0x0C].copy_from_slice(&0x1200u16.to_le_bytes());
    let fc_mac = word_doc.len() as u32;
    word_doc[0x18..0x1C].copy_from_slice(&(TEXT_START as u32).to_le_bytes());
    word_doc[0x1C..0x20].copy_from_slice(&fc_mac.to_le_bytes());
    let garbage_table = vec![0xFFu8; 64];
    let data = build_cfb(&[("WordDocument", &word_doc), ("1Table", &garbage_table)]);
    assert_eq!(paragraph_texts(&parse(&data)), vec!["good text here"]);
  }
}
