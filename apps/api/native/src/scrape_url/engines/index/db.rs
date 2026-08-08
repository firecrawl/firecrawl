use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{PgPool, postgres::PgPoolOptions, prelude::FromRow};
use tokio::sync::OnceCell;

use super::{IndexEntryFilter, IndexEntryVariant};

#[derive(FromRow, Deserialize, Serialize)]
pub struct MaxAgeRow {
  pub max_age: Option<i32>,
}

#[derive(FromRow, Deserialize, Serialize)]
pub struct IndexEntry {
  pub id: String,
  pub created_at: DateTime<Utc>,
  pub status: i32,
  pub has_screenshot: bool,
  pub has_screenshot_fullscreen: bool,

  #[serde(default)]
  pub wait_time_ms: i32,
}

static INDEX_DB: OnceCell<Option<PgPool>> = OnceCell::const_new();

pub struct IndexDb(&'static PgPool);

impl IndexDb {
  pub async fn get() -> Option<Self> {
    INDEX_DB
      .get_or_init(|| async {
        if let Some(index_database_url) = std::env::var("INDEX_DATABASE_URL").ok()
          && !index_database_url.is_empty()
        {
          Some(
            PgPoolOptions::new()
              .min_connections(0)
              .max_connections(6)
              .connect(&index_database_url)
              .await
              .expect("Failed to connect to index DB"),
          )
        } else {
          None
        }
      })
      .await
      .as_ref()
      .map(Self)
  }

  pub async fn get_max_age(&self, domain_hash: &[u8]) -> Option<i32> {
    (sqlx::query_as(r#"select max_age from query_max_age(i_domain_hash => $1)"#)
      .bind(domain_hash)
      .fetch_optional(self.0)
      .await // TODO: timeout
      .ok() // TODO: error handling
      .flatten() as Option<MaxAgeRow>)
      .map(|x| x.max_age)
      .flatten()
  }

  pub async fn get_entries(
    &self,
    variant: &IndexEntryVariant,
    filter: &IndexEntryFilter,
  ) -> Vec<IndexEntry> {
    sqlx::query_as(r#"
      select id, created_at, status, has_screenshot, has_screenshot_fullscreen, COALESCE(wait_time_ms, 0)
      from index_get_recent_5(
        p_url_hash => $1,
        p_max_age_ms => $2,
        p_is_mobile => $3,
        p_block_ads => $4,
        p_feature_screenshot => $5,
        p_feature_screenshot_fullscreen => $6,
        p_location_country => $7,
        p_location_languages => $8::text[],
        p_wait_time_ms => $9,
        p_is_stealth => $10,
        p_min_age_ms => $11
      )
    "#)
      .bind(variant.url_hash.as_slice())
      .bind(filter.max_age)
      .bind(variant.is_mobile)
      .bind(variant.block_ads)
      .bind(filter.needs_screenshot)
      .bind(filter.needs_screenshot_fullscreen)
      .bind(&variant.location_country)
      .bind(if variant.location_languages.is_empty() { None } else { Some(&variant.location_languages) })
      .bind(filter.wait_time_ms)
      .bind(variant.is_stealth)
      .bind(filter.min_age)
      .fetch_all(self.0)
      .await // TODO: timeout
      .ok().unwrap_or_else(|| Vec::with_capacity(0)) // TODO: error handling
  }
}
