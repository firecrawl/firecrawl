use serde::ser::SerializeMap;
use serde::{Serialize, Serializer};

use crate::data::model_prices::MODEL_PRICES;

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct SearchContextCost {
  #[serde(skip_serializing_if = "Option::is_none")]
  pub search_context_size_low: Option<f64>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub search_context_size_medium: Option<f64>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub search_context_size_high: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct ModelMetadata {
  #[serde(skip_serializing_if = "Option::is_none")]
  pub notes: Option<&'static str>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub calculation: Option<&'static str>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub original_pricing_per_hour: Option<f64>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub original_pricing_per_minute: Option<f64>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub supports_tool_choice: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ExtraValue {
  Num(f64),
  Bool(bool),
  Str(&'static str),
  StrList(&'static [&'static str]),
  SearchContextCost(SearchContextCost),
  Metadata(ModelMetadata),
}

impl Serialize for ExtraValue {
  fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
    match *self {
      Self::Num(n) => serializer.serialize_f64(n),
      Self::Bool(b) => serializer.serialize_bool(b),
      Self::Str(s) => serializer.serialize_str(s),
      Self::StrList(list) => list.serialize(serializer),
      Self::SearchContextCost(cost) => cost.serialize(serializer),
      Self::Metadata(meta) => meta.serialize(serializer),
    }
  }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ModelPrice {
  pub litellm_provider: &'static str,
  pub mode: Option<&'static str>,
  pub max_tokens: Option<f64>,
  pub max_input_tokens: Option<f64>,
  pub max_output_tokens: Option<f64>,
  pub input_cost_per_token: Option<f64>,
  pub output_cost_per_token: Option<f64>,
  pub extra: &'static [(&'static str, ExtraValue)],
}

impl ModelPrice {
  /// Returns an additional optional field by exact key name.
  pub fn extra_field(&self, key: &str) -> Option<&ExtraValue> {
    self.extra.iter().find(|&&(k, _)| k == key).map(|(_, v)| v)
  }
}

impl Serialize for ModelPrice {
  fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
    let mut map = serializer.serialize_map(None)?;
    if let Some(v) = self.max_tokens {
      map.serialize_entry("max_tokens", &v)?;
    }
    if let Some(v) = self.max_input_tokens {
      map.serialize_entry("max_input_tokens", &v)?;
    }
    if let Some(v) = self.max_output_tokens {
      map.serialize_entry("max_output_tokens", &v)?;
    }
    if let Some(v) = self.input_cost_per_token {
      map.serialize_entry("input_cost_per_token", &v)?;
    }
    if let Some(v) = self.output_cost_per_token {
      map.serialize_entry("output_cost_per_token", &v)?;
    }
    map.serialize_entry("litellm_provider", self.litellm_provider)?;
    if let Some(v) = self.mode {
      map.serialize_entry("mode", v)?;
    }
    for &(key, ref value) in self.extra {
      map.serialize_entry(key, value)?;
    }
    map.end()
  }
}

/// Exact, case-sensitive model price lookup.
pub fn get_model_price(model: &str) -> Option<&'static ModelPrice> {
  let idx = MODEL_PRICES
    .binary_search_by_key(&model, |&(k, _)| k)
    .ok()?;
  MODEL_PRICES.get(idx).map(|(_, price)| price)
}

/// Exact, case-sensitive membership check matching `Object.hasOwn(modelPrices, model)`.
pub fn has_model_price(model: &str) -> bool {
  MODEL_PRICES
    .binary_search_by_key(&model, |&(k, _)| k)
    .is_ok()
}

/// Iterates over all model keys in sorted order.
pub fn get_model_price_keys() -> impl ExactSizeIterator<Item = &'static str> {
  MODEL_PRICES.iter().map(|&(k, _)| k)
}

/// Number of entries in the static model price table.
pub const fn model_price_count() -> usize {
  MODEL_PRICES.len()
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn model_prices_table_is_strictly_sorted_and_complete() {
    assert_eq!(model_price_count(), 1704);
    for pair in MODEL_PRICES.windows(2) {
      let [a, b] = pair else { continue };
      assert!(
        a.0 < b.0,
        "model prices not strictly sorted: {} >= {}",
        a.0,
        b.0
      );
    }
  }

  #[test]
  fn model_prices_lookup_and_serialization() {
    assert!(has_model_price("gpt-4o-mini"));
    assert!(!has_model_price("GPT-4O-MINI"));
    assert!(!has_model_price(""));
    assert!(!has_model_price("nonexistent-model"));

    let mini = get_model_price("gpt-4o-mini");
    assert_eq!(mini.map(|m| m.litellm_provider), Some("openai"));
    assert_eq!(mini.and_then(|m| m.max_input_tokens), Some(128_000.0));
    assert_eq!(mini.and_then(|m| m.max_output_tokens), Some(16_384.0));

    // Every entry must serialize cleanly to a JSON object.
    for &(key, ref price) in MODEL_PRICES {
      let serialized = serde_json::to_value(price);
      assert!(serialized.is_ok(), "failed to serialize {key}");
    }
  }
}
