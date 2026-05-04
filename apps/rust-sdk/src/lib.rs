//! Firecrawl Rust SDK
//!
//! This SDK provides access to the Firecrawl v2 API for web scraping, crawling,
//! searching, mapping, batch scraping, and agent operations.
//!
//! # Quick Start
//!
//! ```no_run
//! use firecrawl::Client;
//!
//! #[tokio::main]
//! async fn main() -> Result<(), Box<dyn std::error::Error>> {
//!     let client = Client::new("your-api-key")?;
//!     let document = client.scrape("https://example.com", None).await?;
//!     println!("{:?}", document.markdown);
//!     Ok(())
//! }
//! ```

pub mod error;
pub(crate) mod serde_helpers;

mod agent;
mod batch_scrape;
mod client;
mod crawl;
mod map;
mod monitor;
mod parse;
mod scrape;
mod search;
mod types;

pub use agent::*;
pub use batch_scrape::*;
pub use client::Client;
pub use crawl::*;
pub use error::FirecrawlError;
pub use map::*;
pub use monitor::*;
pub use parse::*;
pub use scrape::*;
pub use search::*;
pub use types::*;
