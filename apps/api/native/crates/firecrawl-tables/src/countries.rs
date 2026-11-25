use serde::Serialize;

use crate::data::countries::{COUNTRIES, COUNTRY_CODES_BY_LOWER_NAME};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct CountryInfo {
  pub name: &'static str,
  pub native: &'static str,
  pub phone: &'static [u16],
  pub continent: &'static str,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub continents: Option<&'static [&'static str]>,
  pub capital: &'static str,
  pub currency: &'static [&'static str],
  pub languages: &'static [&'static str],
  #[serde(rename = "partOf", skip_serializing_if = "Option::is_none")]
  pub part_of: Option<&'static str>,
  #[serde(rename = "userAssigned", skip_serializing_if = "Option::is_none")]
  pub user_assigned: Option<bool>,
}

/// Exact, case-sensitive ISO 3166-1 alpha-2 country lookup (e.g. "US").
pub fn get_country(code: &str) -> Option<&'static CountryInfo> {
  let idx = COUNTRIES.binary_search_by_key(&code, |&(k, _)| k).ok()?;
  COUNTRIES.get(idx).map(|(_, info)| info)
}

/// Exact, case-sensitive membership check matching `Object.hasOwn(countries, code)`.
pub fn has_country(code: &str) -> bool {
  COUNTRIES.binary_search_by_key(&code, |&(k, _)| k).is_ok()
}

/// Case-insensitive ASCII ISO 3166-1 alpha-2 validation (e.g. "US", "us", "Us").
pub fn validate_country(code: &str) -> bool {
  let bytes = code.as_bytes();
  if bytes.len() != 2 {
    return false;
  }
  let Some([a, b]) = bytes.first_chunk::<2>().copied() else {
    return false;
  };
  if !a.is_ascii_alphabetic() || !b.is_ascii_alphabetic() {
    return false;
  }
  let upper = [a.to_ascii_uppercase(), b.to_ascii_uppercase()];
  let Ok(key) = std::str::from_utf8(&upper) else {
    return false;
  };
  has_country(key)
}

/// Case-insensitive ASCII lookup by English country name, returning the uppercase ISO code.
pub fn find_country_code_by_name(name: &str) -> Option<&'static str> {
  if name.is_empty() || !name.is_ascii() {
    return None;
  }
  let idx = COUNTRY_CODES_BY_LOWER_NAME
    .binary_search_by(|&(entry_lower, _)| {
      entry_lower
        .bytes()
        .cmp(name.bytes().map(|b| b.to_ascii_lowercase()))
    })
    .ok()?;
  COUNTRY_CODES_BY_LOWER_NAME.get(idx).map(|&(_, code)| code)
}

/// Iterates over all ISO 3166-1 alpha-2 country codes in sorted order.
pub fn get_country_codes() -> impl ExactSizeIterator<Item = &'static str> {
  COUNTRIES.iter().map(|&(code, _)| code)
}

/// Number of entries in the static country table.
pub const fn country_count() -> usize {
  COUNTRIES.len()
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn countries_table_is_strictly_sorted_and_complete() {
    assert_eq!(country_count(), 250);
    for pair in COUNTRIES.windows(2) {
      let [a, b] = pair else { continue };
      assert!(
        a.0 < b.0,
        "countries not strictly sorted: {} >= {}",
        a.0,
        b.0
      );
    }
  }

  #[test]
  fn country_name_index_is_strictly_sorted_and_consistent() {
    assert_eq!(COUNTRY_CODES_BY_LOWER_NAME.len(), COUNTRIES.len());
    for pair in COUNTRY_CODES_BY_LOWER_NAME.windows(2) {
      let [a, b] = pair else { continue };
      assert!(
        a.0 < b.0,
        "country names not strictly sorted: {} >= {}",
        a.0,
        b.0
      );
    }
    for &(lower_name, code) in COUNTRY_CODES_BY_LOWER_NAME {
      assert!(lower_name.is_ascii());
      let info = get_country(code);
      assert!(info.is_some(), "missing country entry for code {code}");
      let Some(info) = info else {
        continue;
      };
      assert_eq!(info.name.to_ascii_lowercase(), lower_name);
      assert_eq!(find_country_code_by_name(info.name), Some(code));
      assert_eq!(find_country_code_by_name(lower_name), Some(code));
      assert_eq!(
        find_country_code_by_name(&info.name.to_ascii_uppercase()),
        Some(code)
      );
    }
  }

  #[test]
  fn lookup_and_validation_edge_cases() {
    assert!(validate_country("US"));
    assert!(validate_country("us"));
    assert!(validate_country("Us"));
    assert!(!validate_country(""));
    assert!(!validate_country("U"));
    assert!(!validate_country("USA"));
    assert!(!validate_country("XX"));
    assert!(!validate_country("ß"));

    assert!(has_country("US"));
    assert!(!has_country("us"));
    assert!(get_country("us").is_none());

    let us = get_country("US");
    assert_eq!(us.map(|c| c.name), Some("United States"));
    assert_eq!(us.and_then(|c| c.continents), None);
    assert_eq!(us.and_then(|c| c.part_of), None);
    assert_eq!(us.and_then(|c| c.user_assigned), None);

    assert_eq!(get_country("AX").and_then(|c| c.part_of), Some("FI"));
    assert_eq!(get_country("XK").and_then(|c| c.user_assigned), Some(true));
    assert_eq!(
      get_country("AZ").and_then(|c| c.continents),
      Some(&["AS", "EU"][..])
    );
    assert_eq!(get_country("AQ").map(|c| c.currency), Some(&[][..]));
    assert_eq!(find_country_code_by_name("United States"), Some("US"));
    assert_eq!(find_country_code_by_name("georgia"), Some("GE"));
    assert_eq!(find_country_code_by_name(""), None);
  }
}
