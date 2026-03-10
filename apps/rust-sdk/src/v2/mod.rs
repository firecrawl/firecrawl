//! Firecrawl API v2 client module.
//!
//! This module provides access to the v2 API endpoints while maintaining
//! backward compatibility with v1. The v2 API includes new features like
//! the Agent endpoint and improved options.
//!
//! # Example
//!
//! ```no_run
//! use firecrawl::v2::{Client, ScrapeOptions};
//!
//! #[tokio::main]
//! async fn main() -> Result<(), Box<dyn std::error::Error>> {
//!     let client = Client::new("your-api-key")?;
//!
//!     // Scrape a URL
//!     let document = client.scrape("https://example.com", None).await?;
//!     println!("Content: {:?}", document.markdown);
//!
//!     Ok(())
//! }
//! ```

mod agent;
mod batch_scrape;
mod client;
mod crawl;
mod map;
mod scrape;
mod search;
mod types;

pub use agent::*;
pub use batch_scrape::*;
pub use client::Client;
pub use crawl::*;
pub use map::*;
pub use scrape::*;
pub use search::*;
pub use types::*;
