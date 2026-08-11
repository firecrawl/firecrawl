use serde::Deserialize;
use url::Url;

#[derive(Deserialize)]
#[serde(untagged)]
pub enum FireEngineActionResultScrape {
  Html { html: String },
  Accessibility { accessibility: String },
}

#[derive(Deserialize)]
pub struct FireEngineActionResultCookie {
  pub name: String,
  pub value: String,
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
    cookies: Vec<FireEngineActionResultCookie>,
  },
}

#[derive(Deserialize)]
pub struct FireEngineActionResult {
  pub idx: usize,

  #[serde(flatten)]
  pub kind: FireEngineActionResultKind,
}
