use serde::{Deserialize, Serialize};

use super::formats::ScreenshotOptionsViewport;

#[derive(Serialize, Deserialize, Default, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub enum ActionScrollDirection {
  Up,

  #[default]
  Down,
}

fn default_scale() -> f64 {
  1.
}

#[derive(Serialize, Deserialize, Default, Clone, Copy)]
pub enum ActionPdfFormat {
  A0,
  A1,
  A2,
  A3,
  A4,
  A5,
  A6,

  #[default]
  Letter,

  Legal,
  Tabloid,
  Ledger,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(untagged, deny_unknown_fields)]
pub enum WaitAction {
  Selector { selector: String },
  Milliseconds { milliseconds: i32 },
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Action {
  Wait(WaitAction),
  Click {
    selector: String,
    #[serde(default)]
    all: bool,
  },
  Screenshot {
    full_page: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    quality: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    viewport: Option<ScreenshotOptionsViewport>,
  },
  Write {
    text: String,
  },
  Press {
    key: String,
  },
  Scroll {
    #[serde(default)]
    direction: ActionScrollDirection,

    selector: Option<String>,
  },
  Scrape,
  ExecuteJavascript {
    script: String,
  },
  Pdf {
    #[serde(default)]
    landscape: bool,

    #[serde(default = "default_scale")]
    scale: f64,

    #[serde(default)]
    format: ActionPdfFormat,
  },

  #[serde(skip_deserializing)] // internal only
  GetCookies,
}

#[derive(Serialize)]
pub struct InternalActionMetadata {
  #[serde(skip_serializing_if = "Option::is_none")]
  pub __firecrawl_internal: Option<bool>,
}

#[derive(Serialize)]
pub struct InternalAction {
  #[serde(flatten)]
  pub action: Action,

  #[serde(skip_serializing_if = "Option::is_none")]
  pub metadata: Option<InternalActionMetadata>,
}

impl From<InternalAction> for Action {
  fn from(value: InternalAction) -> Self {
    value.action
  }
}

impl From<Action> for InternalAction {
  fn from(value: Action) -> Self {
    Self {
      action: value,
      metadata: None,
    }
  }
}

impl Action {
  pub fn is_renderless_safe(&self) -> bool {
    matches!(
      self,
      Action::Wait(_)
        | Action::Click { .. }
        | Action::Write { .. }
        | Action::Press { .. }
        | Action::Scroll { .. }
        | Action::Scrape
        | Action::ExecuteJavascript { .. }
    )
  }
}

impl InternalAction {
  pub fn is_renderless_safe(&self) -> bool {
    self.action.is_renderless_safe()
  }
}
