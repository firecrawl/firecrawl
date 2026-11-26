use firecrawl_tokenizer::{FitOutput, TrimOutput};
use napi::bindgen_prelude::{Error, Result, Status};
use tokio::task;

use crate::utils::to_napi_err;

fn to_u32(value: usize, label: &str) -> Result<u32> {
  u32::try_from(value)
    .map_err(|_| Error::new(Status::GenericFailure, format!("{label} exceeds u32 range")))
}

pub fn count_tokens(text: &str, model_id: &str) -> Result<u32> {
  let count = firecrawl_tokenizer::count_tokens(text, model_id).map_err(to_napi_err)?;
  to_u32(count, "token count")
}

pub fn trim_to_token_limit_native(
  text: &str,
  max_tokens: u32,
  model_id: &str,
) -> Result<(String, u32, u32, bool)> {
  let TrimOutput {
    text,
    num_tokens,
    original_tokens,
    trimmed,
  } = firecrawl_tokenizer::trim_to_token_limit(text, max_tokens as usize, model_id)
    .map_err(to_napi_err)?;
  Ok((
    text,
    to_u32(num_tokens, "num_tokens")?,
    to_u32(original_tokens, "original_tokens")?,
    trimmed,
  ))
}

pub async fn fit_to_tokens_native(
  text: String,
  max_tokens: u32,
  model_id: String,
) -> Result<FitOutput> {
  let res = task::spawn_blocking(move || {
    firecrawl_tokenizer::fit_to_tokens(&text, max_tokens as usize, &model_id)
  })
  .await
  .map_err(|e| {
    Error::new(
      Status::GenericFailure,
      format!("fit_to_tokens_native join error: {e}"),
    )
  })?;

  res.map_err(to_napi_err)
}
