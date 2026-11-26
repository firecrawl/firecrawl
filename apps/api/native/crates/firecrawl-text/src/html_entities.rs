use std::borrow::Cow;
use std::collections::HashMap;
use std::sync::OnceLock;

/// Legacy HTML4 named entities decoded even without a trailing `;`, ordered by
/// length descending for longest-prefix matching identical to `he.decode`.
const LEGACY_ENTITIES: &[(&str, &str)] = &[
  ("Aacute", "\u{00C1}"),
  ("Agrave", "\u{00C0}"),
  ("Atilde", "\u{00C3}"),
  ("Ccedil", "\u{00C7}"),
  ("Eacute", "\u{00C9}"),
  ("Egrave", "\u{00C8}"),
  ("Iacute", "\u{00CD}"),
  ("Igrave", "\u{00CC}"),
  ("Ntilde", "\u{00D1}"),
  ("Oacute", "\u{00D3}"),
  ("Ograve", "\u{00D2}"),
  ("Oslash", "\u{00D8}"),
  ("Otilde", "\u{00D5}"),
  ("Uacute", "\u{00DA}"),
  ("Ugrave", "\u{00D9}"),
  ("Yacute", "\u{00DD}"),
  ("aacute", "\u{00E1}"),
  ("agrave", "\u{00E0}"),
  ("atilde", "\u{00E3}"),
  ("brvbar", "\u{00A6}"),
  ("ccedil", "\u{00E7}"),
  ("curren", "\u{00A4}"),
  ("divide", "\u{00F7}"),
  ("eacute", "\u{00E9}"),
  ("egrave", "\u{00E8}"),
  ("frac12", "\u{00BD}"),
  ("frac14", "\u{00BC}"),
  ("frac34", "\u{00BE}"),
  ("iacute", "\u{00ED}"),
  ("igrave", "\u{00EC}"),
  ("iquest", "\u{00BF}"),
  ("middot", "\u{00B7}"),
  ("ntilde", "\u{00F1}"),
  ("oacute", "\u{00F3}"),
  ("ograve", "\u{00F2}"),
  ("oslash", "\u{00F8}"),
  ("otilde", "\u{00F5}"),
  ("plusmn", "\u{00B1}"),
  ("uacute", "\u{00FA}"),
  ("ugrave", "\u{00F9}"),
  ("yacute", "\u{00FD}"),
  ("AElig", "\u{00C6}"),
  ("Acirc", "\u{00C2}"),
  ("Aring", "\u{00C5}"),
  ("Ecirc", "\u{00CA}"),
  ("Icirc", "\u{00CE}"),
  ("Ocirc", "\u{00D4}"),
  ("THORN", "\u{00DE}"),
  ("Ucirc", "\u{00DB}"),
  ("acirc", "\u{00E2}"),
  ("acute", "\u{00B4}"),
  ("aelig", "\u{00E6}"),
  ("aring", "\u{00E5}"),
  ("cedil", "\u{00B8}"),
  ("ecirc", "\u{00EA}"),
  ("icirc", "\u{00EE}"),
  ("iexcl", "\u{00A1}"),
  ("laquo", "\u{00AB}"),
  ("micro", "\u{00B5}"),
  ("ocirc", "\u{00F4}"),
  ("pound", "\u{00A3}"),
  ("raquo", "\u{00BB}"),
  ("szlig", "\u{00DF}"),
  ("thorn", "\u{00FE}"),
  ("times", "\u{00D7}"),
  ("ucirc", "\u{00FB}"),
  ("Auml", "\u{00C4}"),
  ("COPY", "\u{00A9}"),
  ("Euml", "\u{00CB}"),
  ("Iuml", "\u{00CF}"),
  ("Ouml", "\u{00D6}"),
  ("QUOT", "\""),
  ("Uuml", "\u{00DC}"),
  ("auml", "\u{00E4}"),
  ("cent", "\u{00A2}"),
  ("copy", "\u{00A9}"),
  ("euml", "\u{00EB}"),
  ("iuml", "\u{00EF}"),
  ("macr", "\u{00AF}"),
  ("nbsp", "\u{00A0}"),
  ("ordf", "\u{00AA}"),
  ("ordm", "\u{00BA}"),
  ("ouml", "\u{00F6}"),
  ("para", "\u{00B6}"),
  ("quot", "\""),
  ("sect", "\u{00A7}"),
  ("sup1", "\u{00B9}"),
  ("sup2", "\u{00B2}"),
  ("sup3", "\u{00B3}"),
  ("uuml", "\u{00FC}"),
  ("yuml", "\u{00FF}"),
  ("AMP", "&"),
  ("ETH", "\u{00D0}"),
  ("REG", "\u{00AE}"),
  ("amp", "&"),
  ("deg", "\u{00B0}"),
  ("eth", "\u{00F0}"),
  ("not", "\u{00AC}"),
  ("reg", "\u{00AE}"),
  ("shy", "\u{00AD}"),
  ("uml", "\u{00A8}"),
  ("yen", "\u{00A5}"),
  ("GT", ">"),
  ("LT", "<"),
  ("gt", ">"),
  ("lt", "<"),
];

