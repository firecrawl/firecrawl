mod cache;
mod chunk;
mod models;

use std::fmt;

use crate::chunk::{CHUNK_BYTES, find_disallowed_special_in_chunk, next_chunk_end};
pub use crate::models::Encoding;
use crate::models::find_disallowed_special;

/// Errors returned by tokenizer operations.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TokenizerError {
  /// The supplied model identifier has no mapped BPE encoding.
  UnknownModel(String),
  /// The input contains a special token literal disallowed for ordinary text.
  DisallowedSpecialToken(&'static str),
  /// The underlying encoding table failed to initialize.
  EncodingUnavailable(&'static str),
}

impl fmt::Display for TokenizerError {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    match self {
      Self::UnknownModel(model) => write!(f, "Invalid model: {model}"),
      Self::DisallowedSpecialToken(token) => {
        write!(
          f,
          "The text contains a special token that is not allowed: {token}"
        )
      }
      Self::EncodingUnavailable(name) => write!(f, "Encoding unavailable: {name}"),
    }
  }
}

impl std::error::Error for TokenizerError {}

/// Result of trimming text to a strict token budget.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrimOutput {
  /// Original text if within budget, or the decoded prefix of `max_tokens` tokens.
  pub text: String,
  /// Token count of the returned `text` (always `<= max_tokens`).
  pub num_tokens: usize,
  /// Full token count of the input before trimming.
  pub original_tokens: usize,
  /// Whether the input exceeded `max_tokens` and was trimmed.
  pub trimmed: bool,
}

/// Result of fitting text into a token budget with streaming chunk early-exit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FitOutput {
  /// Original text if within budget, or a prefix trimmed to at most `max_tokens`.
  pub text: String,
  /// Whether the input was trimmed.
  pub trimmed: bool,
}

/// Counts the number of BPE tokens in `text` for `model_id`.
///
/// Uses a zero-allocation counting path and fails on unknown models or
/// disallowed special token literals.
pub fn count_tokens(text: &str, model_id: &str) -> Result<usize, TokenizerError> {
  let encoding = Encoding::from_model(model_id)?;
  if let Some((_, token)) = find_disallowed_special(encoding, text) {
    return Err(TokenizerError::DisallowedSpecialToken(token));
  }
  let bpe = cache::encoder(encoding)?;
  Ok(bpe.count(text))
}

/// Trims `text` to at most `max_tokens` tokens for `model_id`.
///
/// Performs a zero-allocation token count first and only encodes and decodes
/// when `text` exceeds `max_tokens`. Any trailing partial multi-byte UTF-8
/// sequence at the token boundary is replaced with U+FFFD via lossy decoding.
pub fn trim_to_token_limit(
  text: &str,
  max_tokens: usize,
  model_id: &str,
) -> Result<TrimOutput, TokenizerError> {
  let encoding = Encoding::from_model(model_id)?;
  if let Some((_, token)) = find_disallowed_special(encoding, text) {
    return Err(TokenizerError::DisallowedSpecialToken(token));
  }

  let bpe = cache::encoder(encoding)?;
  let total = bpe.count(text);
  if total <= max_tokens {
    return Ok(TrimOutput {
      text: text.to_string(),
      num_tokens: total,
      original_tokens: total,
      trimmed: false,
    });
  }

  if max_tokens == 0 {
    return Ok(TrimOutput {
      text: String::new(),
      num_tokens: 0,
      original_tokens: total,
      trimmed: true,
    });
  }

  let tokens = bpe.encode(text);
  let kept = tokens.get(..max_tokens).unwrap_or(tokens.as_slice());
  let decoded_bytes = bpe.decode(kept);
  let trimmed_text = String::from_utf8_lossy(&decoded_bytes).into_owned();

  Ok(TrimOutput {
    text: trimmed_text,
    num_tokens: kept.len(),
    original_tokens: tokens.len(),
    trimmed: true,
  })
}

/// Fits `text` to a prefix of at most `max_tokens` tokens for `model_id`.
///
/// Uses a byte-length fast path (every BPE token encodes at least one UTF-8
/// byte) and scans in piece-safe 64 KiB chunks so oversized documents stop as
/// soon as the token budget is exceeded.
pub fn fit_to_tokens(
  text: &str,
  max_tokens: usize,
  model_id: &str,
) -> Result<FitOutput, TokenizerError> {
  let encoding = Encoding::from_model(model_id)?;
  if text.len() <= max_tokens {
    if let Some((_, token)) = find_disallowed_special(encoding, text) {
      return Err(TokenizerError::DisallowedSpecialToken(token));
    }
    return Ok(FitOutput {
      text: text.to_string(),
      trimmed: false,
    });
  }

  fit_to_tokens_chunked(text, max_tokens, encoding, CHUNK_BYTES)
}

fn fit_to_tokens_chunked(
  text: &str,
  max_tokens: usize,
  encoding: Encoding,
  chunk_bytes: usize,
) -> Result<FitOutput, TokenizerError> {
  let bpe = cache::encoder(encoding)?;
  let mut used: usize = 0;
  let mut start: usize = 0;

  while start < text.len() {
    let end = next_chunk_end(text, start, chunk_bytes);
    if let Some(token) = find_disallowed_special_in_chunk(encoding, text, start, end) {
      return Err(TokenizerError::DisallowedSpecialToken(token));
    }

    let Some(chunk) = text.get(start..end) else {
      break;
    };
    let chunk_count = bpe.count(chunk);
    let next_used = used.saturating_add(chunk_count);

    if next_used > max_tokens {
      let remaining = max_tokens.saturating_sub(used);
      let prefix = text.get(..start).unwrap_or("");
      if remaining == 0 {
        return Ok(FitOutput {
          text: prefix.to_string(),
          trimmed: true,
        });
      }

      let tokens = bpe.encode(chunk);
      let kept_slice = tokens.get(..remaining).unwrap_or(tokens.as_slice());
      let kept_bytes = bpe.decode(kept_slice);
      let kept = String::from_utf8_lossy(&kept_bytes);

      let mut out = String::with_capacity(prefix.len().saturating_add(kept.len()));
      out.push_str(prefix);
      out.push_str(&kept);
      return Ok(FitOutput {
        text: out,
        trimmed: true,
      });
    }

    used = next_used;
    start = end;
  }

  Ok(FitOutput {
    text: text.to_string(),
    trimmed: false,
  })
}

#[cfg(test)]
mod tests;
