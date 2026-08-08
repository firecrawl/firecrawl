use std::sync::LazyLock;

use super::PdfResult;

static FIRE_PDF_BASE_URL: LazyLock<Option<String>> = LazyLock::new(|| {
  if let Some(url) = std::env::var("FIRE_PDF_BASE_URL").ok()
    && !url.is_empty()
  {
    Some(url)
  } else {
    None
  }
});

pub struct FirePDF {
  base_url: &'static String,
}

impl FirePDF {
  pub fn get() -> Option<Self> {
    FIRE_PDF_BASE_URL.as_ref().map(|base_url| Self { base_url })
  }

  pub async fn process(&self) -> PdfResult {
    unimplemented!()
  }
}