fn decode_code_point(code_point: u32) -> char {
  match code_point {
    0 | 0xD800..=0xDFFF => '\u{FFFD}',
    128 => '\u{20AC}',
    130 => '\u{201A}',
    131 => '\u{0192}',
    132 => '\u{201E}',
    133 => '\u{2026}',
    134 => '\u{2020}',
    135 => '\u{2021}',
    136 => '\u{02C6}',
    137 => '\u{2030}',
    138 => '\u{0160}',
    139 => '\u{2039}',
    140 => '\u{0152}',
    142 => '\u{017D}',
    145 => '\u{2018}',
    146 => '\u{2019}',
    147 => '\u{201C}',
    148 => '\u{201D}',
    149 => '\u{2022}',
    150 => '\u{2013}',
    151 => '\u{2014}',
    152 => '\u{02DC}',
    153 => '\u{2122}',
    154 => '\u{0161}',
    155 => '\u{203A}',
    156 => '\u{0153}',
    158 => '\u{017E}',
    159 => '\u{0178}',
    cp => char::from_u32(cp).unwrap_or('\u{FFFD}'),
  }
}

fn named_entity_map() -> &'static HashMap<&'static str, &'static str> {
  static MAP: OnceLock<HashMap<&'static str, &'static str>> = OnceLock::new();
  MAP.get_or_init(|| {
    let mut map = HashMap::with_capacity(entities::ENTITIES.len());
    for entry in &entities::ENTITIES {
      if let Some(name) = entry
        .entity
        .strip_prefix('&')
        .and_then(|s| s.strip_suffix(';'))
      {
        map.insert(name, entry.characters);
      }
    }
    map
  })
}

fn decode_named_fast(name: &str) -> Option<&'static str> {
  let fast = match name {
    "amp" | "AMP" => "&",
    "lt" | "LT" => "<",
    "gt" | "GT" => ">",
    "quot" | "QUOT" => "\"",
    "apos" => "'",
    "nbsp" => "\u{00A0}",
    "copy" | "COPY" => "\u{00A9}",
    "mdash" => "\u{2014}",
    "ndash" => "\u{2013}",
    "hellip" => "\u{2026}",
    "lsquo" => "\u{2018}",
    "rsquo" => "\u{2019}",
    "ldquo" => "\u{201C}",
    "rdquo" => "\u{201D}",
    "reg" | "REG" => "\u{00AE}",
    "trade" => "\u{2122}",
    _ => return named_entity_map().get(name).copied(),
  };
  Some(fast)
}

fn parse_numeric_ref(bytes: &[u8], start: usize) -> Option<(char, usize)> {
  let first = *bytes.get(start)?;
  let (radix, mut idx) = if first == b'x' || first == b'X' {
    (16u32, start.saturating_add(1))
  } else {
    (10u32, start)
  };

  let digits_start = idx;
  let mut acc: u32 = 0;
  let mut overflowed = false;

  while let Some(&b) = bytes.get(idx) {
    let digit = if radix == 16 {
      match b {
        b'0'..=b'9' => Some(u32::from(b.saturating_sub(b'0'))),
        b'a'..=b'f' => Some(u32::from(b.saturating_sub(b'a')).saturating_add(10)),
        b'A'..=b'F' => Some(u32::from(b.saturating_sub(b'A')).saturating_add(10)),
        _ => None,
      }
    } else if b.is_ascii_digit() {
      Some(u32::from(b.saturating_sub(b'0')))
    } else {
      None
    };

    let Some(d) = digit else {
      break;
    };
    if !overflowed {
      if let Some(next) = acc.checked_mul(radix).and_then(|v| v.checked_add(d)) {
        acc = next;
        if acc > 0x10_FFFF {
          overflowed = true;
        }
      } else {
        overflowed = true;
      }
    }
    idx = idx.saturating_add(1);
  }

  if idx == digits_start {
    return None;
  }
  if bytes.get(idx) == Some(&b';') {
    idx = idx.saturating_add(1);
  }

  let ch = if overflowed {
    '\u{FFFD}'
  } else {
    decode_code_point(acc)
  };
  Some((ch, idx))
}

/// Decode HTML5 named, legacy, decimal, and hex character references matching
/// `he.decode(input)` with default options.
pub fn decode_html_entities(input: &str) -> Cow<'_, str> {
  if !input.contains('&') {
    return Cow::Borrowed(input);
  }

  let bytes = input.as_bytes();
  let mut out = String::with_capacity(input.len());
  let mut i = 0usize;

  while let Some(rel_amp) = input.get(i..).and_then(|rest| rest.find('&')) {
    let amp = i.saturating_add(rel_amp);
    if let Some(prefix) = input.get(i..amp) {
      out.push_str(prefix);
    }

    let after_amp = amp.saturating_add(1);
    if bytes.get(after_amp) == Some(&b'#')
      && let Some((ch, next_idx)) = parse_numeric_ref(bytes, after_amp.saturating_add(1))
    {
      out.push(ch);
      i = next_idx;
      continue;
    }

    let mut name_end = after_amp;
    while let Some(&b) = bytes.get(name_end) {
      if b.is_ascii_alphanumeric() {
        name_end = name_end.saturating_add(1);
      } else {
        break;
      }
    }

    if name_end > after_amp
      && let Some(run) = input.get(after_amp..name_end)
    {
      if bytes.get(name_end) == Some(&b';')
        && let Some(decoded) = decode_named_fast(run)
      {
        out.push_str(decoded);
        i = name_end.saturating_add(1);
        continue;
      }

      let mut matched_legacy = false;
      for &(legacy_name, replacement) in LEGACY_ENTITIES {
        if run.starts_with(legacy_name) {
          let after_legacy = after_amp.saturating_add(legacy_name.len());
          if bytes.get(after_legacy) != Some(&b';') {
            out.push_str(replacement);
            i = after_legacy;
            matched_legacy = true;
            break;
          }
        }
      }
      if matched_legacy {
        continue;
      }
    }

    out.push('&');
    i = after_amp;
  }

  if let Some(tail) = input.get(i..) {
    out.push_str(tail);
  }
  Cow::Owned(out)
}
