use std::{fmt::Debug, time::Duration};

use chrono::{DateTime, Utc};
use redis::{AsyncTypedCommands, aio::MultiplexedConnection};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::sync::{Mutex, OnceCell};
use tracing::instrument;
use uuid::Uuid;

use super::super::super::error::ScrapeURLError;
use super::{
  IndexEntryFilter, IndexEntryVariant,
  db::{IndexEntry, MaxAgeRow},
};

static INDEX_CACHE: OnceCell<Option<Mutex<MultiplexedConnection>>> = OnceCell::const_new();

pub struct IndexCache(&'static Mutex<MultiplexedConnection>);

impl Debug for IndexCache {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    f.write_str("IndexCache")
  }
}

impl IndexEntryVariant {
  fn to_redis_hash(&self) -> String {
    let payload = serde_json::to_string(&Value::Array(vec![
      Value::String(hex::encode(&self.url_hash)),
      Value::Bool(self.is_mobile),
      Value::Bool(self.block_ads),
      Value::Bool(self.is_stealth),
      self
        .location_country
        .clone()
        .map(Value::String)
        .unwrap_or(Value::Null),
      if !self.location_languages.is_empty() {
        Value::Array(
          self
            .location_languages
            .iter()
            .map(|x| Value::String(x.clone()))
            .collect(),
        )
      } else {
        Value::Null
      },
    ]))
    .unwrap();

    hex::encode(Sha256::digest(payload))
  }

  fn to_redis_key(&self) -> String {
    format!("idxc:{}", self.to_redis_hash())
  }

  fn to_redis_negative_key(&self) -> String {
    format!("idxcnegv2:{}", self.to_redis_hash())
  }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexNegativeCacheEntry {
  #[serde(with = "chrono::serde::ts_milliseconds")]
  pub empty_from: DateTime<Utc>,

  pub screenshot: bool,
  pub screenshot_fullscreen: bool,
  pub wait_for: i32,
}

pub enum IndexCacheResult {
  PositiveHit(Vec<IndexEntry>),
  NegativeHit,
  Miss,
}

impl IndexEntryFilter {
  fn evaluate_entry(&self, entry: &IndexEntry) -> bool {
    entry.created_at >= self.now - Duration::from_millis(self.max_age as u64)
      && self
        .min_age
        .map(|min_age| entry.created_at <= self.now - Duration::from_millis(min_age as u64))
        .unwrap_or(true)
      && (entry.has_screenshot || !self.needs_screenshot)
      && (entry.has_screenshot_fullscreen || !self.needs_screenshot_fullscreen)
      && (self.wait_time_ms <= entry.wait_time_ms)
  }
}

impl IndexCache {
  #[instrument(name = "IndexCache::init", err)]
  async fn init() -> Result<Option<Mutex<MultiplexedConnection>>, ScrapeURLError> {
    let Some(url) = std::env::var("INDEX_CACHE_REDIS_URL")
      .ok()
      .filter(|x| !x.is_empty())
    else {
      return Ok(None);
    };

    let client = redis::Client::open(url)?;

    Ok(Some(Mutex::new(
      client.get_multiplexed_async_connection().await?,
    )))
  }

  pub async fn get() -> Option<Self> {
    INDEX_CACHE
      .get_or_try_init(Self::init)
      .await
      .ok()
      .and_then(|x| x.as_ref())
      .map(Self)
  }

  #[instrument(name = "IndexCache::get_max_age", err)]
  pub async fn get_max_age(&self, domain_hash: &[u8]) -> Result<Option<i32>, ScrapeURLError> {
    let unparsed = {
      // TODO: timeout
      let mut index_cache = self.0.lock().await;

      index_cache
        .get(format!("idxma:{}", hex::encode(domain_hash)))
        .await?
    };

    Ok(
      unparsed
        .map(|x| serde_json::from_str::<MaxAgeRow>(&x))
        .transpose()?
        .and_then(|x| x.max_age),
    )
  }

  #[instrument(name = "IndexCache::set_max_age", err)]
  pub async fn set_max_age(&self, domain_hash: &[u8], max_age: i32) -> Result<(), ScrapeURLError> {
    let mut index_cache = self.0.lock().await;
    // TODO: timeout
    index_cache
      .set_ex(
        format!("idxma:{}", hex::encode(domain_hash)),
        serde_json::to_string(&MaxAgeRow {
          max_age: Some(max_age),
        })?,
        15 * 60,
      )
      .await?;
    Ok(())
  }

