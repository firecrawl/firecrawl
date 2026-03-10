use crate::document::model::*;
use crate::document::providers::DocumentProvider;
use cfb::CompoundFile;
use std::error::Error;
use std::io::Cursor;
use std::io::Read;

pub struct DocProvider;

impl DocProvider {
  pub fn new() -> Self {
    Self
  }
}

impl DocumentProvider for DocProvider {
  fn parse_buffer(&self, data: &[u8]) -> Result<Document, Box<dyn Error + Send + Sync>> {
    let cursor = Cursor::new(data);
    let mut cfb = CompoundFile::open(cursor)?;

    let mut metadata = DocumentMetadata::default();

    // Try to extract metadata from SummaryInformation stream
    if let Ok(summary_info) = extract_summary_info(&mut cfb) {
      metadata.title = summary_info.title;
      metadata.author = summary_info.author;
    }

    // Extract text content from the document
    let text_content = extract_text_content(&mut cfb)?;

    // Convert the extracted text to document blocks
    let blocks = text_to_blocks(&text_content);

    Ok(Document {
      blocks,
      metadata,
      notes: Vec::new(),
      comments: Vec::new(),
    })
  }

  fn name(&self) -> &'static str {
    "doc"
  }
}

#[derive(Default)]
struct SummaryInfo {
  title: Option<String>,
  author: Option<String>,
}

fn extract_summary_info<R: Read + std::io::Seek>(
  cfb: &mut CompoundFile<R>,
) -> Result<SummaryInfo, Box<dyn Error + Send + Sync>> {
  let mut info = SummaryInfo::default();

  // Try to read the SummaryInformation stream
  if let Ok(mut stream) = cfb.open_stream("\x05SummaryInformation") {
    let mut buf = Vec::new();
    stream.read_to_end(&mut buf)?;

    // Parse the OLE property set stream to extract title and author
    if let Some((title, author)) = parse_summary_info_stream(&buf) {
      info.title = title;
      info.author = author;
    }
  }

  Ok(info)
}

fn parse_summary_info_stream(data: &[u8]) -> Option<(Option<String>, Option<String>)> {
  // MS-OLEPS: Property Set Stream format
  // This is a simplified parser that extracts strings from the property stream

  if data.len() < 48 {
    return None;
  }

  // Byte order mark at offset 0 should be 0xFFFE (little-endian)
  if data.len() >= 2 && (data[0] != 0xFE || data[1] != 0xFF) {
    return None;
  }

  let mut title: Option<String> = None;
  let mut author: Option<String> = None;

  // Extract readable strings from the property stream
  let strings = extract_ascii_strings(data, 3);

  // Filter out common non-title/author strings
  let filtered: Vec<&str> = strings
    .iter()
    .map(|s| s.as_str())
    .filter(|s| {
      !s.contains("Microsoft")
        && !s.contains("Normal")
        && !s.contains("template")
        && !s.starts_with("http")
        && s.len() >= 2
        && s.len() <= 200
    })
    .collect();

  // Title and author are typically the first meaningful strings
  if let Some(t) = filtered.first() {
    title = Some(t.to_string());
  }
  if let Some(a) = filtered.get(1) {
    author = Some(a.to_string());
  }

  Some((title, author))
}

fn extract_text_content<R: Read + std::io::Seek>(
  cfb: &mut CompoundFile<R>,
) -> Result<String, Box<dyn Error + Send + Sync>> {
  // Try to read the WordDocument stream
  if let Ok(mut stream) = cfb.open_stream("WordDocument") {
    let mut doc_data = Vec::new();
    stream.read_to_end(&mut doc_data)?;

    // Extract text from the WordDocument stream
    if let Some(text) = extract_text_from_word_document(&doc_data) {
      if !text.trim().is_empty() {
        return Ok(text);
      }
    }
  }

  // Fallback: scan all streams for text
  extract_text_fallback(cfb)
}

