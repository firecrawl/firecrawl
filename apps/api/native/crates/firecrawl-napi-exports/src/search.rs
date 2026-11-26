use firecrawl_search::{
  DdgParseResult, OperatorPlan, QueryOperators, SearchCategoryEntry, SearchCategoryInput,
  SearchQueryBuildResult,
};
use napi::bindgen_prelude::{Error, Result, Status};
use tokio::task;

pub async fn parse_ddg_html(html: String, seen_urls: Vec<String>) -> Result<DdgParseResult> {
  task::spawn_blocking(move || firecrawl_search::parse_ddg_html(&html, &seen_urls))
    .await
    .map_err(|e| {
      Error::new(
        Status::GenericFailure,
        format!("parse_ddg_html join error: {e}"),
      )
    })
}

pub fn uses_search_syntax(query: String) -> bool {
  firecrawl_search::uses_search_syntax(&query)
}

pub fn parse_query_operators(query: String) -> QueryOperators {
  firecrawl_search::parse_query_operators(&query)
}

pub fn plan_operator_query(query: String) -> OperatorPlan {
  firecrawl_search::plan_operator_query(&query)
}

pub fn site_hostnames(sites: Vec<String>) -> Vec<String> {
  firecrawl_search::site_hostnames(&sites)
}

pub fn matches_domains(
  url: Option<String>,
  include_domains: Option<Vec<String>>,
  exclude_domains: Option<Vec<String>>,
) -> bool {
  let include = include_domains.unwrap_or_default();
  let exclude = exclude_domains.unwrap_or_default();
  firecrawl_search::matches_domains(url.as_deref(), &include, &exclude)
}

pub fn matches_query_operators(
  url: Option<String>,
  title: Option<String>,
  plan: &OperatorPlan,
) -> bool {
  firecrawl_search::matches_query_operators(url.as_deref(), title.as_deref(), plan)
}

pub fn get_default_research_sites() -> Vec<String> {
  firecrawl_search::get_default_research_sites()
}

pub fn build_search_query(
  base_query: String,
  categories: Option<Vec<SearchCategoryInput>>,
  include_domains: Option<Vec<String>>,
  exclude_domains: Option<Vec<String>>,
) -> SearchQueryBuildResult {
  let categories = categories.unwrap_or_default();
  let include = include_domains.unwrap_or_default();
  let exclude = exclude_domains.unwrap_or_default();
  firecrawl_search::build_search_query(&base_query, &categories, &include, &exclude)
}

pub fn get_category_from_url(
  url: String,
  category_entries: Vec<SearchCategoryEntry>,
) -> Option<String> {
  firecrawl_search::get_category_from_url(&url, &category_entries)
}

