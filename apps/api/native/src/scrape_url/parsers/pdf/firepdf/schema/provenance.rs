use serde::Deserialize;
use serde_json::Value;

/// fire-pdf's provenance stamp: who produced a result and how complete it is.
#[derive(Debug, Deserialize)]
struct ProvenanceStamp {
  generation: String,
  build_sha: String,
  #[serde(rename = "built_at")]
  _built_at: Option<String>,
  #[serde(rename = "produced_at")]
  _produced_at: String,
  #[serde(default, rename = "stages")]
  _stages: Option<Vec<String>>,
  #[serde(default)]
  quality: Option<ProvenanceQuality>,
  #[serde(default, rename = "contributing_builds")]
  _contributing_builds: Option<Vec<ProvenanceBuild>>,
}

#[derive(Debug, Deserialize)]
struct ProvenanceQuality {
  #[serde(rename = "total_pages")]
  _total_pages: u64,
  #[serde(rename = "failed_pages")]
  _failed_pages: u64,
  #[serde(rename = "partial_pages")]
  _partial_pages: u64,
  #[serde(rename = "degraded_pages")]
  _degraded_pages: u64,
  #[serde(rename = "ocr_pages")]
  _ocr_pages: u64,
}

#[derive(Debug, Deserialize)]
struct ProvenanceBuild {
  #[serde(rename = "generation")]
  _generation: String,
  #[serde(rename = "build_sha")]
  _build_sha: String,
  #[serde(rename = "built_at")]
  _built_at: Option<String>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Provenance {
  /// A build from before the stamp existed.
  Absent,
  Stamped {
    generation: String,
    build_sha: String,
    /// Without page counts the stamp says nothing about completeness.
    has_quality: bool,
  },
  Malformed(String),
}

impl Provenance {
  pub fn parse(raw: Option<&Value>) -> Self {
    match raw {
      None => Self::Absent,
      Some(Value::Null) => Self::Malformed("provenance: null".to_string()),
      Some(value) => match ProvenanceStamp::deserialize(value) {
        Ok(stamp) => Self::Stamped {
          generation: stamp.generation,
          build_sha: stamp.build_sha,
          has_quality: stamp.quality.is_some(),
        },
        Err(e) => Self::Malformed(e.to_string()),
      },
    }
  }

  /// Records the stamp on `span`, which declares `fire_pdf.provenance`,
  /// `fire_pdf.provenance_issue`, `fire_pdf.generation` and `fire_pdf.build_sha`.
  pub fn record(&self, span: &tracing::Span) {
    match self {
      Self::Absent => {
        span.record("fire_pdf.provenance", "absent");
      }
      Self::Stamped {
        generation,
        build_sha,
        has_quality,
      } => {
        let status = if *has_quality {
          "stamped"
        } else {
          "missing_quality"
        };
        span.record("fire_pdf.provenance", status);
        span.record("fire_pdf.generation", generation.as_str());
        span.record("fire_pdf.build_sha", build_sha.as_str());
      }
      Self::Malformed(issue) => {
        span.record("fire_pdf.provenance", "malformed");
        span.record("fire_pdf.provenance_issue", issue.as_str());
      }
    }
  }
}
