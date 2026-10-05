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

fn large_pdf_limit_bytes(privileged: bool, default_bytes: usize, privileged_bytes: usize) -> usize {
  let raw = if privileged {
    privileged_bytes
  } else {
    default_bytes
  };
  raw.clamp(1, FIRE_PDF_BY_REFERENCE_MAX_FILE_SIZE)
}

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
    large_pdf_limit_bytes(
      privileged,
      *PDF_BY_REFERENCE_MAX_BYTES_DEFAULT,
      *PDF_BY_REFERENCE_MAX_BYTES_PRIVILEGED,
    )
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  const MB: usize = 1024 * 1024;

  #[test]
  fn privileged_teams_get_the_privileged_cap() {
    assert_eq!(large_pdf_limit_bytes(false, 50 * MB, 256 * MB), 50 * MB);
    assert_eq!(large_pdf_limit_bytes(true, 50 * MB, 256 * MB), 256 * MB);
  }

  #[test]
  fn caps_are_clamped_to_the_architectural_ceiling() {
    assert_eq!(large_pdf_limit_bytes(true, 50 * MB, 1024 * MB), 256 * MB);
    assert_eq!(large_pdf_limit_bytes(false, 0, 256 * MB), 1);
  }

  #[test]
  fn the_large_pdfs_flag_grants_the_privileged_cap() {
    let flagged = crate::scrape_url::options::InternalOptions {
      team_flags: Some(
        serde_json::from_value(serde_json::json!({"largePdfs": true, "otherFlag": 1})).unwrap(),
      ),
      ..Default::default()
    };
    let meta = Meta::new(
      "id".to_string(),
      url::Url::parse("https://example.com/a.pdf").unwrap(),
      "team-unlisted".to_string(),
      Default::default(),
      flagged,
    );
    assert_eq!(
      meta.file_size_limit(),
      *PDF_BY_REFERENCE_MAX_BYTES_PRIVILEGED
    );

    let unflagged = Meta::new(
      "id".to_string(),
      url::Url::parse("https://example.com/a.pdf").unwrap(),
      "team-unlisted".to_string(),
      Default::default(),
      Default::default(),
    );
    assert_eq!(
      unflagged.file_size_limit(),
      *PDF_BY_REFERENCE_MAX_BYTES_DEFAULT
    );
  }
}
