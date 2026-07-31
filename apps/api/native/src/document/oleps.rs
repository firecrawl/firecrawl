//! Minimal MS-OLEPS parser for the `\x05SummaryInformation` stream of OLE
//! compound files.

use crate::document::encoding::encoding_for_codepage;
use chrono::{DateTime, Utc};
use encoding_rs::WINDOWS_1252;

const PID_CODEPAGE: u32 = 0x0001;
const PIDSI_TITLE: u32 = 0x0002;
const PIDSI_AUTHOR: u32 = 0x0004;
const PIDSI_CREATE_DTM: u32 = 0x000C;

const VT_I2: u32 = 0x0002;
const VT_LPSTR: u32 = 0x001E;
const VT_LPWSTR: u32 = 0x001F;
const VT_FILETIME: u32 = 0x0040;

/// Seconds between the FILETIME epoch (1601) and the Unix epoch (1970).
const FILETIME_UNIX_EPOCH_DIFF_SECS: i64 = 11_644_473_600;

#[derive(Debug, Default)]
pub struct SummaryInformation {
  pub codepage: Option<u16>,
  pub title: Option<String>,
  pub author: Option<String>,
  pub created: Option<DateTime<Utc>>,
}

pub fn parse_summary_information(data: &[u8]) -> Option<SummaryInformation> {
  // byte order mark at 0, property set count at 0x18, first section offset at 0x2C
  if read_u16(data, 0)? != 0xFFFE {
    return None;
  }
  if read_u32(data, 0x18)? == 0 {
    return None;
  }
  let section_start = read_u32(data, 0x2C)? as usize;

  let num_properties = (read_u32(data, section_start + 4)? as usize).min(1024);
  let mut properties = Vec::with_capacity(num_properties);
  for i in 0..num_properties {
    let entry = section_start + 8 + i * 8;
    let prop_id = read_u32(data, entry)?;
    let prop_offset = section_start + read_u32(data, entry + 4)? as usize;
    properties.push((prop_id, prop_offset));
  }

  let mut info = SummaryInformation::default();

  // code page first, it governs VT_LPSTR decoding
  info.codepage = properties
    .iter()
    .find(|(id, _)| *id == PID_CODEPAGE)
    .and_then(|(_, offset)| {
      if read_u32(data, *offset)? != VT_I2 {
        return None;
      }
      read_u16(data, offset + 4)
    });
  let string_encoding = info
    .codepage
    .and_then(encoding_for_codepage)
    .unwrap_or(WINDOWS_1252);

  for (prop_id, offset) in properties {
    match prop_id {
      PIDSI_TITLE => info.title = read_string(data, offset, string_encoding),
      PIDSI_AUTHOR => info.author = read_string(data, offset, string_encoding),
      PIDSI_CREATE_DTM => info.created = read_filetime(data, offset),
      _ => {}
    }
  }

  Some(info)
}

fn read_string(
  data: &[u8],
  offset: usize,
  encoding: &'static encoding_rs::Encoding,
) -> Option<String> {
  let vt = read_u32(data, offset)?;
  let len = read_u32(data, offset + 4)? as usize;
  let text = match vt {
    VT_LPSTR => {
      let bytes = data.get(offset + 8..offset + 8 + len)?;
      let (decoded, _, _) = encoding.decode(bytes);
      decoded.into_owned()
    }
    VT_LPWSTR => {
      let bytes = data.get(offset + 8..offset + 8 + len.checked_mul(2)?)?;
      let units: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|c| u16::from_le_bytes([c[0], c[1]]))
        .collect();
      String::from_utf16_lossy(&units)
    }
    _ => return None,
  };
  let text = text.trim_end_matches('\0').trim();
  if text.is_empty() {
    None
  } else {
    Some(text.to_string())
  }
}

fn read_filetime(data: &[u8], offset: usize) -> Option<DateTime<Utc>> {
  if read_u32(data, offset)? != VT_FILETIME {
    return None;
  }
  let filetime = read_u64(data, offset + 4)?;
  if filetime == 0 {
    return None;
  }
  let secs = (filetime / 10_000_000) as i64 - FILETIME_UNIX_EPOCH_DIFF_SECS;
  let nanos = (filetime % 10_000_000) as u32 * 100;
  DateTime::from_timestamp(secs, nanos)
}

fn read_u16(data: &[u8], offset: usize) -> Option<u16> {
  let bytes = data.get(offset..offset + 2)?;
  Some(u16::from_le_bytes([bytes[0], bytes[1]]))
}

fn read_u32(data: &[u8], offset: usize) -> Option<u32> {
  let bytes = data.get(offset..offset + 4)?;
  Some(u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
}

fn read_u64(data: &[u8], offset: usize) -> Option<u64> {
  let bytes = data.get(offset..offset + 8)?;
  Some(u64::from_le_bytes([
    bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
  ]))
}