  #[instrument(name = "IndexCache::_get_negative_hit", err)]
  async fn _get_negative_hit(
    &self,
    variant: &IndexEntryVariant,
    filter: &IndexEntryFilter,
  ) -> Result<bool, ScrapeURLError> {
    let key = variant.to_redis_negative_key();

    let unparsed = {
      // TODO: timeout
      let mut index_cache = self.0.lock().await;

      index_cache.get(&key).await?
    };

    let parsed: Option<IndexNegativeCacheEntry> = unparsed
      .map(|unparsed| serde_json::from_str(&unparsed))
      .transpose()?;

    Ok(
      parsed
        .map(|x| {
          filter.now - Duration::from_millis(filter.max_age as u64) >= x.empty_from
          && (!x.screenshot || filter.needs_screenshot) // Only take a screenshotless negative hit as truly negative if we need a screenshot too
          && (!x.screenshot_fullscreen || filter.needs_screenshot_fullscreen) // Only take a fullscreenshotless negative hit as truly negative if we need a fullscreenshot too
          && x.wait_for <= filter.wait_time_ms
        })
        .unwrap_or(false),
    )
  }

  #[instrument(name = "IndexCache::get_entries", err)]
  pub async fn get_entries(
    &self,
    variant: &IndexEntryVariant,
    filter: &IndexEntryFilter,
  ) -> Result<IndexCacheResult, ScrapeURLError> {
    let key = variant.to_redis_key();

    let unparsed = {
      // TODO: timeout
      let mut index_cache = self.0.lock().await;

      index_cache.hgetall(&key).await?
    };

    let mut parsed = unparsed
      .values()
      .map(|x| serde_json::from_str::<IndexEntry>(x))
      .collect::<Result<Vec<_>, _>>()?
      .into_iter()
      .filter(|x| filter.evaluate_entry(x))
      .collect::<Vec<_>>();

    if !parsed.is_empty() {
      parsed.sort_unstable_by_key(|x| std::cmp::Reverse(x.created_at));
      parsed.truncate(5);
      Ok(IndexCacheResult::PositiveHit(parsed))
    } else if filter.min_age.is_none() && self._get_negative_hit(variant, filter).await? {
      Ok(IndexCacheResult::NegativeHit)
    } else {
      Ok(IndexCacheResult::Miss)
    }
  }

  #[instrument(name = "IndexCache::upsert_entries", err)]
  pub async fn upsert_entries(
    &self,
    variant: &IndexEntryVariant,
    entries: &[IndexEntry],
  ) -> Result<(), ScrapeURLError> {
    let key = variant.to_redis_key();

    let map: Vec<(String, String)> = entries
      .iter()
      .map(|x| serde_json::to_string(x).map(|y| (x.id.to_string(), y)))
      .collect::<Result<Vec<_>, _>>()?;

    let hlen: i32 = {
      // TODO: timeout
      let mut index_cache = self.0.lock().await;

      redis::pipe()
        .hset_multiple(&key, map.as_slice())
        .ignore()
        .expire(&key, 7 * 24 * 60 * 60)
        .ignore()
        .del(variant.to_redis_negative_key())
        .ignore()
        .hlen(&key)
        .query_async(&mut *index_cache)
        .await?
    };

    if hlen > 32 {
      let unparsed = {
        // TODO: timeout
        let mut index_cache = self.0.lock().await;

        index_cache.hgetall(&key).await?
      };

      let mut parsed: Vec<(String, DateTime<Utc>)> = unparsed
        .into_iter()
        .map(|(id, entry)| serde_json::from_str::<IndexEntry>(&entry).map(|x| (id, x.created_at)))
        .collect::<Result<Vec<_>, _>>()?;

      parsed.sort_by(|(_, a), (_, b)| b.cmp(a));
      let to_delete: Vec<String> = parsed.into_iter().skip(32).map(|(id, _)| id).collect();

      {
        // TODO: timeout
        let mut index_cache = self.0.lock().await;

        index_cache.hdel(&key, to_delete.as_slice()).await?;
      }
    }

    Ok(())
  }

  #[instrument(name = "IndexCache::delete_entry", err)]
  pub async fn delete_entry(
    &self,
    variant: &IndexEntryVariant,
    id: Uuid,
  ) -> Result<(), ScrapeURLError> {
    let key = variant.to_redis_key();

    {
      // TODO: timeout
      let mut index_cache = self.0.lock().await;

      index_cache.hdel(&key, id.to_string()).await?;
    }

    Ok(())
  }

  #[instrument(name = "IndexCache::set_negative", err)]
  pub async fn set_negative(
    &self,
    variant: &IndexEntryVariant,
    filter: &IndexEntryFilter,
    empty_from: DateTime<Utc>,
  ) -> Result<(), ScrapeURLError> {
    let key = variant.to_redis_negative_key();

    {
      // TODO: timeout
      let mut index_cache = self.0.lock().await;

      index_cache
        .set_ex(
          &key,
          serde_json::to_string(&IndexNegativeCacheEntry {
            empty_from,
            screenshot: filter.needs_screenshot,
            screenshot_fullscreen: filter.needs_screenshot_fullscreen,
            wait_for: filter.wait_time_ms,
          })?,
          600,
        )
        .await?;
    }

    Ok(())
  }
}
