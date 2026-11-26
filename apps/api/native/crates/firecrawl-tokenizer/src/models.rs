use crate::TokenizerError;

/// OpenAI BPE encoding families supported by the tokenizer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Encoding {
  O200kBase,
  Cl100kBase,
  P50kBase,
  P50kEdit,
  R50kBase,
  Gpt2,
}

const ENDOFTEXT: &str = "<|endoftext|>";
const ENDOFPROMPT: &str = "<|endofprompt|>";
const FIM_PREFIX: &str = "<|fim_prefix|>";
const FIM_MIDDLE: &str = "<|fim_middle|>";
const FIM_SUFFIX: &str = "<|fim_suffix|>";

/// Longest byte length among all disallowed special token literals.
pub(crate) const MAX_SPECIAL_TOKEN_BYTES: usize = ENDOFPROMPT.len();

const O200K_DISALLOWED: &[&str] = &[ENDOFTEXT, ENDOFPROMPT];
const CL100K_DISALLOWED: &[&str] = &[ENDOFTEXT, FIM_PREFIX, FIM_MIDDLE, FIM_SUFFIX, ENDOFPROMPT];
const P50K_EDIT_DISALLOWED: &[&str] = &[ENDOFTEXT, FIM_PREFIX, FIM_MIDDLE, FIM_SUFFIX];
const R50K_DISALLOWED: &[&str] = &[ENDOFTEXT];

impl Encoding {
  /// Resolve an OpenAI model identifier to its exact BPE encoding.
  pub fn from_model(model: &str) -> Result<Self, TokenizerError> {
    match model {
      "gpt-4o"
      | "gpt-4o-2024-05-13"
      | "gpt-4o-2024-08-06"
      | "gpt-4o-2024-11-20"
      | "gpt-4o-mini-2024-07-18"
      | "gpt-4o-mini"
      | "gpt-4o-search-preview"
      | "gpt-4o-search-preview-2025-03-11"
      | "gpt-4o-mini-search-preview"
      | "gpt-4o-mini-search-preview-2025-03-11"
      | "gpt-4o-audio-preview"
      | "gpt-4o-audio-preview-2024-12-17"
      | "gpt-4o-audio-preview-2024-10-01"
      | "gpt-4o-mini-audio-preview"
      | "gpt-4o-mini-audio-preview-2024-12-17"
      | "o1"
      | "o1-2024-12-17"
      | "o1-mini"
      | "o1-mini-2024-09-12"
      | "o1-preview"
      | "o1-preview-2024-09-12"
      | "o1-pro"
      | "o1-pro-2025-03-19"
      | "o3"
      | "o3-2025-04-16"
      | "o3-mini"
      | "o3-mini-2025-01-31"
      | "o4-mini"
      | "o4-mini-2025-04-16"
      | "chatgpt-4o-latest"
      | "gpt-4o-realtime"
      | "gpt-4o-realtime-preview-2024-10-01"
      | "gpt-4o-realtime-preview-2024-12-17"
      | "gpt-4o-mini-realtime-preview"
      | "gpt-4o-mini-realtime-preview-2024-12-17"
      | "gpt-4.1"
      | "gpt-4.1-2025-04-14"
      | "gpt-4.1-mini"
      | "gpt-4.1-mini-2025-04-14"
      | "gpt-4.1-nano"
      | "gpt-4.1-nano-2025-04-14"
      | "gpt-4.5-preview"
      | "gpt-4.5-preview-2025-02-27"
      | "gpt-5"
      | "gpt-5-2025-08-07"
      | "gpt-5-nano"
      | "gpt-5-nano-2025-08-07"
      | "gpt-5-mini"
      | "gpt-5-mini-2025-08-07"
      | "gpt-5-chat-latest" => Ok(Self::O200kBase),

      "davinci-002"
      | "babbage-002"
      | "text-embedding-ada-002"
      | "text-embedding-3-small"
      | "text-embedding-3-large"
      | "gpt-3.5-turbo"
      | "gpt-35-turbo"
      | "gpt-3.5-turbo-0301"
      | "gpt-3.5-turbo-0613"
      | "gpt-3.5-turbo-1106"
      | "gpt-3.5-turbo-0125"
      | "gpt-3.5-turbo-16k"
      | "gpt-3.5-turbo-16k-0613"
      | "gpt-3.5-turbo-instruct"
      | "gpt-3.5-turbo-instruct-0914"
      | "gpt-4"
      | "gpt-4-0314"
      | "gpt-4-0613"
      | "gpt-4-32k"
      | "gpt-4-32k-0314"
      | "gpt-4-32k-0613"
      | "gpt-4-turbo"
      | "gpt-4-turbo-2024-04-09"
      | "gpt-4-turbo-preview"
      | "gpt-4-1106-preview"
      | "gpt-4-0125-preview"
      | "gpt-4-vision-preview" => Ok(Self::Cl100kBase),

      "text-davinci-003" | "text-davinci-002" | "code-davinci-002" | "code-davinci-001"
      | "code-cushman-002" | "code-cushman-001" | "davinci-codex" | "cushman-codex" => {
        Ok(Self::P50kBase)
      }

      "text-davinci-edit-001" | "code-davinci-edit-001" => Ok(Self::P50kEdit),

      "text-davinci-001"
      | "text-curie-001"
      | "text-babbage-001"
      | "text-ada-001"
      | "davinci"
      | "curie"
      | "babbage"
      | "ada"
      | "text-similarity-davinci-001"
      | "text-similarity-curie-001"
      | "text-similarity-babbage-001"
      | "text-similarity-ada-001"
      | "text-search-davinci-doc-001"
      | "text-search-curie-doc-001"
      | "text-search-babbage-doc-001"
      | "text-search-ada-doc-001"
      | "code-search-babbage-code-001"
      | "code-search-ada-code-001" => Ok(Self::R50kBase),

      "gpt2" => Ok(Self::Gpt2),

      _ => Err(TokenizerError::UnknownModel(model.to_string())),
    }
  }

  /// Canonical encoding name understood by the underlying BPE registry.
  #[must_use]
  pub const fn as_str(self) -> &'static str {
    match self {
      Self::O200kBase => "o200k_base",
      Self::Cl100kBase => "cl100k_base",
      Self::P50kBase => "p50k_base",
      Self::P50kEdit => "p50k_edit",
      Self::R50kBase => "r50k_base",
      Self::Gpt2 => "gpt2",
    }
  }

  /// Special token literals disallowed by default when encoding ordinary text.
  #[must_use]
  pub const fn disallowed_special_tokens(self) -> &'static [&'static str] {
    match self {
      Self::O200kBase => O200K_DISALLOWED,
      Self::Cl100kBase => CL100K_DISALLOWED,
      Self::P50kEdit => P50K_EDIT_DISALLOWED,
      Self::P50kBase | Self::R50kBase | Self::Gpt2 => R50K_DISALLOWED,
    }
  }
}

/// Returns the byte offset and literal of the earliest disallowed special token
/// in `text`, or `None` if none appear.
#[must_use]
pub(crate) fn find_disallowed_special(
  encoding: Encoding,
  text: &str,
) -> Option<(usize, &'static str)> {
  // Every disallowed special token across all supported encodings starts with "<|".
  if !text.contains("<|") {
    return None;
  }

  let mut earliest: Option<(usize, &'static str)> = None;
  for &token in encoding.disallowed_special_tokens() {
    if let Some(pos) = text.find(token) {
      let is_earlier = match earliest {
        None => true,
        Some((best_pos, _)) => pos < best_pos,
      };
      if is_earlier {
        earliest = Some((pos, token));
      }
    }
  }
  earliest
}
