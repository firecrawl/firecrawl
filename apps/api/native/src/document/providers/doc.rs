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

  // First, try to find substantial single-byte text runs (cp1252 or cp1251)
  let ascii_text = extract_best_singlebyte(doc_data, ccp_text);
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

/// Decode single-byte text runs. Legacy .doc stores 8-bit text in a code page
/// that isn't recorded in the run data, so we default to Western (cp1252) — the
/// common case, decoded in a single pass — and only re-decode as Cyrillic
/// (cp1251) when the cp1252 output carries the tell-tale mojibake signature of
/// misread Cyrillic (a run dominated by Latin-1 accented letters). This avoids
/// garbled output for non-Western documents (e.g. Ukrainian/Russian) without
/// decoding twice for ordinary Western/ASCII files.
fn extract_best_singlebyte(data: &[u8], expected_chars: usize) -> String {
  extract_singlebyte_runs(data, expected_chars)
    .iter()
    .map(|run| decode_run_best(run))
    .collect::<Vec<_>>()
    .join("\n")
}

/// Decode one single-byte text run, choosing its code page independently.
/// Default to Western (cp1252) — one pass, the common case — and only re-decode
/// as Cyrillic (cp1251) when the cp1252 output is dominated by Latin-1 accented
/// letters (the mojibake signature of misread Cyrillic) and the cp1251 decode is
/// then predominantly Cyrillic. Deciding per run (rather than over one aggregate
/// ratio for the whole document) keeps Cyrillic sections intact in
/// mixed-language documents, where a long Western section could otherwise dilute
/// a Cyrillic section below the threshold and leave it as mojibake.
fn decode_run_best(run: &[u8]) -> String {
  let western: String = run.iter().map(|&b| decode_cp1252(b)).collect();

  // Cyrillic bytes (0xC0..=0xFF) read as cp1252 all land in the Latin-1
  // supplement (U+00C0..U+00FF). Real Western text is dominated by ASCII
  // letters, so a high accented ratio strongly implies a wrong code page.
  if latin1_accented_ratio(&western) >= 40 {
    let cyrillic: String = run.iter().map(|&b| decode_cp1251(b)).collect();
    if cyrillic_ratio(&cyrillic) >= 40 {
      return cyrillic;
    }
  }

  western
}

/// Fraction (0-100) of alphabetic characters that are in the Cyrillic block.
fn cyrillic_ratio(s: &str) -> usize {
  char_ratio(s, |c| ('\u{0400}'..='\u{04FF}').contains(&c))
}

/// Fraction (0-100) of alphabetic characters in the Latin-1 supplement block
/// (U+00C0..U+00FF) — the signature of Cyrillic bytes misread as cp1252.
fn latin1_accented_ratio(s: &str) -> usize {
  char_ratio(s, |c| ('\u{00C0}'..='\u{00FF}').contains(&c))
}

/// Percentage of alphabetic characters in `s` that are also matched by `pred`.
/// Both numerator and denominator count alphabetic characters only, so symbols
/// in the tested ranges (e.g. × U+00D7, ÷ U+00F7) never inflate the ratio.
fn char_ratio(s: &str, pred: impl Fn(char) -> bool) -> usize {
  let alphabetic = s.chars().filter(|c| c.is_alphabetic()).count();
  if alphabetic == 0 {
    return 0;
  }
  let matching = s.chars().filter(|&c| c.is_alphabetic() && pred(c)).count();
  matching * 100 / alphabetic
}

/// Scan for long runs of printable single-byte text, returning each run's raw
/// bytes (the code page is chosen later, per run, by `decode_run_best`). Run
/// boundaries are detected with cp1252 classification; since every byte decodes
/// to exactly one character in any single-byte code page, a run's byte length
/// equals its character length.
fn extract_singlebyte_runs(data: &[u8], expected_chars: usize) -> Vec<Vec<u8>> {
  // This works well for most .doc files where text is stored as single-byte
  let mut runs: Vec<Vec<u8>> = Vec::new();
  let mut current: Vec<u8> = Vec::new();
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

    // is_text_char covers tab (0x09); CR/LF and other control/non-text bytes
    // fall through and close the current run.
    if is_text_char(decode_cp1252(byte)) {
      current.push(byte);
    } else {
      flush_run(&mut current, &mut runs, &mut total_chars);
    }
  }

  flush_run(&mut current, &mut runs, &mut total_chars);
  runs
}

