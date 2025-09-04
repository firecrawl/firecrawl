#![deny(clippy::all)]

pub use crate::crawler::*;
pub use crate::html::*;
pub use crate::pdf::*;
pub use crate::utils::*;

mod crawler;
mod html;
mod pdf;
mod utils;

pub use napi::bindgen_prelude::*;
pub use serde::{Deserialize, Serialize};
