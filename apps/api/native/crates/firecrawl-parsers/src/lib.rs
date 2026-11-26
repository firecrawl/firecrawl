pub(crate) use firecrawl_crawler::xml;

pub mod document;
mod fallback;
mod formats;
mod magic;
pub mod pdf;
mod pdf_local;
mod raw;
mod sniff;

#[cfg(test)]
mod properties;

pub use document::*;
pub use pdf::*;
pub use raw::parse_raw_document;
