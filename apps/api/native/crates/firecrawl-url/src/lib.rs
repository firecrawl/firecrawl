//! Pure-Rust URL, hostname, public suffix, SERP, and engine-forcing utilities.

mod engine_forcing;
mod extract;
mod psl_lookup;
mod serp;
mod url_utils;

pub use engine_forcing::{
  EngineForcingMatcher, domain_matches_pattern, extract_forcing_domain,
  match_engine_forcing_pattern,
};
pub use serp::{SerpEngine, SerpPage, detect_serp_page};
pub use url_utils::{
  ParsedHostname, extract_base_domain, has_reachable_host, is_base_domain, parse_hostname,
  parse_url,
};