fn extract_text_from_word_document(doc_data: &[u8]) -> Option<String> {
  if doc_data.len() < 32 {
    return None;
  }

  // Check for Word magic number (0xA5EC for Word 97-2003, 0xA5DC for older)
  let magic = u16::from_le_bytes([doc_data[0], doc_data[1]]);
  if magic != 0xA5EC && magic != 0xA5DC {
    return None;
  }

  // Read the FIB (File Information Block) to get text encoding info
  // Bit 9 of flags (offset 0x0A) indicates which table stream to use
  // But for text extraction, we'll use a more robust approach

  // The FIB contains ccpText at offset 0x4C (character count of main text)
  let ccp_text = if doc_data.len() > 0x50 {
    u32::from_le_bytes([
      doc_data[0x4C],
      doc_data[0x4D],
      doc_data[0x4E],
      doc_data[0x4F],
    ]) as usize
  } else {
    0
  };

  // For complex documents, text may be in pieces. For simple ones, it's contiguous.
  // Either way, we'll scan for text runs since the piece table parsing is complex.

  // .doc files typically store text as CP1252 (single-byte) or UTF-16LE
  // We'll try to detect which one by looking for patterns

  // First, try to find substantial ASCII/CP1252 text runs
  let ascii_text = extract_document_text_cp1252(doc_data, ccp_text);
  if !ascii_text.trim().is_empty() && has_enough_words(&ascii_text, 10) {
    return Some(ascii_text);
  }

  // If ASCII extraction didn't work well, try UTF-16LE
  let utf16_text = extract_document_text_utf16(doc_data, ccp_text);
  if !utf16_text.trim().is_empty() && has_enough_words(&utf16_text, 10) {
    return Some(utf16_text);
  }

  // Return whichever has more content
  if ascii_text.len() > utf16_text.len() {
    Some(ascii_text)
  } else if !utf16_text.is_empty() {
    Some(utf16_text)
  } else {
    None
  }
}

fn extract_document_text_cp1252(data: &[u8], expected_chars: usize) -> String {
  // Find long runs of printable ASCII/CP1252 characters
  // This works well for most .doc files where text is stored as single-byte
  let mut text_runs: Vec<String> = Vec::new();
  let mut current_run = String::new();
  let mut total_chars = 0;
  let max_chars = if expected_chars > 0 && expected_chars < 10_000_000 {
    expected_chars * 2 // Allow some extra for headers/footers
  } else {
    10_000_000
  };

  for &byte in data.iter() {
    if total_chars >= max_chars {
      break;
    }

    let ch = decode_cp1252(byte);

    if is_text_char(ch) {
      current_run.push(ch);
    } else if byte == 0x0D || byte == 0x0A {
      // Carriage return or line feed - end of paragraph
      if current_run.len() >= 20 && has_word_chars(&current_run) {
        text_runs.push(current_run.clone());
        total_chars += current_run.len();
      }
      current_run.clear();
    } else if byte == 0x09 {
      // Tab
      current_run.push('\t');
    } else {
      // Non-text byte - might be end of a text run
      if current_run.len() >= 20 && has_word_chars(&current_run) {
        text_runs.push(current_run.clone());
        total_chars += current_run.len();
      }
      current_run.clear();
    }
  }

  // Don't forget the last run
  if current_run.len() >= 20 && has_word_chars(&current_run) {
    text_runs.push(current_run);
  }

  // Join text runs with newlines
  text_runs.join("\n")
}

fn extract_document_text_utf16(data: &[u8], expected_chars: usize) -> String {
  let mut text = String::new();
  let max_chars = if expected_chars > 0 && expected_chars < 10_000_000 {
    expected_chars * 2
  } else {
    10_000_000
  };

  let mut i = 0;
  let mut char_count = 0;
  while i + 1 < data.len() && char_count < max_chars {
    let code = u16::from_le_bytes([data[i], data[i + 1]]);

    if let Some(ch) = char::from_u32(code as u32) {
      if is_text_char(ch) || ch == '\r' || ch == '\n' || ch == '\t' {
        if ch == '\r' {
          text.push('\n');
        } else {
          text.push(ch);
        }
        char_count += 1;
      }
    }
    i += 2;
  }

  // Filter to only keep substantial text portions
  let lines: Vec<&str> = text
    .lines()
    .filter(|line| line.len() >= 10 && has_word_chars(line))
    .collect();

  lines.join("\n")
}

fn has_word_chars(s: &str) -> bool {
  // Check if the string contains actual word characters (letters)
  let letter_count = s.chars().filter(|c| c.is_alphabetic()).count();
  let total_count = s.chars().count();
  // At least 30% should be letters
  letter_count > 0 && (letter_count * 100 / total_count.max(1)) >= 30
}

fn has_enough_words(s: &str, min_words: usize) -> bool {
  s.split_whitespace().count() >= min_words
}

