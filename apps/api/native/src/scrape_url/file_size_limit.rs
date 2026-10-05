use std::{collections::HashSet, sync::LazyLock};

use super::meta::Meta;

static PDF_BY_REFERENCE_MAX_BYTES_DEFAULT: LazyLock<usize> = LazyLock::new(|| {
  if let Ok(n) = std::env::var("PDF_BY_REFERENCE_MAX_BYTES_DEFAULT")
    && let Ok(n) = n.trim().parse::<usize>()
  {
    n
  } else {
    50 * 1024 * 1024
  }
});

static PDF_BY_REFERENCE_MAX_BYTES_PRIVILEGED: LazyLock<usize> = LazyLock::new(|| {
  if let Ok(n) = std::env::var("PDF_BY_REFERENCE_MAX_BYTES_PRIVILEGED")
    && let Ok(n) = n.trim().parse::<usize>()
  {
    n
  } else {
    256 * 1024 * 1024
  }
});

static PDF_BY_REFERENCE_PRIVILEGED_TEAM_IDS: LazyLock<HashSet<String>> = LazyLock::new(|| {
  std::env::var("PDF_BY_REFERENCE_PRIVILEGED_TEAM_IDS")
    .map(|s| {
      s.split(',')
        .map(str::trim)
        .filter(|x| !x.is_empty())
        .map(str::to_string)
        .collect()
    })
    .unwrap_or_default()
});

/// The architectural ceiling for any PDF: fire-pdf's by-reference input limit.
pub const FIRE_PDF_BY_REFERENCE_MAX_FILE_SIZE: usize = 256 * 1024 * 1024;

impl Meta {
  /// The team's large-PDF byte limit: the privileged cap for teams with the `largePdfs`
  /// flag or on the env allowlist, the default cap otherwise. Every acquisition path
  /// (fire-engine's `pdfMaxSize`, the handoff download, the by-reference placements) enforces it.
  pub fn file_size_limit(&self) -> usize {
    let privileged = self
      .internal_options
      .team_flags
      .as_ref()
      .is_some_and(|flags| flags.large_pdfs == Some(true))
      || (!self.team_id.is_empty() && PDF_BY_REFERENCE_PRIVILEGED_TEAM_IDS.contains(&self.team_id));
    let raw = if privileged {
      *PDF_BY_REFERENCE_MAX_BYTES_PRIVILEGED
    } else {
      *PDF_BY_REFERENCE_MAX_BYTES_DEFAULT
    };
    raw.clamp(1, FIRE_PDF_BY_REFERENCE_MAX_FILE_SIZE)
  }
}
