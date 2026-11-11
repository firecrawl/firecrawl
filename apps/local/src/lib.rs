//! Firecrawl Local: the local primitive behind `firecrawl scrape|crawl|map`.
//!
//! The HTML cleaning, link extraction, metadata and crawl-filter modules are
//! compiled directly from `apps/api/native/src`, the same Rust the cloud API
//! loads through N-API. One source of truth means a page cleaned locally and a
//! page cleaned in the cloud go through identical code.

#![allow(dead_code)]

#[path = "../../api/native/src/utils.rs"]
mod utils;
#[path = "../../api/native/src/xml.rs"]
mod xml;

#[path = "../../api/native/src/html.rs"]
pub mod html;

#[path = "../../api/native/src/crawler.rs"]
pub mod crawler;

#[path = "../../api/native/src/document.rs"]
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
