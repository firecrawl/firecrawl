use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::formats::ScreenshotOptionsViewport;

#[derive(Debug, Serialize, Deserialize, Default, Clone, Copy, TS)]
#[serde(rename_all = "camelCase")]
pub enum ActionScrollDirection {
  Up,

  #[default]
  Down,
}

fn default_scale() -> f64 {
  1.
}

#[derive(Debug, Serialize, Deserialize, Default, Clone, Copy, TS)]
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

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(untagged, deny_unknown_fields)]
pub enum WaitAction {
  Selector { selector: String },
  Milliseconds { milliseconds: i32 },
}

#[derive(Debug, Serialize, Deserialize, Clone, TS)]
#[serde(
  tag = "type",
  rename_all = "camelCase",
  rename_all_fields = "camelCase"
)]
pub enum Action {
  // Exactly one key is accepted; the TS type is looser to match the zod output.
  Wait(#[ts(type = "{ milliseconds?: number, selector?: string }")] WaitAction),
  Click {
    selector: String,
    #[serde(default)]
    #[ts(as = "Option<_>", optional)]
    all: bool,
  },
  Screenshot {
    #[serde(default)]
    #[ts(as = "Option<_>", optional)]
    full_page: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    quality: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
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
    #[ts(as = "Option<_>", optional)]
    direction: ActionScrollDirection,

    #[ts(optional = nullable)]
    selector: Option<String>,
  },
  Scrape,
  ExecuteJavascript {
    script: String,
  },
  Pdf {
    #[serde(default)]
    #[ts(as = "Option<_>", optional)]
    landscape: bool,

    #[serde(default = "default_scale")]
    #[ts(as = "Option<_>", optional)]
    scale: f64,

    #[serde(default)]
    #[ts(as = "Option<_>", optional)]
    format: ActionPdfFormat,
  },

  #[serde(skip_deserializing)] // internal only
  #[ts(skip)]
  GetCookies,
}

#[derive(Debug, Serialize)]
pub struct InternalActionMetadata {
  #[serde(skip_serializing_if = "Option::is_none")]
  pub __firecrawl_internal: Option<bool>,
}

#[derive(Debug, Serialize)]
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
