use encoding_rs::{Encoding, WINDOWS_1252};

/// Encoding for a Windows code page, excluding the Unicode pseudo code
/// pages.
pub fn encoding_for_codepage(codepage: u16) -> Option<&'static Encoding> {
  match codepage {
    0 | 1200 | 1201 | 65000 | 65001 => None,
    cp => codepage::to_encoding(cp),
  }
}

/// Default ANSI code page encoding for a Windows language ID.
pub fn encoding_for_lid(lid: u16) -> &'static Encoding {
  let codepage = match lid {
    // sublanguage decides the script for these
    0x0404 | 0x0C04 | 0x1404 | 0x7C04 => 950, // Chinese (Taiwan, Hong Kong, Macau, Traditional)
    0x0C1A | 0x1C1A => 1251,                  // Serbian (Cyrillic)
    0x082C | 0x0843 => 1251,                  // Azerbaijani, Uzbek (Cyrillic)
    _ => match lid & 0x3FF {
      0x04 => 936, // Chinese (Simplified unless a Traditional sublanguage above)
      // Central European
      0x05 | 0x0E | 0x15 | 0x18 | 0x1A | 0x1B | 0x1C | 0x24 => 1250,
      // Cyrillic
      0x02 | 0x19 | 0x22 | 0x23 | 0x2F | 0x3F | 0x40 | 0x44 | 0x50 => 1251,
      0x08 => 1253,               // Greek
      0x1F | 0x2C | 0x43 => 1254, // Turkish, Azerbaijani, Uzbek (Latin)
      0x0D => 1255,               // Hebrew
      0x01 | 0x20 | 0x29 => 1256, // Arabic, Urdu, Persian
      0x25 | 0x26 | 0x27 => 1257, // Baltic
      0x2A => 1258,               // Vietnamese
      0x1E => 874,                // Thai
      0x11 => 932,                // Japanese
      0x12 => 949,                // Korean
      _ => 1252,
    },
  };
  encoding_for_codepage(codepage).unwrap_or(WINDOWS_1252)
}
