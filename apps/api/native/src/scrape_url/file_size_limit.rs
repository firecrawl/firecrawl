use std::{collections::HashSet, sync::LazyLock};

use crate::scrape_url::meta::Meta;

static PDF_BY_REFERENCE_MAX_BYTES_DEFAULT: LazyLock<usize> = LazyLock::new(|| {
  if let Some(n) = std::env::var("PDF_BY_REFERENCE_MAX_BYTES_DEFAULT").ok()
    && !n.is_empty()
    && let Ok(n) = n.parse::<usize>()
  {
    n
  } else {
    50 * 1024 * 1024
  }
});

static PDF_BY_REFERENCE_MAX_BYTES_PRIVILEGED: LazyLock<usize> = LazyLock::new(|| {
  if let Some(n) = std::env::var("PDF_BY_REFERENCE_MAX_BYTES_PRIVILEGED").ok()
    && !n.is_empty()
    && let Ok(n) = n.parse::<usize>()
  {
    n
  } else {
    200 * 1024 * 1024
  }
});

static PDF_BY_REFERENCE_PRIVILEGED_TEAM_IDS: LazyLock<HashSet<String>> = LazyLock::new(|| {
  if let Some(s) = std::env::var("PDF_BY_REFERENCE_PRIVILEGED_TEAM_IDS").ok() {
    s.split(",").map(|x| x.to_string()).collect()
  } else {
    HashSet::with_capacity(0)
  }
});

const FIRE_PDF_BY_REFERENCE_MAX_FILE_SIZE: usize = 256 * 1024 * 1024;

impl Meta {
  pub fn file_size_limit(&self) -> usize {
    let raw = if PDF_BY_REFERENCE_PRIVILEGED_TEAM_IDS.contains(&self.team_id) {
      *PDF_BY_REFERENCE_MAX_BYTES_PRIVILEGED
    } else {
      *PDF_BY_REFERENCE_MAX_BYTES_DEFAULT
    };

    raw.max(1).min(FIRE_PDF_BY_REFERENCE_MAX_FILE_SIZE)
  }
}
