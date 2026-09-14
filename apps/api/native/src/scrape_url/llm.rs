use std::sync::LazyLock;

use genai::Client;
use genai::ServiceTarget;
use genai::adapter::AdapterKind;
use genai::resolver::Endpoint;

static LLM_CLIENT: LazyLock<Result<Client, genai::Error>> = LazyLock::new(|| {
  let openai_base_url = std::env::var("OPENAI_BASE_URL")
    .ok()
    .filter(|x| !x.is_empty());
  let ollama_base_url = std::env::var("OLLAMA_BASE_URL")
    .ok()
    .filter(|x| !x.is_empty());

  Client::builder()
    .with_service_target_resolver_fn(move |target: ServiceTarget| {
      let base_url = match target.model.adapter_kind {
        AdapterKind::OpenAI => &openai_base_url,
        AdapterKind::Ollama => &ollama_base_url,
        _ => &None,
      };
      Ok(match base_url {
        Some(base_url) => ServiceTarget {
          endpoint: Endpoint::from_owned(base_url.clone()),
          ..target
        },
        None => target,
      })
    })
    .build()
});

#[derive(Debug, thiserror::Error)]
pub enum LlmError {
  #[error("failed to build LLM client: {0}")]
  ClientBuild(String),

  #[error("LLM refused to extract the website's content")]
  Refusal,

  #[error("LLM output failed to parse as JSON: {0}")]
  InvalidJson(String),

  #[error("Failed to generate schema after all attempts. Last error: {0}")]
  SchemaGeneration(String),

  #[error(transparent)]
  Genai(genai::Error),
}

pub fn client() -> Result<&'static Client, LlmError> {
  LLM_CLIENT
    .as_ref()
    .map_err(|e| LlmError::ClientBuild(e.to_string()))
}

pub fn model_name_with_override(default: &str) -> String {
  match std::env::var("MODEL_NAME") {
    Ok(x) if !x.is_empty() => x,
    _ => default.to_string(),
  }
}

pub fn is_quota_error(e: &genai::Error) -> bool {
  if e.status().is_some_and(|s| s.as_u16() == 429) {
    return true;
  }
  let message = e.to_string();
  message.contains("Quota exceeded")
    || message.contains("exceeded your current quota")
    || message.contains("rate limit")
}

pub fn classify_error(e: genai::Error) -> LlmError {
  if e.to_string().contains("refused") {
    LlmError::Refusal
  } else {
    LlmError::Genai(e)
  }
}
