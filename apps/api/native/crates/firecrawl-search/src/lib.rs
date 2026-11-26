//! Pure-Rust search utilities: DuckDuckGo HTML parsing, search operator
//! parsing/planning/matching, and category query building.

mod ddg;
mod operator_match;
mod operators;
mod query_builder;
mod text;

pub use ddg::{DdgParseResult, DdgSearchResult, clean_ddg_url, parse_ddg_html};
pub use operator_match::{matches_domains, matches_query_operators};
pub use operators::{
  OperatorPlan, QueryOperators, parse_query_operators, plan_operator_query, site_hostnames,
  uses_search_syntax,
};
pub use query_builder::{
  DEFAULT_RESEARCH_SITES, SearchCategoryEntry, SearchCategoryInput, SearchQueryBuildResult,
  build_search_query, get_category_from_url, get_default_research_sites,
};
