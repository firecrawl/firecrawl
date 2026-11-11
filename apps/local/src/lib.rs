//! Firecrawl Local: the local primitive behind `firecrawl scrape|crawl|map`.
//!
//! The HTML cleaning, link extraction, metadata and crawl-filter modules are
//! compiled directly from `apps/api/native/src`, the same Rust the cloud API
//! loads through N-API. One source of truth means a page cleaned locally and a
//! page cleaned in the cloud go through identical code.
//!
//! A published crate carries a copy of those files in `src/native` (see
//! `build.rs` and `scripts/vendor-native.sh`).

#![allow(dead_code)]

#[cfg_attr(not(vendored_native), path = "../../api/native/src/utils.rs")]
#[cfg_attr(vendored_native, path = "native/utils.rs")]
mod utils;
#[cfg_attr(not(vendored_native), path = "../../api/native/src/xml.rs")]
#[cfg_attr(vendored_native, path = "native/xml.rs")]
mod xml;

#[cfg_attr(not(vendored_native), path = "../../api/native/src/html.rs")]
#[cfg_attr(vendored_native, path = "native/html.rs")]
pub mod html;

#[cfg_attr(not(vendored_native), path = "../../api/native/src/crawler.rs")]
#[cfg_attr(vendored_native, path = "native/crawler.rs")]
pub mod crawler;

#[cfg_attr(not(vendored_native), path = "../../api/native/src/document.rs")]
#[cfg_attr(vendored_native, path = "native/document.rs")]
pub mod document;

pub mod browser;
pub mod cloud;
pub mod crawl;
pub mod documents;
pub mod fetch;
pub mod guard;
pub mod init;
pub mod login;
pub mod markdown;
pub mod mem;
pub mod netguard;
pub mod scrape;
pub mod serve;
