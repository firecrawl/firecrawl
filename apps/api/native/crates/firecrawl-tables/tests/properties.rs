#![allow(
  clippy::unwrap_used,
  clippy::expect_used,
  clippy::indexing_slicing,
  clippy::panic,
  clippy::arithmetic_side_effects,
  reason = "test code: a panic is a failed property"
)]

use firecrawl_tables::{
  find_country_code_by_name, get_country, get_country_codes, get_model_price, get_model_price_keys,
  has_country, has_model_price, validate_country,
};
use hegel::TestCase;
use hegel::generators as gs;

#[hegel::test]
fn arbitrary_utf8_never_panics_and_preserves_invariants(tc: TestCase) {
  let input = tc.draw(gs::text());

  let has_price = has_model_price(&input);
  let price = get_model_price(&input);
  assert_eq!(has_price, price.is_some());

  let has_ctry = has_country(&input);
  let ctry = get_country(&input);
  assert_eq!(has_ctry, ctry.is_some());

  let valid = validate_country(&input);
  if has_ctry {
    assert!(valid);
  }
  if valid {
    assert_eq!(input.len(), 2);
    assert!(input.is_ascii());
    assert!(has_country(&input.to_ascii_uppercase()));
  }

  if let Some(code) = find_country_code_by_name(&input) {
    assert!(has_country(code));
    let info = get_country(code).unwrap();
    assert!(info.name.eq_ignore_ascii_case(&input));
  }
}

#[hegel::test]
fn known_country_codes_validate_regardless_of_ascii_case(tc: TestCase) {
  let codes: Vec<&str> = get_country_codes().collect();
  let code = tc.draw(gs::sampled_from(codes));
  let lower_first = tc.draw(gs::booleans());
  let lower_second = tc.draw(gs::booleans());

  let mut chars = code.chars();
  let c0 = chars.next().unwrap();
  let c1 = chars.next().unwrap();
  let mut variant = String::with_capacity(2);
  variant.push(if lower_first {
    c0.to_ascii_lowercase()
  } else {
    c0
  });
  variant.push(if lower_second {
    c1.to_ascii_lowercase()
  } else {
    c1
  });

  assert!(validate_country(&variant));
  assert_eq!(has_country(&variant), variant == code);
  assert_eq!(get_country(&variant).is_some(), variant == code);
}

#[hegel::test]
fn known_model_price_keys_round_trip_consistently(tc: TestCase) {
  let keys: Vec<&str> = get_model_price_keys().collect();
  let key = tc.draw(gs::sampled_from(keys));

  assert!(has_model_price(key));
  let price = get_model_price(key).unwrap();
  assert!(!price.litellm_provider.is_empty());
}