fn is_text_char(ch: char) -> bool {
  // Printable character (not control chars, but allow some special ones)
  (ch >= ' ' && ch != '\x7F') || ch == '\t'
}

fn extract_ascii_strings(data: &[u8], min_length: usize) -> Vec<String> {
  let mut strings = Vec::new();
  let mut current = String::new();

  for &byte in data {
    let ch = decode_cp1252(byte);
    if ch.is_ascii_graphic() || ch == ' ' {
      current.push(ch);
    } else {
      if current.len() >= min_length {
        strings.push(current.clone());
      }
      current.clear();
    }
  }

  if current.len() >= min_length {
    strings.push(current);
  }

  strings
}

fn extract_text_fallback<R: Read + std::io::Seek>(
  cfb: &mut CompoundFile<R>,
) -> Result<String, Box<dyn Error + Send + Sync>> {
  let mut all_text = String::new();

  // List all streams and try to extract text from each
  let entries: Vec<String> = cfb
    .walk()
    .filter(|e| e.is_stream())
    .map(|e| e.path().to_string_lossy().to_string())
    .collect();

  for entry in entries {
    // Skip known non-text streams
    if entry.contains("CompObj")
      || entry.contains("Data")
      || entry.contains("ObjectPool")
      || entry.contains("Pictures")
    {
      continue;
    }

    if let Ok(mut stream) = cfb.open_stream(&entry) {
      let mut buf = Vec::new();
      if stream.read_to_end(&mut buf).is_ok() {
        let stream_text = extract_document_text_cp1252(&buf, 0);
        if !stream_text.trim().is_empty() && has_enough_words(&stream_text, 5) {
          if !all_text.is_empty() {
            all_text.push('\n');
          }
          all_text.push_str(&stream_text);
        }
      }
    }
  }

  Ok(all_text)
}

fn decode_cp1252(b: u8) -> char {
  if b < 0x80 {
    return b as char;
  }
  match b {
    0x80 => '\u{20AC}', // Euro sign
    0x82 => '\u{201A}', // Single low-9 quotation mark
    0x83 => '\u{0192}', // Latin small letter f with hook
    0x84 => '\u{201E}', // Double low-9 quotation mark
    0x85 => '\u{2026}', // Horizontal ellipsis
    0x86 => '\u{2020}', // Dagger
    0x87 => '\u{2021}', // Double dagger
    0x88 => '\u{02C6}', // Modifier letter circumflex accent
    0x89 => '\u{2030}', // Per mille sign
    0x8A => '\u{0160}', // Latin capital letter S with caron
    0x8B => '\u{2039}', // Single left-pointing angle quotation mark
    0x8C => '\u{0152}', // Latin capital ligature OE
    0x8E => '\u{017D}', // Latin capital letter Z with caron
    0x91 => '\u{2018}', // Left single quotation mark
    0x92 => '\u{2019}', // Right single quotation mark
    0x93 => '\u{201C}', // Left double quotation mark
    0x94 => '\u{201D}', // Right double quotation mark
    0x95 => '\u{2022}', // Bullet
    0x96 => '\u{2013}', // En dash
    0x97 => '\u{2014}', // Em dash
    0x98 => '\u{02DC}', // Small tilde
    0x99 => '\u{2122}', // Trade mark sign
    0x9A => '\u{0161}', // Latin small letter s with caron
    0x9B => '\u{203A}', // Single right-pointing angle quotation mark
    0x9C => '\u{0153}', // Latin small ligature oe
    0x9E => '\u{017E}', // Latin small letter z with caron
    0x9F => '\u{0178}', // Latin capital letter Y with diaeresis
    _ => char::from_u32(b as u32).unwrap_or('?'),
  }
}

fn text_to_blocks(text: &str) -> Vec<Block> {
  let mut blocks = Vec::new();

  // Split text into paragraphs and create blocks
  for paragraph in text.split('\n') {
    let trimmed = paragraph.trim();
    if trimmed.is_empty() {
      continue;
    }

    // Clean up the text - remove control characters except tabs
    let cleaned: String = trimmed
      .chars()
      .filter(|c| !c.is_control() || *c == '\t')
      .collect();

    if cleaned.is_empty() {
      continue;
    }

    blocks.push(Block::Paragraph(Paragraph {
      kind: ParagraphKind::Normal,
      inlines: vec![Inline::Text(cleaned)],
    }));
  }

  blocks
}
