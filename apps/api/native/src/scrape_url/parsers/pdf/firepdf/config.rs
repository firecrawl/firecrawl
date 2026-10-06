use std::{collections::HashSet, sync::LazyLock};

fn env_string(name: &str) -> Option<String> {
  std::env::var(name).ok().filter(|x| !x.trim().is_empty())
}

/// zod `stringbool` semantics; anything unrecognized keeps the default.
fn env_bool(name: &str, default: bool) -> bool {
  match env_string(name)
    .map(|x| x.trim().to_ascii_lowercase())
    .as_deref()
  {
    Some("true" | "1" | "yes" | "on" | "y" | "enabled") => true,
    Some("false" | "0" | "no" | "off" | "n" | "disabled") => false,
    _ => default,
  }
}

fn env_percent(name: &str) -> f64 {
  env_string(name)
    .and_then(|x| x.trim().parse::<f64>().ok())
    .filter(|x| (0.0..=100.0).contains(x))
    .unwrap_or(0.0)
}

fn env_team_ids(name: &str) -> HashSet<String> {
  env_string(name)
    .map(|x| {
      x.split(',')
        .map(str::trim)
        .filter(|x| !x.is_empty())
        .map(str::to_string)
        .collect()
    })
    .unwrap_or_default()
}

/// FirePDF settings, read once from the same variables the TS API uses.
#[derive(Debug, Clone)]
pub struct FirePdfConfig {
  /// Master switch for FirePDF on requests that do not force it.
  pub enable: bool,
  pub base_url: Option<String>,
  pub api_key: Option<String>,
  /// fire-pdf answers cache lookups itself when set, and writes the entries.
  pub cache_base_url: Option<String>,
  /// Per-team refresh budget of the cache service; 0 disables `refresh`.
  pub cache_refresh_per_minute: u64,
  pub async_percent: f64,
  pub async_bulk_origin_percent: f64,
  pub async_force_team_ids: HashSet<String>,
  pub async_disable_team_ids: HashSet<String>,
  pub async_allow_request_override: bool,
  /// Long-poll `wait_ms` on `GET /jobs/:id`; 0 disables it.
  pub async_wait_ms: i64,
  pub by_reference_enable: bool,
  /// Receives large-PDF inputs for by-reference submits; must match fire-pdf's bucket.
  pub gcs_input_bucket: String,
  /// fire-engine's large-PDF handoff bucket, the allowlist for inbound references.
  pub fire_engine_pdf_gcs_bucket: Option<String>,
}

impl FirePdfConfig {
  fn from_env() -> Self {
    Self {
      enable: env_bool("FIRE_PDF_ENABLE", false),
      base_url: env_string("FIRE_PDF_BASE_URL"),
      api_key: env_string("FIRE_PDF_API_KEY"),
      cache_base_url: env_string("FIRE_PDF_CACHE_BASE_URL"),
      cache_refresh_per_minute: env_string("FIRE_PDF_CACHE_REFRESH_PER_MINUTE")
        .and_then(|x| x.trim().parse().ok())
        .unwrap_or(10),
      async_percent: env_percent("FIRE_PDF_ASYNC_PERCENT"),
      async_bulk_origin_percent: env_percent("FIRE_PDF_ASYNC_BULK_ORIGIN_PERCENT"),
      async_force_team_ids: env_team_ids("FIRE_PDF_ASYNC_FORCE_TEAM_IDS"),
      async_disable_team_ids: env_team_ids("FIRE_PDF_ASYNC_DISABLE_TEAM_IDS"),
      async_allow_request_override: env_bool("FIRE_PDF_ASYNC_ALLOW_REQUEST_OVERRIDE", false),
      async_wait_ms: env_string("FIRE_PDF_ASYNC_WAIT_MS")
        .and_then(|x| x.trim().parse::<i64>().ok())
        .filter(|x| *x >= 0)
        .unwrap_or(0),
      by_reference_enable: env_bool("FIRE_PDF_BY_REFERENCE_ENABLE", true),
      gcs_input_bucket: env_string("FIRE_PDF_GCS_INPUT_BUCKET")
        .map(|x| x.trim().to_string())
        .unwrap_or_else(|| "firecrawl-pdf-pipeline".to_string()),
      fire_engine_pdf_gcs_bucket: env_string("FIRE_ENGINE_PDF_GCS_BUCKET")
        .map(|x| x.trim().to_string()),
    }
  }

  pub fn get() -> &'static Self {
    static CONFIG: LazyLock<FirePdfConfig> = LazyLock::new(FirePdfConfig::from_env);
    &CONFIG
  }
}
