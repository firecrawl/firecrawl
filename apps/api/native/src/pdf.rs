use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[napi(object)]
pub struct PDFMetadata {
  pub num_pages: i32,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub title: Option<String>,
}

fn _get_pdf_metadata(path: &str) -> std::result::Result<PDFMetadata, String> {
  let doc = match lopdf::Document::load(path) {
    Ok(x) => x,
    Err(_) => {
      return Err("Failed to load PDF".to_string());
    }
  };

  let num_pages = doc.get_pages().len() as i32;

  let title = doc
    .trailer
    .get(b"Info")
    .and_then(|info| {
      info
        .as_dict()
        .and_then(|info| info.get(b"Title"))
        .and_then(|title| {
          title
            .as_str()
            .map(|s| String::from_utf8_lossy(s).to_string())
        })
    })
    .ok()
    .or_else(|| {
      doc.objects.iter().find_map(|(_i, obj)| {
        obj
          .as_dict()
          .and_then(|obj| obj.get(b"Title"))
          .and_then(|title| title.as_str())
          .map(|s| String::from_utf8_lossy(s).to_string())
          .ok()
      })
    })
    .map(|x| {
      x.trim_matches(|x| char::is_whitespace(x) || x == '\0')
        .to_string()
    });

  Ok(PDFMetadata { num_pages, title })
}

/// Extract metadata from PDF file.
#[napi]
pub fn get_pdf_metadata(path: String) -> Result<PDFMetadata> {
  _get_pdf_metadata(&path).map_err(|e| {
    Error::new(
      Status::GenericFailure,
      format!("Failed to get PDF metadata: {}", e),
    )
  })
}
