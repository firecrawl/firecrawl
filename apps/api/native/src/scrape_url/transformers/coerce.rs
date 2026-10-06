use tracing::{Span, instrument};

use super::super::{
  document::Document, formats::FormatKind, meta::Meta, options::V1OriginalFormat,
};
use super::TransformerError;

/// Field names coerce dropped or found missing, recorded on its span.
#[derive(Default)]
struct Coercion {
  removed: Vec<&'static str>,
  missing: Vec<&'static str>,
}

impl Coercion {
  /// Drops a field whose format wasn't requested, and notes a requested one that is missing.
  fn field<T>(&mut self, field: &mut Option<T>, requested: bool, name: &'static str) {
    if !requested && field.take().is_some() {
      self.removed.push(name);
    } else if requested && field.is_none() {
      self.missing.push(name);
    }
  }
}

#[instrument(
  name = "transformers::coerce::coerce_fields_to_formats",
  skip(meta, document),
  fields(
    coerce.removed = tracing::field::Empty,
    coerce.missing = tracing::field::Empty,
    coerce.v1_original_format = tracing::field::Empty,
  ),
  err
)]
pub async fn coerce_fields_to_formats(
  meta: &Meta,
  mut document: Document,
) -> Result<Document, TransformerError> {
  use FormatKind::*;
  let has = |kind: FormatKind| meta.options.formats.contains(kind);
  let has_json = has(Json) || has(DeterministicJson);
  let has_answer = has(Question) || has(Query);
  let v1_original_format = meta.internal_options.v1_original_format;
  let mut c = Coercion::default();

  c.field(&mut document.markdown, has(Markdown), "markdown");
  c.field(&mut document.raw_html, has(RawHtml), "rawHtml");
  c.field(&mut document.raw_base64, has(RawBase64), "rawBase64");
  c.field(&mut document.html, has(Html), "html");
  c.field(&mut document.screenshot, has(Screenshot), "screenshot");
  c.field(&mut document.links, has(Links), "links");
  c.field(&mut document.images, has(Images), "images");

  // v1 requests keep the field named by v1OriginalFormat even without a json format.
  if !has_json {
    if v1_original_format != Some(V1OriginalFormat::Extract) {
      c.field(&mut document.extract, false, "extract");
    }
    if v1_original_format != Some(V1OriginalFormat::Json) {
      c.field(&mut document.json, false, "json");
    }
  } else if document.extract.is_none() && document.json.is_none() {
    c.missing.push("json");
  }

  c.field(&mut document.summary, has(Summary), "summary");
  c.field(&mut document.answer, has_answer, "answer");
  c.field(&mut document.highlights, has(Highlights), "highlights");
  c.field(&mut document.audio, has(Audio), "audio");
  c.field(&mut document.video, has(Video), "video");

  let actions_empty = document.actions.as_ref().is_some_and(|x| {
    x.screenshots.is_empty()
      && x.scrapes.is_empty()
      && x.javascript_returns.is_empty()
      && x.pdfs.is_empty()
  });
  if (meta.options.actions.is_empty() || actions_empty) && document.actions.take().is_some() {
    c.removed.push("actions");
  }

  let span = Span::current();
  if !c.removed.is_empty() {
    span.record("coerce.removed", c.removed.join(","));
  }
  if !c.missing.is_empty() {
    span.record("coerce.missing", c.missing.join(","));
  }
  if let Some(v1_original_format) = v1_original_format {
    let v1_original_format = match v1_original_format {
      V1OriginalFormat::Extract => "extract",
      V1OriginalFormat::Json => "json",
    };
    span.record("coerce.v1_original_format", v1_original_format);
  }

  Ok(document)
}
