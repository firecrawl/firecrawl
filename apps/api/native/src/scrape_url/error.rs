use std::{error::Error, fmt::Display};

#[derive(Debug, Clone)]
pub enum ScrapeURLError {
  CrawlDenialError,
  IndexMissError,
  LockdownMissError,
  AgentIndexOnlyError,
  ReliableRetrievalError,
  InsecureConnectionError,
  InvalidURLError,
}

impl Display for ScrapeURLError {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    match self {
      Self::CrawlDenialError => f.write_str("CRAWL_DENIAL_ERROR"),
      Self::IndexMissError => f.write_str("INDEX_MISS_ERROR"),
      Self::LockdownMissError => f.write_str("LOCKDOWN_MISS_ERROR"),
      Self::AgentIndexOnlyError => f.write_str("AGENT_INDEX_ONLY_ERROR"),
      Self::ReliableRetrievalError => f.write_str("RELIABLE_RETRIEVAL_ERROR"),
      Self::InsecureConnectionError => f.write_str("INSECURE_CONNECTION_ERROR"),
      Self::InvalidURLError => f.write_str("INVALID_URL_ERROR"),
    }
  }
}
impl Error for ScrapeURLError {}
