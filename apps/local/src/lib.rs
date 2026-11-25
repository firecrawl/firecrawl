//! Firecrawl Local: the local primitive behind `firecrawl scrape|crawl|map`.
//!
//! The HTML cleaning, link extraction, metadata, crawl-filter, and document
//! conversion modules come directly from the pure-Rust workspace crates under
//! `apps/api/native/crates`, sharing one source of truth with the API.
//!
//! A published crate carries a vendored copy of those modules in `src/native`
//! (see `build.rs` and `scripts/vendor-native.sh`).

#![allow(dead_code)]

#[cfg(not(vendored_native))]
pub use firecrawl_crawler::crawler;
#[cfg(not(vendored_native))]
pub use firecrawl_html::html;
#[cfg(not(vendored_native))]
pub use firecrawl_parsers::document;

// Declared through a macro so `cargo fmt` does not try to load the gitignored
// `src/native/*.rs` files when they are absent in normal repository checkouts.
#[cfg(vendored_native)]
macro_rules! declare_vendored_native {
  () => {
    #[path = "native/crawler.rs"]
    pub mod crawler;
    #[path = "native/document.rs"]
    pub mod document;
    #[path = "native/markdown/mod.rs"]
    pub(crate) mod firecrawl_markdown;
    #[path = "native/html.rs"]
    pub mod html;
    #[path = "native/xml.rs"]
    mod xml;
  };
}

#[cfg(vendored_native)]
declare_vendored_native!();

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
