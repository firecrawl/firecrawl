use std::time::Duration;

use chrono::{DateTime, Utc};
use redis::{AsyncTypedCommands, aio::MultiplexedConnection};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::sync::{Mutex, OnceCell};
use uuid::Uuid;

use crate::scrape_url::engines::index::IndexEntryFilter;

use super::{
  IndexEntryVariant,
  db::{IndexEntry, MaxAgeRow},
};

static INDEX_CACHE: OnceCell<Option<Mutex<MultiplexedConnection>>> = OnceCell::const_new();

pub struct IndexCache(&'static Mutex<MultiplexedConnection>);

impl IndexEntryVariant {
  fn to_redis_hash(&self) -> String {
    let payload = serde_json::to_string(&Value::Array(vec![
      Value::String(hex::encode(&self.url_hash)),
      Value::Bool(self.is_mobile),
      Value::Bool(self.block_ads),
      Value::Bool(self.is_stealth),
      Value::String(self.location_country.clone()),
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
  pub async fn get() -> Option<Self> {
    INDEX_CACHE
      .get_or_init(|| async {
        if let Some(index_cache_redis_url) = std::env::var("INDEX_CACHE_REDIS_URL").ok()
          && !index_cache_redis_url.is_empty()
        {
          Some(Mutex::new(
            redis::Client::open(index_cache_redis_url)
              .expect("Failed to connect to Redis")
              .get_multiplexed_async_connection()
              .await
              .expect("Failed to connect to Redis"),
          ))
        } else {
          None
        }
      })
      .await
      .as_ref()
      .map(Self)
  }

  pub async fn get_max_age(&self, domain_hash: &[u8]) -> Option<i32> {
    let unparsed = {
      // TODO: timeout
      let mut index_cache = self.0.lock().await;

      index_cache
        .get(format!("idxma:{}", hex::encode(domain_hash)))
        .await
        .ok() // TODO: log error
        .flatten()
    };

    unparsed
      .and_then(|x| serde_json::from_str::<MaxAgeRow>(&x).ok())
      .map(|x| x.max_age)
      .flatten()
  }

  pub async fn set_max_age(&self, domain_hash: &[u8], max_age: i32) {
    let mut index_cache = self.0.lock().await;
    // TODO: timeout
    let _ = index_cache
      .set_ex(
        format!("idxma:{}", hex::encode(domain_hash)),
        serde_json::to_string(&MaxAgeRow {
          max_age: Some(max_age),
        })
        .unwrap(),
        15 * 60,
      )
      .await; // TODO: error logging
  }

  async fn _get_negative_hit(
    &self,
    variant: &IndexEntryVariant,
    filter: &IndexEntryFilter,
  ) -> bool {
    let key = variant.to_redis_negative_key();

    let unparsed = {
      // TODO: timeout
      let mut index_cache = self.0.lock().await;

      index_cache.get(&key).await.ok().flatten() // TODO: log error
    };

    let parsed: Option<IndexNegativeCacheEntry> =
      unparsed.and_then(|unparsed| serde_json::from_str(&unparsed).ok()); // TODO: log error

    parsed
      .map(|x| {
        filter.now - Duration::from_millis(filter.max_age as u64) >= x.empty_from
          && (!x.screenshot || filter.needs_screenshot) // Only take a screenshotless negative hit as truly negative if we need a screenshot too
          && (!x.screenshot_fullscreen || filter.needs_screenshot_fullscreen) // Only take a fullscreenshotless negative hit as truly negative if we need a fullscreenshot too
          && x.wait_for <= filter.wait_time_ms
      })
      .unwrap_or(false)
  }

  pub async fn get_entries(
    &self,
    variant: &IndexEntryVariant,
    filter: &IndexEntryFilter,
  ) -> IndexCacheResult {
    let key = variant.to_redis_key();

    let unparsed = {
      // TODO: timeout
      let mut index_cache = self.0.lock().await;

      index_cache.hgetall(&key).await.ok() // TODO: log error
    };

    if let Some(unparsed) = unparsed
      && unparsed.len() > 0
      && let mut parsed = unparsed
        .values()
        .filter_map(|x| serde_json::from_str(&x).ok())
        .filter(|x| filter.evaluate_entry(x))
        .collect::<Vec<IndexEntry>>()
      && parsed.len() > 0
    {
      parsed.sort_unstable_by(|a, b| b.created_at.cmp(&a.created_at));
      parsed.truncate(5);
      IndexCacheResult::PositiveHit(parsed)
    } else if filter.min_age.is_none() && self._get_negative_hit(&variant, &filter).await {
      IndexCacheResult::NegativeHit
    } else {
      IndexCacheResult::Miss
    }
  }

  pub async fn upsert_entries(&self, variant: &IndexEntryVariant, entries: &[IndexEntry]) {
    let key = variant.to_redis_key();

    let map: Vec<(String, String)> = entries
      .iter()
      .filter_map(|x| serde_json::to_string(x).ok().map(|y| (x.id.to_string(), y)))
      .collect();

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
        .await
        .unwrap() // TODO: error handling
    };

    if hlen > 32 {
      let unparsed = {
        // TODO: timeout
        let mut index_cache = self.0.lock().await;

        index_cache.hgetall(&key).await.unwrap() // TODO: error handling
      };

      let mut parsed: Vec<(String, DateTime<Utc>)> = unparsed
        .into_iter()
        .map(|(id, entry)| {
          (
            id,
            serde_json::from_str::<IndexEntry>(&entry)
              .ok()
              .map(|x| x.created_at)
              .unwrap_or(DateTime::UNIX_EPOCH),
          )
        })
        .collect();

      parsed.sort_by(|(_, a), (_, b)| b.cmp(a));
      let to_delete: Vec<String> = parsed.into_iter().skip(32).map(|(id, _)| id).collect();

      {
        // TODO: timeout
        let mut index_cache = self.0.lock().await;

        index_cache.hdel(&key, to_delete.as_slice()).await.unwrap(); // TODO: error handling
      }
    }
  }

  pub async fn delete_entry(&self, variant: &IndexEntryVariant, id: Uuid) {
    let key = variant.to_redis_key();

    {
      // TODO: timeout
      let mut index_cache = self.0.lock().await;

      index_cache.hdel(&key, id.to_string()).await.unwrap(); // TODO: error handling
    }
  }

  pub async fn set_negative(
    &self,
    variant: &IndexEntryVariant,
    filter: &IndexEntryFilter,
    empty_from: DateTime<Utc>,
  ) {
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
          })
          .unwrap(),
          600,
        )
        .await
        .unwrap(); // TODO: error handling
    }
  }
}
