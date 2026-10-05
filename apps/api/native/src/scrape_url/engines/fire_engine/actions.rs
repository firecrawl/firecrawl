use serde::Deserialize;
use url::Url;

use super::super::super::raw_page::BrowserCookie;

#[derive(Deserialize)]
#[serde(untagged)]
pub enum FireEngineActionResultScrape {
  Html { html: String },
  Accessibility { accessibility: String },
}

#[derive(Deserialize)]
#[serde(tag = "type", content = "result", rename_all = "camelCase")]
pub enum FireEngineActionResultKind {
  Screenshot {
    path: Url,
  },
  Scrape {
    url: String,
    #[serde(flatten)]
    scrape: FireEngineActionResultScrape,
  },
  ExecuteJavascript {
    r#return: String,
  },
  Pdf {
    link: Url,
  },
  GetCookies {
    cookies: Vec<BrowserCookie>,
  },
}

#[derive(Deserialize)]
pub struct FireEngineActionResult {
  pub idx: usize,

  #[serde(flatten)]
  pub kind: FireEngineActionResultKind,
}