/// Accept `current` as a text run if it is long enough (>= 20 characters) and
/// word-like, measured on its cp1252 decode. Resets `current` either way.
fn flush_run(current: &mut Vec<u8>, runs: &mut Vec<Vec<u8>>, total_chars: &mut usize) {
  if current.len() >= 20 {
    let decoded: String = current.iter().map(|&b| decode_cp1252(b)).collect();
    if has_word_chars(&decoded) {
      *total_chars += current.len();
      runs.push(std::mem::take(current));
      return;
    }
  }
  current.clear();
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
        let stream_text = extract_best_singlebyte(&buf, 0);
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

fn decode_cp1251(b: u8) -> char {
  if b < 0x80 {
    return b as char;
  }
  // 0xC0..=0xFF map linearly onto the Cyrillic block А..я (U+0410..U+044F).
  if (0xC0..=0xFF).contains(&b) {
    return char::from_u32(0x0410 + (b as u32 - 0xC0)).unwrap_or('?');
  }
  match b {
    0x80 => '\u{0402}', // Ђ
    0x81 => '\u{0403}', // Ѓ
    0x82 => '\u{201A}', // ‚
    0x83 => '\u{0453}', // ѓ
    0x84 => '\u{201E}', // „
    0x85 => '\u{2026}', // …
    0x86 => '\u{2020}', // †
    0x87 => '\u{2021}', // ‡
    0x88 => '\u{20AC}', // €
    0x89 => '\u{2030}', // ‰
    0x8A => '\u{0409}', // Љ
    0x8B => '\u{2039}', // ‹
    0x8C => '\u{040A}', // Њ
    0x8D => '\u{040C}', // Ќ
    0x8E => '\u{040B}', // Ћ
    0x8F => '\u{040F}', // Џ
    0x90 => '\u{0452}', // ђ
    0x91 => '\u{2018}', // '
    0x92 => '\u{2019}', // '
    0x93 => '\u{201C}', // "
    0x94 => '\u{201D}', // "
    0x95 => '\u{2022}', // •
    0x96 => '\u{2013}', // –
    0x97 => '\u{2014}', // —
    0x99 => '\u{2122}', // ™
    0x9A => '\u{0459}', // љ
    0x9B => '\u{203A}', // ›
    0x9C => '\u{045A}', // њ
    0x9D => '\u{045C}', // ќ
    0x9E => '\u{045B}', // ћ
    0x9F => '\u{045F}', // џ
    0xA0 => '\u{00A0}', // NBSP
    0xA1 => '\u{040E}', // Ў
    0xA2 => '\u{045E}', // ў
    0xA3 => '\u{0408}', // Ј
    0xA4 => '\u{00A4}', // ¤
    0xA5 => '\u{0490}', // Ґ
    0xA6 => '\u{00A6}', // ¦
    0xA7 => '\u{00A7}', // §
    0xA8 => '\u{0401}', // Ё
    0xA9 => '\u{00A9}', // ©
    0xAA => '\u{0404}', // Є
    0xAB => '\u{00AB}', // «
    0xAC => '\u{00AC}', // ¬
    0xAD => '\u{00AD}', // SHY
    0xAE => '\u{00AE}', // ®
    0xAF => '\u{0407}', // Ї
    0xB0 => '\u{00B0}', // °
    0xB1 => '\u{00B1}', // ±
    0xB2 => '\u{0406}', // І
    0xB3 => '\u{0456}', // і
    0xB4 => '\u{0491}', // ґ
    0xB5 => '\u{00B5}', // µ
    0xB6 => '\u{00B6}', // ¶
    0xB7 => '\u{00B7}', // ·
    0xB8 => '\u{0451}', // ё
    0xB9 => '\u{2116}', // №
    0xBA => '\u{0454}', // є
    0xBB => '\u{00BB}', // »
    0xBC => '\u{0458}', // ј
    0xBD => '\u{0405}', // Ѕ
    0xBE => '\u{0455}', // ѕ
    0xBF => '\u{0457}', // ї
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

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn decodes_cp1251_cyrillic_letters() {
    // 0xC0..=0xFF map linearly onto А..я
    assert_eq!(decode_cp1251(0xC0), 'А');
    assert_eq!(decode_cp1251(0xFF), 'я');
    // Ukrainian-specific letters live outside the linear range
    assert_eq!(decode_cp1251(0xAF), 'Ї');
    assert_eq!(decode_cp1251(0xBF), 'ї');
    assert_eq!(decode_cp1251(0xA5), 'Ґ');
    // ASCII passes through untouched
    assert_eq!(decode_cp1251(b'A'), 'A');
  }

  #[test]
  fn picks_cyrillic_decode_for_cp1251_text() {
    // "ПРЕЗИДЕНТ УКРАЇНИ УКАЗ" encoded as Windows-1251 (>= 20 chars so the run
    // survives the character-count filter)
    let bytes = [
      0xCF, 0xD0, 0xC5, 0xC7, 0xC8, 0xC4, 0xC5, 0xCD, 0xD2, 0x20, 0xD3, 0xCA, 0xD0, 0xC0, 0xAF,
      0xCD, 0xC8, 0x20, 0xD3, 0xCA, 0xC0, 0xC7, 0x0D,
    ];
    let text = extract_best_singlebyte(&bytes, 0);
    assert!(
      text.contains("УКРАЇНИ УКАЗ"),
      "expected Cyrillic text, got mojibake: {text:?}"
    );
    // The naive cp1252 path would have produced Latin-1 mojibake instead.
    assert!(!text.contains('Ï'));
  }

  #[test]
  fn keeps_cp1252_decode_for_western_text() {
    let bytes = b"Hello World this is a plain ASCII test line.\r";
    let text = extract_best_singlebyte(bytes, 0);
    assert!(text.contains("Hello World this is a plain ASCII test line."));
  }

  #[test]
  fn cyrillic_ratio_thresholds() {
    assert_eq!(cyrillic_ratio("Президент України"), 100);
    assert_eq!(cyrillic_ratio("Hello World"), 0);
    assert_eq!(cyrillic_ratio(""), 0);
  }

  #[test]
  fn latin1_accented_ratio_distinguishes_mojibake_from_western() {
    // Cyrillic bytes misread as cp1252 land entirely in the Latin-1 supplement.
    assert!(latin1_accented_ratio("ÀÁÂÃÄÅ") >= 40);
    // Ordinary Western text with the odd accent stays well below the threshold.
    assert!(latin1_accented_ratio("a normal english sentence with one café") < 40);
    assert_eq!(latin1_accented_ratio(""), 0);
  }

  #[test]
  fn latin1_ratio_ignores_non_letter_symbols() {
    // ×÷ (U+00D7/U+00F7) sit in the Latin-1 supplement range but are symbols,
    // not letters — a symbol-heavy Western expression must not be mistaken for
    // the misread-Cyrillic signature.
    assert_eq!(latin1_accented_ratio("a × b ÷ c ×÷×÷"), 0);
  }

  #[test]
  fn decodes_cyrillic_run_even_when_western_text_dominates() {
    // A long English section followed by a shorter Cyrillic (cp1251) section.
    // A single aggregate ratio over the whole document would be diluted below
    // the threshold by the English text; deciding per run keeps the Cyrillic
    // section intact without disturbing the English one.
    let mut bytes: Vec<u8> = Vec::new();
    bytes.extend_from_slice(
      b"This is a fairly long English paragraph that dominates the document length.\r",
    );
    bytes.extend_from_slice(&[
      0xCF, 0xD0, 0xC5, 0xC7, 0xC8, 0xC4, 0xC5, 0xCD, 0xD2, 0x20, 0xD3, 0xCA, 0xD0, 0xC0, 0xAF,
      0xCD, 0xC8, 0x20, 0xD3, 0xCA, 0xC0, 0xC7, 0x0D,
    ]);
    let text = extract_best_singlebyte(&bytes, 0);
    assert!(
      text.contains("This is a fairly long English paragraph"),
      "expected English text preserved, got: {text:?}"
    );
    assert!(
      text.contains("УКРАЇНИ УКАЗ"),
      "expected Cyrillic run decoded, got mojibake: {text:?}"
    );
  }
}