/// Emits additive search N-API structs and functions into the invoking `cdylib`.
#[macro_export]
macro_rules! export_search_napi {
  () => {
    #[derive(Debug, Clone, serde::Serialize)]
    #[napi_derive::napi(object)]
    pub struct DdgSearchResult {
      pub url: String,
      pub title: String,
      pub description: String,
    }

    #[derive(Debug, Clone, serde::Serialize)]
    #[napi_derive::napi(object)]
    pub struct DdgFormParam {
      pub name: String,
      pub value: String,
    }

    #[derive(Debug, Clone, serde::Serialize)]
    #[napi_derive::napi(object)]
    pub struct DdgParseResult {
      pub anomaly_detected: bool,
      pub results: Vec<DdgSearchResult>,
      pub next_page_params: Option<Vec<DdgFormParam>>,
    }

    #[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
    #[napi_derive::napi(object)]
    pub struct QueryOperators {
      pub sites: Vec<String>,
      pub excluded_sites: Vec<String>,
      pub inurl: Vec<String>,
      pub intitle: Vec<String>,
      pub excluded_inurl: Vec<String>,
      pub excluded_intitle: Vec<String>,
    }

    #[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
    #[napi_derive::napi(object)]
    pub struct OperatorPlan {
      pub query: String,
      pub operators: QueryOperators,
      pub relaxed: bool,
    }

    #[derive(Debug, Clone, serde::Deserialize)]
    #[napi_derive::napi(object)]
    pub struct SearchCategoryInput {
      pub category_type: String,
      pub sites: Option<Vec<String>>,
    }

    #[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
    #[napi_derive::napi(object)]
    pub struct SearchCategoryEntry {
      pub site: String,
      pub category: String,
    }

    #[derive(Debug, Clone, serde::Serialize)]
    #[napi_derive::napi(object)]
    pub struct SearchQueryBuildResult {
      pub query: String,
      pub category_entries: Vec<SearchCategoryEntry>,
    }

    /// Parse a DuckDuckGo HTML search page into results, anomaly modal flag,
    /// and next-page form parameters.
    #[napi_derive::napi]
    pub async fn parse_ddg_html(
      html: String,
      seen_urls: Vec<String>,
    ) -> napi::Result<DdgParseResult> {
      let res = $crate::search::parse_ddg_html(html, seen_urls).await?;
      Ok(DdgParseResult {
        anomaly_detected: res.anomaly_detected,
        results: res
          .results
          .into_iter()
          .map(|r| DdgSearchResult {
            url: r.url,
            title: r.title,
            description: r.description,
          })
          .collect(),
        next_page_params: res.next_page_params.map(|params| {
          params
            .into_iter()
            .map(|(name, value)| DdgFormParam { name, value })
            .collect()
        }),
      })
    }

    /// True when the query uses search syntax (quotes, `name:value`, or `OR`/`|`).
    #[napi_derive::napi]
    pub fn uses_search_syntax(query: String) -> bool {
      $crate::search::uses_search_syntax(query)
    }

    /// Parse `site:`, `inurl:`, `intitle:`, and negated operators outside quotes.
    #[napi_derive::napi]
    pub fn parse_query_operators(query: String) -> QueryOperators {
      let ops = $crate::search::parse_query_operators(query);
      QueryOperators {
        sites: ops.sites,
        excluded_sites: ops.excluded_sites,
        inurl: ops.inurl,
        intitle: ops.intitle,
        excluded_inurl: ops.excluded_inurl,
        excluded_intitle: ops.excluded_intitle,
      }
    }

    /// Plan query operator rewriting and result-side enforcement.
    #[napi_derive::napi]
    pub fn plan_operator_query(query: String) -> OperatorPlan {
      let plan = $crate::search::plan_operator_query(query);
      OperatorPlan {
        query: plan.query,
        operators: QueryOperators {
          sites: plan.operators.sites,
          excluded_sites: plan.operators.excluded_sites,
          inurl: plan.operators.inurl,
          intitle: plan.operators.intitle,
          excluded_inurl: plan.operators.excluded_inurl,
          excluded_intitle: plan.operators.excluded_intitle,
        },
        relaxed: plan.relaxed,
      }
    }

    /// Extract deduplicated hostnames from `site:` operator values.
    #[napi_derive::napi]
    pub fn site_hostnames(sites: Vec<String>) -> Vec<String> {
      $crate::search::site_hostnames(sites)
    }

    /// True when the URL host matches included domains and no excluded domain.
    #[napi_derive::napi]
    pub fn matches_domains(
      url: Option<String>,
      include_domains: Option<Vec<String>>,
      exclude_domains: Option<Vec<String>>,
    ) -> bool {
      $crate::search::matches_domains(url, include_domains, exclude_domains)
    }

    /// Evaluate a planned search operator filter against a result URL and title.
    #[napi_derive::napi]
    pub fn matches_query_operators(
      url: Option<String>,
      title: Option<String>,
      plan: OperatorPlan,
    ) -> bool {
      let core_plan = $crate::__deps::firecrawl_search::OperatorPlan {
        query: plan.query,
        operators: $crate::__deps::firecrawl_search::QueryOperators {
          sites: plan.operators.sites,
          excluded_sites: plan.operators.excluded_sites,
          inurl: plan.operators.inurl,
          intitle: plan.operators.intitle,
          excluded_inurl: plan.operators.excluded_inurl,
          excluded_intitle: plan.operators.excluded_intitle,
        },
        relaxed: plan.relaxed,
      };
      $crate::search::matches_query_operators(url, title, &core_plan)
    }

    /// Return the default research sites list.
    #[napi_derive::napi]
    pub fn get_default_research_sites() -> Vec<String> {
      $crate::search::get_default_research_sites()
    }

    /// Build a search query with category and domain filters plus site-to-category entries.
    #[napi_derive::napi]
    pub fn build_search_query(
      base_query: String,
      categories: Option<Vec<SearchCategoryInput>>,
      include_domains: Option<Vec<String>>,
      exclude_domains: Option<Vec<String>>,
    ) -> SearchQueryBuildResult {
      let core_categories = categories.map(|items| {
        items
          .into_iter()
          .map(
            |item| $crate::__deps::firecrawl_search::SearchCategoryInput {
              category_type: item.category_type,
              sites: item.sites,
            },
          )
          .collect()
      });
      let res = $crate::search::build_search_query(
        base_query,
        core_categories,
        include_domains,
        exclude_domains,
      );
      SearchQueryBuildResult {
        query: res.query,
        category_entries: res
          .category_entries
          .into_iter()
          .map(|entry| SearchCategoryEntry {
            site: entry.site,
            category: entry.category,
          })
          .collect(),
      }
    }

    /// Determine the category for a URL from an ordered site-to-category mapping.
    #[napi_derive::napi]
    pub fn get_category_from_url(
      url: String,
      category_entries: Vec<SearchCategoryEntry>,
    ) -> Option<String> {
      let core_entries = category_entries
        .into_iter()
        .map(
          |entry| $crate::__deps::firecrawl_search::SearchCategoryEntry {
            site: entry.site,
            category: entry.category,
          },
        )
        .collect();
      $crate::search::get_category_from_url(url, core_entries)
    }
  };
}
