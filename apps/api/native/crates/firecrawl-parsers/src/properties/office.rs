use hegel::{TestCase, generators as gs};

const ZIP_PARTS: &[&str] = &[
  "[Content_Types].xml",
  "_rels/.rels",
  "word/document.xml",
  "word/_rels/document.xml.rels",
  "word/styles.xml",
  "ppt/presentation.xml",
  "xl/workbook.xml",
  "xl/sharedStrings.xml",
  "xl/worksheets/sheet1.xml",
  "ppt/slides/slide1.xml",
  "content.xml",
  "META-INF/container.xml",
  "mimetype",
];

const XML_NAMES: &[&str] = &[
  "Types",
  "Override",
  "Relationships",
  "Relationship",
  "w:document",
  "w:body",
  "w:p",
  "w:r",
  "w:t",
  "w:tbl",
  "w:tr",
  "w:tc",
  "w:hyperlink",
  "w:pStyle",
  "workbook",
  "sheets",
  "sheet",
  "worksheet",
  "sheetData",
  "row",
  "c",
  "v",
  "sst",
  "si",
  "t",
  "p:sld",
  "a:t",
  "office:document-content",
  "office:body",
  "office:text",
  "text:p",
  "text:h",
  "rootfile",
];

const XML_ATTRIBUTES: &[&str] = &[
  "PartName",
  "ContentType",
  "Target",
  "Id",
  "Type",
  "r:id",
  "w:val",
  "t",
  "r",
  "s",
  "xmlns:w",
  "full-path",
  "media-type",
  "text:outline-level",
];

const MIMETYPES: &[&str] = &[
  "application/vnd.oasis.opendocument.text",
  "application/vnd.oasis.opendocument.spreadsheet",
  "application/vnd.oasis.opendocument.presentation",
  "application/epub+zip",
];

const NAMESPACES: &str = concat!(
  " xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"",
  " xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"",
  " xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\"",
  " xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\"",
  " xmlns:p=\"http://schemas.openxmlformats.org/presentationml/2006/main\"",
  " xmlns:office=\"urn:oasis:names:tc:opendocument:xmlns:office:1.0\"",
  " xmlns:text=\"urn:oasis:names:tc:opendocument:xmlns:text:1.0\"",
);

const RELS_NS: &str = "http://schemas.openxmlformats.org/package/2006/relationships";
const TYPES_NS: &str = "http://schemas.openxmlformats.org/package/2006/content-types";
const OFFICE_DOCUMENT: &str =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument";

const MAIN_PARTS: &[(&str, &str)] = &[
  (
    "word/document.xml",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
  ),
  (
    "xl/workbook.xml",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
  ),
  (
    "ppt/presentation.xml",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml",
  ),
];

#[hegel::composite]
fn xml(tc: &TestCase, depth: u32) -> String {
  if depth == 0 || tc.draw(gs::weighted_booleans(0.3)) {
    return tc.draw(gs::text().max_size(16));
  }
  let name = tc.draw(gs::sampled_from(XML_NAMES));
  let attributes: String = tc
    .draw(
      gs::vecs(gs::tuples!(
        gs::sampled_from(XML_ATTRIBUTES),
        gs::text().max_size(12)
      ))
      .max_size(3),
    )
    .iter()
    .map(|(key, value)| format!(" {key}=\"{value}\""))
    .collect();
  let children = tc
    .draw(gs::vecs(xml(depth.saturating_sub(1))).max_size(3))
    .concat();
  format!("<{name}{attributes}>{children}</{name}>")
}

pub(super) fn crc32(data: &[u8]) -> u32 {
  let mut crc = !0u32;
  for byte in data {
    crc ^= u32::from(*byte);
    for _ in 0..8 {
      crc = (crc >> 1) ^ (0xEDB8_8320 & (crc & 1).wrapping_neg());
    }
  }
  !crc
}

/// Generates a stored (uncompressed) ZIP of OOXML, ODF, and EPUB parts with
/// fuzzed XML payloads.
#[hegel::composite]
pub(super) fn zip_body(tc: &TestCase) -> Vec<u8> {
  let mut zip = Vec::new();
  let mut directory = Vec::new();
  let (main_part, main_type) = tc.draw(gs::sampled_from(MAIN_PARTS));
  let parts = tc.draw(
    gs::vecs(gs::sampled_from(ZIP_PARTS))
      .unique(true)
      .min_size(1)
      .max_size(5),
  );
  for name in &parts {
    let data = match *name {
      "mimetype" => tc.draw(gs::sampled_from(MIMETYPES)).to_string(),
      "_rels/.rels" => format!(
        "<Relationships xmlns=\"{RELS_NS}\"><Relationship Id=\"rId1\" Type=\"{OFFICE_DOCUMENT}\" Target=\"{main_part}\"/></Relationships>"
      ),
      "[Content_Types].xml" => format!(
        "<Types xmlns=\"{TYPES_NS}\"><Override PartName=\"/{main_part}\" ContentType=\"{main_type}\"/></Types>"
      ),
      _ => {
        let root = tc.draw(gs::sampled_from(XML_NAMES));
        let children = tc.draw(gs::vecs(xml(3)).max_size(4)).concat();
        format!("<?xml version=\"1.0\"?><{root}{NAMESPACES}>{children}</{root}>")
      }
    };
    let (name_bytes, data_bytes) = (name.as_bytes(), data.as_bytes());
    let data_len = u32::try_from(data_bytes.len()).unwrap_or(u32::MAX);
    let name_len = u16::try_from(name_bytes.len()).unwrap_or(u16::MAX);
    let sizes = [crc32(data_bytes), data_len, data_len];
    let offset = u32::try_from(zip.len()).unwrap_or(u32::MAX);
    zip.extend(0x0403_4b50u32.to_le_bytes());
    zip.extend([20, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    for val in sizes {
      zip.extend(val.to_le_bytes());
    }
    zip.extend(name_len.to_le_bytes());
    zip.extend([0, 0]);
    zip.extend(name_bytes);
    zip.extend(data_bytes);
    directory.extend(0x0201_4b50u32.to_le_bytes());
    directory.extend([20, 0, 20, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    for val in sizes {
      directory.extend(val.to_le_bytes());
    }
    directory.extend(name_len.to_le_bytes());
    directory.extend([0; 12]);
    directory.extend(offset.to_le_bytes());
    directory.extend(name_bytes);
  }
  let directory_offset = u32::try_from(zip.len()).unwrap_or(u32::MAX);
  let dir_len = u32::try_from(directory.len()).unwrap_or(u32::MAX);
  let entry_count = u16::try_from(parts.len()).unwrap_or(u16::MAX);
  zip.extend(&directory);
  zip.extend(0x0605_4b50u32.to_le_bytes());
  zip.extend([0, 0, 0, 0]);
  zip.extend(entry_count.to_le_bytes());
  zip.extend(entry_count.to_le_bytes());
  zip.extend(dir_len.to_le_bytes());
  zip.extend(directory_offset.to_le_bytes());
  zip.extend([0, 0]);
  zip
}
