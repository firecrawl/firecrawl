use std::collections::HashMap;

use napi::Result;
use serde_json::Value;

use crate::utils::to_napi_err;

pub fn get_model_price(model: &str) -> Result<Option<HashMap<String, Value>>> {
  let Some(price) = firecrawl_tables::get_model_price(model) else {
    return Ok(None);
  };
  let value = serde_json::to_value(price).map_err(to_napi_err)?;
  match value {
    Value::Object(map) => Ok(Some(map.into_iter().collect())),
    _ => Ok(None),
  }
}

pub fn has_model_price(model: &str) -> bool {
  firecrawl_tables::has_model_price(model)
}

pub fn get_model_price_keys() -> Vec<String> {
  firecrawl_tables::get_model_price_keys()
    .map(str::to_owned)
    .collect()
}

pub fn validate_country(code: &str) -> bool {
  firecrawl_tables::validate_country(code)
}

pub fn has_country(code: &str) -> bool {
  firecrawl_tables::has_country(code)
}

pub fn get_country_codes() -> Vec<String> {
  firecrawl_tables::get_country_codes()
    .map(str::to_owned)
    .collect()
}

pub fn find_country_code_by_name(name: &str) -> Option<String> {
  firecrawl_tables::find_country_code_by_name(name).map(str::to_owned)
}
