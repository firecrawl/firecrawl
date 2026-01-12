use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use foundationdb::{Database, RangeOption, TransactionCommitError, options::MutationType};
use std::collections::HashSet;
use std::sync::Arc;
use thiserror::Error;

use crate::models::{FdbQueueJob, ClaimedJob};

// Subspace prefixes (matching the TypeScript implementation)
const QUEUE_PREFIX: &[u8] = &[0x01];
const CRAWL_INDEX_PREFIX: &[u8] = &[0x02];
const COUNTER_PREFIX: &[u8] = &[0x03];
const ACTIVE_PREFIX: &[u8] = &[0x04];
const ACTIVE_CRAWL_PREFIX: &[u8] = &[0x05];
const TTL_INDEX_PREFIX: &[u8] = &[0x06];
const CLAIMS_PREFIX: &[u8] = &[0x07];

// Versionstamp placeholder (10 bytes: 8 for versionstamp + 2 for user version)
const VERSIONSTAMP_PLACEHOLDER: [u8; 10] = [0xff; 10];

// Counter types
const COUNTER_TEAM: &[u8] = &[0x01];
const COUNTER_CRAWL: &[u8] = &[0x02];
const COUNTER_ACTIVE_TEAM: &[u8] = &[0x03];
const COUNTER_ACTIVE_CRAWL: &[u8] = &[0x04];

#[derive(Error, Debug)]
pub enum FdbError {
    #[error("FDB error: {0}")]
    Fdb(#[from] foundationdb::FdbError),
    #[error("Serialization error: {0}")]
    Serialization(#[from] serde_json::Error),
    #[error("Transaction commit error: {0}")]
    TransactionCommit(#[from] TransactionCommitError),
    #[error("Other error: {0}")]
    Other(String),
}

pub struct FdbQueue {
    db: Arc<Database>,
}

impl FdbQueue {
    /// Create a new FdbQueue with the given cluster file.
    /// Note: foundationdb::boot() must be called before this function.
    pub fn new_with_cluster_file(cluster_file: &str) -> Result<Self, FdbError> {
        let db = Database::new(Some(cluster_file))
            .map_err(|e| FdbError::Other(format!("Failed to open database: {:?}", e)))?;

        Ok(Self { db: Arc::new(db) })
    }

    // === Key building helpers ===

    fn build_queue_key(team_id: &str, priority: i32, created_at: i64, job_id: &str) -> Vec<u8> {
        let mut key = QUEUE_PREFIX.to_vec();
        // Add team_id length prefix and value
        let team_bytes = team_id.as_bytes();
        key.extend_from_slice(&(team_bytes.len() as u32).to_be_bytes());
        key.extend_from_slice(team_bytes);
        // Add priority (as big-endian for ordering)
        key.extend_from_slice(&priority.to_be_bytes());
        // Add created_at (as big-endian for ordering)
        key.extend_from_slice(&created_at.to_be_bytes());
        // Add job_id length prefix and value
        let job_bytes = job_id.as_bytes();
        key.extend_from_slice(&(job_bytes.len() as u32).to_be_bytes());
        key.extend_from_slice(job_bytes);
        key
    }

    fn build_queue_prefix(team_id: &str) -> Vec<u8> {
        let mut key = QUEUE_PREFIX.to_vec();
        let team_bytes = team_id.as_bytes();
        key.extend_from_slice(&(team_bytes.len() as u32).to_be_bytes());
        key.extend_from_slice(team_bytes);
        key
    }

    fn build_crawl_index_key(crawl_id: &str, job_id: &str) -> Vec<u8> {
        let mut key = CRAWL_INDEX_PREFIX.to_vec();
        let crawl_bytes = crawl_id.as_bytes();
        key.extend_from_slice(&(crawl_bytes.len() as u32).to_be_bytes());
        key.extend_from_slice(crawl_bytes);
        let job_bytes = job_id.as_bytes();
        key.extend_from_slice(&(job_bytes.len() as u32).to_be_bytes());
        key.extend_from_slice(job_bytes);
        key
    }

    fn build_crawl_index_prefix(crawl_id: &str) -> Vec<u8> {
        let mut key = CRAWL_INDEX_PREFIX.to_vec();
        let crawl_bytes = crawl_id.as_bytes();
        key.extend_from_slice(&(crawl_bytes.len() as u32).to_be_bytes());
        key.extend_from_slice(crawl_bytes);
        key
    }

    fn build_counter_key(counter_type: &[u8], id: &str) -> Vec<u8> {
        let mut key = COUNTER_PREFIX.to_vec();
        key.extend_from_slice(counter_type);
        let id_bytes = id.as_bytes();
        key.extend_from_slice(&(id_bytes.len() as u32).to_be_bytes());
        key.extend_from_slice(id_bytes);
        key
    }

    fn build_counter_prefix(counter_type: &[u8]) -> Vec<u8> {
        let mut key = COUNTER_PREFIX.to_vec();
        key.extend_from_slice(counter_type);
        key
    }

    fn build_active_key(team_id: &str, job_id: &str) -> Vec<u8> {
        let mut key = ACTIVE_PREFIX.to_vec();
        let team_bytes = team_id.as_bytes();
        key.extend_from_slice(&(team_bytes.len() as u32).to_be_bytes());
        key.extend_from_slice(team_bytes);
        let job_bytes = job_id.as_bytes();
        key.extend_from_slice(&(job_bytes.len() as u32).to_be_bytes());
        key.extend_from_slice(job_bytes);
        key
    }

    fn build_active_prefix(team_id: &str) -> Vec<u8> {
        let mut key = ACTIVE_PREFIX.to_vec();
        let team_bytes = team_id.as_bytes();
        key.extend_from_slice(&(team_bytes.len() as u32).to_be_bytes());
        key.extend_from_slice(team_bytes);
        key
    }

    fn build_active_crawl_key(crawl_id: &str, job_id: &str) -> Vec<u8> {
        let mut key = ACTIVE_CRAWL_PREFIX.to_vec();
        let crawl_bytes = crawl_id.as_bytes();
        key.extend_from_slice(&(crawl_bytes.len() as u32).to_be_bytes());
        key.extend_from_slice(crawl_bytes);
        let job_bytes = job_id.as_bytes();
        key.extend_from_slice(&(job_bytes.len() as u32).to_be_bytes());
        key.extend_from_slice(job_bytes);
        key
    }

    fn build_active_crawl_prefix(crawl_id: &str) -> Vec<u8> {
        let mut key = ACTIVE_CRAWL_PREFIX.to_vec();
        let crawl_bytes = crawl_id.as_bytes();
        key.extend_from_slice(&(crawl_bytes.len() as u32).to_be_bytes());
        key.extend_from_slice(crawl_bytes);
        key
    }

    fn build_ttl_index_key(expires_at: i64, team_id: &str, job_id: &str) -> Vec<u8> {
        let mut key = TTL_INDEX_PREFIX.to_vec();
        key.extend_from_slice(&expires_at.to_be_bytes());
        let team_bytes = team_id.as_bytes();
        key.extend_from_slice(&(team_bytes.len() as u32).to_be_bytes());
        key.extend_from_slice(team_bytes);
        let job_bytes = job_id.as_bytes();
        key.extend_from_slice(&(job_bytes.len() as u32).to_be_bytes());
        key.extend_from_slice(job_bytes);
        key
    }

    fn build_ttl_index_prefix_until(expires_at: i64) -> Vec<u8> {
        let mut key = TTL_INDEX_PREFIX.to_vec();
        key.extend_from_slice(&expires_at.to_be_bytes());
        key
    }

    /// Build a claim key with versionstamp placeholder for SetVersionstampedKey.
    ///
    /// Key format sent to FDB:
    ///   CLAIMS_PREFIX + job_id_len(4) + job_id + versionstamp_placeholder(10) + worker_id_len(4) + worker_id + offset(4)
    ///
    /// After commit, FDB replaces the placeholder with actual versionstamp and removes
    /// the 4-byte offset suffix, resulting in:
    ///   CLAIMS_PREFIX + job_id_len(4) + job_id + versionstamp(10) + worker_id_len(4) + worker_id
    ///
    /// KEY INSIGHT: The versionstamp comes BEFORE worker_id in the final key!
    /// This means claims are naturally sorted by versionstamp, so the first claim
    /// in a range scan IS the winner (lowest versionstamp). O(1) winner lookup!
    ///
    /// But wait - doesn't this cause conflicts? No! Because:
    /// 1. FDB's conflict detection uses the key WITH the placeholder (0xff bytes)
    /// 2. Different workers have different worker_ids AFTER the placeholder
    /// 3. So each worker's key (with placeholder) is unique: claims/{job_id}/{0xff...}/{worker_id}
    /// 4. No two workers write to the same conflict range!
    fn build_claim_key_with_versionstamp(job_id: &str, worker_id: &str) -> Vec<u8> {
        let mut key = CLAIMS_PREFIX.to_vec();
        let job_bytes = job_id.as_bytes();
        key.extend_from_slice(&(job_bytes.len() as u32).to_be_bytes());
        key.extend_from_slice(job_bytes);
        // Versionstamp comes first (for natural ordering by commit time)
        let versionstamp_offset = key.len();
        key.extend_from_slice(&VERSIONSTAMP_PLACEHOLDER);
        // Worker_id comes after (makes pre-commit key unique for conflict avoidance)
        let worker_bytes = worker_id.as_bytes();
        key.extend_from_slice(&(worker_bytes.len() as u32).to_be_bytes());
        key.extend_from_slice(worker_bytes);
        // FDB requires 4-byte little-endian offset at end of key for SetVersionstampedKey
        key.extend_from_slice(&(versionstamp_offset as u32).to_le_bytes());
        key
    }

    /// Build prefix for all claims of a job.
    fn build_claims_prefix(job_id: &str) -> Vec<u8> {
        let mut key = CLAIMS_PREFIX.to_vec();
        let job_bytes = job_id.as_bytes();
        key.extend_from_slice(&(job_bytes.len() as u32).to_be_bytes());
        key.extend_from_slice(job_bytes);
        key
    }

    // === Encoding helpers ===

    fn encode_i64_le(n: i64) -> [u8; 8] {
        n.to_le_bytes()
    }

    fn decode_i64_le(buf: &[u8]) -> i64 {
        if buf.len() < 8 {
            return 0;
        }
        let mut arr = [0u8; 8];
        arr.copy_from_slice(&buf[..8]);
        i64::from_le_bytes(arr)
    }

    fn encode_i64_be(n: i64) -> [u8; 8] {
        n.to_be_bytes()
    }

    fn decode_i64_be(buf: &[u8]) -> i64 {
        if buf.len() < 8 {
            return 0;
        }
        let mut arr = [0u8; 8];
        arr.copy_from_slice(&buf[..8]);
        i64::from_be_bytes(arr)
    }

    fn now_ms() -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64
    }

    fn next_key(key: &[u8]) -> Vec<u8> {
        let mut next = key.to_vec();
        next.push(0x00);
        next
    }

    fn end_key(prefix: &[u8]) -> Vec<u8> {
        let mut end = prefix.to_vec();
        end.push(0xff);
        end
    }

    // === Queue operations ===

    pub async fn push_job(
        &self,
        team_id: &str,
        job_id: &str,
        data: serde_json::Value,
        priority: i32,
        listenable: bool,
        listen_channel_id: Option<&str>,
        timeout: Option<i64>,
        crawl_id: Option<&str>,
    ) -> Result<(), FdbError> {
        let now = Self::now_ms();
        // timeout is None when Infinity is passed from JS (serializes as null)
        let has_timeout = crawl_id.is_none() && timeout.is_some_and(|t| t > 0 && t < i64::MAX);
        let times_out_at = if has_timeout { Some(now + timeout.unwrap()) } else { None };

        let job = FdbQueueJob {
            id: job_id.to_string(),
            data,
            priority,
            listenable,
            created_at: now,
            times_out_at,
            listen_channel_id: listen_channel_id.map(String::from),
            crawl_id: crawl_id.map(String::from),
            team_id: team_id.to_string(),
        };

        let job_json = serde_json::to_vec(&job)?;
        let queue_key = Self::build_queue_key(team_id, priority, now, job_id);
        let team_counter_key = Self::build_counter_key(COUNTER_TEAM, team_id);

        let trx = self.db.create_trx()?;

        trx.set(&queue_key, &job_json);
        trx.atomic_op(&team_counter_key, &Self::encode_i64_le(1), MutationType::Add);

        if let Some(expires_at) = times_out_at {
            let ttl_key = Self::build_ttl_index_key(expires_at, team_id, job_id);
            let ttl_value = serde_json::json!({
                "priority": priority,
                "createdAt": now,
                "crawlId": crawl_id,
            });
            trx.set(&ttl_key, &serde_json::to_vec(&ttl_value)?);
        }

        if let Some(cid) = crawl_id {
            let crawl_index_key = Self::build_crawl_index_key(cid, job_id);
            let crawl_value = serde_json::json!({
                "teamId": team_id,
                "priority": priority,
                "createdAt": now,
            });
            trx.set(&crawl_index_key, &serde_json::to_vec(&crawl_value)?);

            let crawl_counter_key = Self::build_counter_key(COUNTER_CRAWL, cid);
            trx.atomic_op(&crawl_counter_key, &Self::encode_i64_le(1), MutationType::Add);
        }

        trx.commit().await?;
        Ok(())
    }

    /// Pop the next available job using conflict-free versionstamp claims.
    ///
    /// This uses append-only claims with versionstamps for ZERO conflicts:
    /// 1. Snapshot read jobs (no conflict established)
    /// 2. For each candidate, blind write to claims/{job_id}/{versionstamp}/{worker_id}
    /// 3. Worker_id comes AFTER the placeholder, making each worker's pre-commit key unique
    /// 4. FDB conflict detection sees different keys: claims/{job_id}/{0xff...}/{worker_A} vs {worker_B}
    /// 5. After commit, versionstamp replaces placeholder, giving natural sort order by commit time
    /// 6. First claim in range scan = lowest versionstamp = winner (O(1) lookup!)
    ///
    /// This design achieves both:
    /// - Zero conflicts (worker_id differentiates pre-commit keys)
    /// - O(1) winner determination (versionstamp is first in final key sort order)
    ///
    /// OPTIMIZED VERSION:
    /// - Skips checking for existing claims (we'll find out when we verify)
    /// - Uses get_committed_version to compare versionstamps efficiently
    /// - Spawns cleanup asynchronously to not block response
    pub async fn pop_next_job(
        &self,
        team_id: &str,
        worker_id: &str,
        blocked_crawl_ids: &HashSet<String>,
    ) -> Result<Option<ClaimedJob>, FdbError> {
        let now = Self::now_ms();
        let start_key = Self::build_queue_prefix(team_id);
        let end_key = Self::end_key(&start_key);

        // Read candidates with snapshot read (no read conflicts)
        let trx = self.db.create_trx()?;
        let range = trx.get_range(
            &RangeOption::from((&start_key[..], &end_key[..])),
            100,
            true, // snapshot = true (no read conflicts)
        ).await?;

        if range.is_empty() {
            return Ok(None);
        }

        // Collect candidates into Vec to avoid holding FdbKeyValue iterator
        let mut candidates: Vec<(Vec<u8>, FdbQueueJob)> = Vec::new();
        let mut expired_jobs: Vec<(Vec<u8>, FdbQueueJob)> = Vec::new();

        for kv in range.iter() {
            if let Ok(job) = serde_json::from_slice::<FdbQueueJob>(kv.value()) {
                // Skip expired jobs
                if let Some(times_out_at) = job.times_out_at {
                    if times_out_at < now {
                        expired_jobs.push((kv.key().to_vec(), job));
                        continue;
                    }
                }

                // Skip blocked crawls
                if let Some(ref cid) = job.crawl_id {
                    if blocked_crawl_ids.contains(cid) {
                        continue;
                    }
                }

                candidates.push((kv.key().to_vec(), job));
            }
        }

        // Clean up expired jobs ASYNCHRONOUSLY (don't block the response)
        if !expired_jobs.is_empty() {
            let db = self.db.clone();
            let team_id_owned = team_id.to_string();
            tokio::spawn(async move {
                if let Ok(cleanup_trx) = db.create_trx() {
                    for (key, job) in &expired_jobs {
                        cleanup_trx.clear(key);
                        let team_counter_key = Self::build_counter_key(COUNTER_TEAM, &team_id_owned);
                        cleanup_trx.atomic_op(&team_counter_key, &Self::encode_i64_le(-1), MutationType::Add);

                        if let Some(times_out_at) = job.times_out_at {
                            let ttl_key = Self::build_ttl_index_key(times_out_at, &team_id_owned, &job.id);
                            cleanup_trx.clear(&ttl_key);
                        }

                        if let Some(ref cid) = job.crawl_id {
                            cleanup_trx.clear(&Self::build_crawl_index_key(cid, &job.id));
                            let crawl_counter_key = Self::build_counter_key(COUNTER_CRAWL, cid);
                            cleanup_trx.atomic_op(&crawl_counter_key, &Self::encode_i64_le(-1), MutationType::Add);
                        }
                    }
                    // Best effort - ignore errors
                    let _ = cleanup_trx.commit().await;
                }
            });
        }

        if candidates.is_empty() {
            return Ok(None);
        }

        // Try to claim each candidate in priority order
        for (queue_key, job) in candidates {
            let claims_prefix = Self::build_claims_prefix(&job.id);
            let claims_end = Self::end_key(&claims_prefix);

            // Check for existing claims BEFORE writing (saves a write if already claimed)
            let check_trx = self.db.create_trx()?;
            let existing_claims = check_trx.get_range(
                &RangeOption::from((&claims_prefix[..], &claims_end[..])),
                1,
                true, // snapshot
            ).await?;

            if !existing_claims.is_empty() {
                // Already claimed by someone, skip to next candidate
                // (This is the CRDT read-before-write pattern)
                continue;
            }

            // No claims yet - submit ours with versionstamp (conflict-free because worker_id is in key)
            let claim_trx = self.db.create_trx()?;
            let claim_key = Self::build_claim_key_with_versionstamp(&job.id, worker_id);

            // Generate unique claim ID for THIS request (worker_id alone isn't unique
            // when the same client makes concurrent requests)
            let claim_id = format!("{}:{}", worker_id, uuid::Uuid::new_v4());

            // Also store the queue_key in the claim value so we can find the job later
            let claim_value = serde_json::json!({
                "workerId": worker_id,
                "claimId": claim_id,
                "queueKey": BASE64.encode(&queue_key),
                "claimedAt": now,
            });
            claim_trx.atomic_op(
                &claim_key,
                &serde_json::to_vec(&claim_value)?,
                MutationType::SetVersionstampedKey,
            );

            // Commit our claim - this CANNOT conflict because worker_id makes key range unique
            claim_trx.commit().await?;

            // Now read the first claim to see who won (lowest versionstamp)
            // Key format: claims/{job_id}/{versionstamp(10)}/{worker_id}
            // Claims are naturally sorted by versionstamp, so first one wins! O(1)
            // IMPORTANT: Also check job still exists to prevent race with complete_job
            let verify_trx = self.db.create_trx()?;
            let all_claims = verify_trx.get_range(
                &RangeOption::from((&claims_prefix[..], &claims_end[..])),
                1, // Only need the first one (winner)
                true, // snapshot
            ).await?;

            // Check if job still exists (same snapshot as claim check)
            let job_still_exists = verify_trx.get(&queue_key, true).await?.is_some();

            if !job_still_exists {
                // Job was completed between our candidate read and verification
                // Another worker won and already processed it
                tracing::debug!(
                    "Job {} was completed before we could verify claim",
                    job.id
                );
                continue;
            }

            if all_claims.is_empty() {
                // Claims were cleared (job completed) - shouldn't happen if job exists
                // but handle defensively
                continue;
            }

            // First claim has lowest versionstamp = winner
            let winning_claim = all_claims.iter().next().unwrap();
            let winning_value: serde_json::Value = serde_json::from_slice(winning_claim.value())?;

            // Compare claimId (unique per request) not workerId (shared by concurrent requests)
            if winning_value["claimId"].as_str() == Some(&claim_id) {
                // We won AND job still exists!
                tracing::debug!(
                    "Won claim for job {} (worker {}, claim {})",
                    job.id,
                    worker_id,
                    claim_id
                );

                return Ok(Some(ClaimedJob {
                    job,
                    queue_key: BASE64.encode(&queue_key),
                }));
            } else {
                // We lost, try next candidate
                tracing::debug!(
                    "Lost claim for job {} to claim {:?} (we were {})",
                    job.id,
                    winning_value["claimId"].as_str(),
                    claim_id
                );
                continue;
            }
        }

        // No candidates were successfully claimed
        Ok(None)
    }

    /// Release a claimed job without completing it.
    /// This deletes all claims for the job but leaves the job in the queue.
    /// Used when a worker claims a job but can't process it (e.g., crawl concurrency limit).
    ///
    /// The job_id is the ID of the job to release.
    pub async fn release_job(&self, job_id: &str) -> Result<(), FdbError> {
        let claims_prefix = Self::build_claims_prefix(job_id);
        let claims_end = Self::end_key(&claims_prefix);

        let trx = self.db.create_trx()?;
        trx.clear_range(&claims_prefix, &claims_end);
        trx.commit().await?;

        tracing::debug!(job_id = job_id, "Released job claims");
        Ok(())
    }

    /// Complete a job after successful processing.
    /// This deletes the job from the queue and cleans up all claims.
    ///
    /// The queue_key is the base64-encoded queue key returned by pop_next_job.
    pub async fn complete_job(&self, queue_key_b64: &str) -> Result<bool, FdbError> {
        // Decode the queue key
        let queue_key = BASE64.decode(queue_key_b64)
            .map_err(|e| FdbError::Other(format!("Invalid queue key: {}", e)))?;

        // First, read the job to get its metadata
        let trx = self.db.create_trx()?;
        let job_data = trx.get(&queue_key, false).await?;

        let Some(job_bytes) = job_data else {
            // Job doesn't exist, might have been cleaned up already
            return Ok(false);
        };

        let job: FdbQueueJob = serde_json::from_slice(&job_bytes)?;

        // Delete the job and update counters in a single transaction
        let trx = self.db.create_trx()?;

        // Delete the job from the queue
        trx.clear(&queue_key);

        // Decrement team counter
        let team_counter_key = Self::build_counter_key(COUNTER_TEAM, &job.team_id);
        trx.atomic_op(&team_counter_key, &Self::encode_i64_le(-1), MutationType::Add);

        // Clean up TTL index if it exists
        if let Some(times_out_at) = job.times_out_at {
            let ttl_key = Self::build_ttl_index_key(times_out_at, &job.team_id, &job.id);
            trx.clear(&ttl_key);
        }

        // Clean up crawl index and counter if applicable
        if let Some(ref crawl_id) = job.crawl_id {
            trx.clear(&Self::build_crawl_index_key(crawl_id, &job.id));
            let crawl_counter_key = Self::build_counter_key(COUNTER_CRAWL, crawl_id);
            trx.atomic_op(&crawl_counter_key, &Self::encode_i64_le(-1), MutationType::Add);
        }

        // Clean up all claims for this job
        let claims_prefix = Self::build_claims_prefix(&job.id);
        let claims_end = Self::end_key(&claims_prefix);
        trx.clear_range(&claims_prefix, &claims_end);

        trx.commit().await?;

        tracing::debug!(
            job_id = job.id,
            team_id = job.team_id,
            "Completed job and cleaned up claims"
        );

        Ok(true)
    }

    /// Clean up orphaned claims - claims for jobs that no longer exist.
    /// This should be run periodically by the janitor.
    ///
    /// Returns the number of orphaned claims cleaned up.
    pub async fn clean_orphaned_claims(&self) -> Result<i64, FdbError> {
        let mut cleaned = 0i64;

        // Scan all claims
        let claims_start = CLAIMS_PREFIX.to_vec();
        let claims_end = Self::end_key(&claims_start);

        for _ in 0..10 {
            let trx = self.db.create_trx()?;
            let range = trx.get_range(
                &RangeOption::from((&claims_start[..], &claims_end[..])),
                100,
                false,
            ).await?;

            if range.is_empty() {
                break;
            }

            let batch_count = range.len();

            // Collect claims with their keys, job IDs, and parsed values upfront
            // (to avoid holding FdbKeyValue iterator across await points)
            struct ClaimInfo {
                claim_key: Vec<u8>,
                queue_key: Option<Vec<u8>>,
            }
            let mut claims_to_check: Vec<ClaimInfo> = Vec::new();

            for kv in range.iter() {
                let key = kv.key();
                // Key format: CLAIMS_PREFIX + job_id_len(4) + job_id + versionstamp(10)
                if key.len() > 5 + 10 {
                    let job_id_len = u32::from_be_bytes([key[1], key[2], key[3], key[4]]) as usize;
                    if key.len() >= 5 + job_id_len + 10 {
                        // Parse the claim value to get queue key
                        let queue_key = serde_json::from_slice::<serde_json::Value>(kv.value())
                            .ok()
                            .and_then(|v| v["queueKey"].as_str().map(String::from))
                            .and_then(|b64| BASE64.decode(&b64).ok());

                        claims_to_check.push(ClaimInfo {
                            claim_key: key.to_vec(),
                            queue_key,
                        });
                    }
                }
            }

            if claims_to_check.is_empty() {
                break;
            }

            // Check each claim's corresponding job
            let check_trx = self.db.create_trx()?;
            let mut orphans: Vec<Vec<u8>> = Vec::new();

            for claim in &claims_to_check {
                match &claim.queue_key {
                    Some(queue_key) => {
                        // Check if job still exists (use snapshot read)
                        if check_trx.get(queue_key, true).await?.is_none() {
                            orphans.push(claim.claim_key.clone());
                        }
                    }
                    None => {
                        // No valid queue key, consider it orphaned
                        orphans.push(claim.claim_key.clone());
                    }
                }
            }

            if orphans.is_empty() {
                if batch_count < 100 {
                    break;
                }
                continue;
            }

            // Clean up orphaned claims
            let cleanup_trx = self.db.create_trx()?;
            for orphan_key in &orphans {
                cleanup_trx.clear(orphan_key);
            }
            cleanup_trx.commit().await?;

            cleaned += orphans.len() as i64;

            if batch_count < 100 {
                break;
            }
        }

        if cleaned > 0 {
            tracing::info!(cleaned = cleaned, "Cleaned orphaned claims");
        }

        Ok(cleaned)
    }

    pub async fn get_team_queue_count(&self, team_id: &str) -> Result<i64, FdbError> {
        let counter_key = Self::build_counter_key(COUNTER_TEAM, team_id);
        let trx = self.db.create_trx()?;
        let value = trx.get(&counter_key, false).await?;
        Ok(value.map(|v| Self::decode_i64_le(&v)).unwrap_or(0))
    }

    pub async fn get_crawl_queue_count(&self, crawl_id: &str) -> Result<i64, FdbError> {
        let counter_key = Self::build_counter_key(COUNTER_CRAWL, crawl_id);
        let trx = self.db.create_trx()?;
        let value = trx.get(&counter_key, false).await?;
        Ok(value.map(|v| Self::decode_i64_le(&v)).unwrap_or(0))
    }

    pub async fn get_team_queued_job_ids(&self, team_id: &str, limit: u32) -> Result<Vec<String>, FdbError> {
        let start_key = Self::build_queue_prefix(team_id);
        let end_key = Self::end_key(&start_key);
        let effective_limit = limit.min(100000) as usize;

        let trx = self.db.create_trx()?;
        let range = trx.get_range(
            &RangeOption::from((&start_key[..], &end_key[..])),
            effective_limit,
            false,
        ).await?;

        let mut job_ids = Vec::new();
        for kv in range.iter() {
            if let Ok(job) = serde_json::from_slice::<FdbQueueJob>(kv.value()) {
                job_ids.push(job.id);
            }
        }

        Ok(job_ids)
    }

    // === Active job tracking ===

    pub async fn push_active_job(&self, team_id: &str, job_id: &str, timeout: i64) -> Result<(), FdbError> {
        let expires_at = Self::now_ms() + timeout;
        let key = Self::build_active_key(team_id, job_id);
        let counter_key = Self::build_counter_key(COUNTER_ACTIVE_TEAM, team_id);

        let trx = self.db.create_trx()?;
        trx.set(&key, &Self::encode_i64_be(expires_at));
        trx.atomic_op(&counter_key, &Self::encode_i64_le(1), MutationType::Add);
        trx.commit().await?;
        Ok(())
    }

    pub async fn remove_active_job(&self, team_id: &str, job_id: &str) -> Result<(), FdbError> {
        let key = Self::build_active_key(team_id, job_id);
        let counter_key = Self::build_counter_key(COUNTER_ACTIVE_TEAM, team_id);

        let trx = self.db.create_trx()?;
        if trx.get(&key, false).await?.is_some() {
            trx.clear(&key);
            trx.atomic_op(&counter_key, &Self::encode_i64_le(-1), MutationType::Add);
        }
        trx.commit().await?;
        Ok(())
    }

    pub async fn get_active_job_count(&self, team_id: &str) -> Result<i64, FdbError> {
        let counter_key = Self::build_counter_key(COUNTER_ACTIVE_TEAM, team_id);
        let trx = self.db.create_trx()?;
        let value = trx.get(&counter_key, false).await?;
        Ok(value.map(|v| Self::decode_i64_le(&v).max(0)).unwrap_or(0))
    }

    pub async fn get_active_jobs(&self, team_id: &str) -> Result<Vec<String>, FdbError> {
        let now = Self::now_ms();
        let start_key = Self::build_active_prefix(team_id);
        let end_key = Self::end_key(&start_key);

        let trx = self.db.create_trx()?;
        let range = trx.get_range(
            &RangeOption::from((&start_key[..], &end_key[..])),
            10000,
            false,
        ).await?;

        let mut job_ids = Vec::new();
        for kv in range.iter() {
            let expires_at = Self::decode_i64_be(kv.value());
            if expires_at > now {
                // Extract job_id from key
                // Key format: prefix + team_id_len + team_id + job_id_len + job_id
                let key = kv.key();
                if key.len() > start_key.len() + 4 {
                    let job_id_start = start_key.len() + 4;
                    if let Ok(job_id) = std::str::from_utf8(&key[job_id_start..]) {
                        job_ids.push(job_id.to_string());
                    }
                }
            }
        }

        Ok(job_ids)
    }

    // === Crawl active job tracking ===

    pub async fn push_crawl_active_job(&self, crawl_id: &str, job_id: &str, timeout: i64) -> Result<(), FdbError> {
        let expires_at = Self::now_ms() + timeout;
        let key = Self::build_active_crawl_key(crawl_id, job_id);
        let counter_key = Self::build_counter_key(COUNTER_ACTIVE_CRAWL, crawl_id);

        let trx = self.db.create_trx()?;
        trx.set(&key, &Self::encode_i64_be(expires_at));
        trx.atomic_op(&counter_key, &Self::encode_i64_le(1), MutationType::Add);
        trx.commit().await?;
        Ok(())
    }

    pub async fn remove_crawl_active_job(&self, crawl_id: &str, job_id: &str) -> Result<(), FdbError> {
        let key = Self::build_active_crawl_key(crawl_id, job_id);
        let counter_key = Self::build_counter_key(COUNTER_ACTIVE_CRAWL, crawl_id);

        let trx = self.db.create_trx()?;
        if trx.get(&key, false).await?.is_some() {
            trx.clear(&key);
            trx.atomic_op(&counter_key, &Self::encode_i64_le(-1), MutationType::Add);
        }
        trx.commit().await?;
        Ok(())
    }

    pub async fn get_crawl_active_jobs(&self, crawl_id: &str) -> Result<Vec<String>, FdbError> {
        let now = Self::now_ms();
        let start_key = Self::build_active_crawl_prefix(crawl_id);
        let end_key = Self::end_key(&start_key);

        let trx = self.db.create_trx()?;
        let range = trx.get_range(
            &RangeOption::from((&start_key[..], &end_key[..])),
            10000,
            false,
        ).await?;

        let mut job_ids = Vec::new();
        for kv in range.iter() {
            let expires_at = Self::decode_i64_be(kv.value());
            if expires_at > now {
                let key = kv.key();
                if key.len() > start_key.len() + 4 {
                    let job_id_start = start_key.len() + 4;
                    if let Ok(job_id) = std::str::from_utf8(&key[job_id_start..]) {
                        job_ids.push(job_id.to_string());
                    }
                }
            }
        }

        Ok(job_ids)
    }

    // === Cleanup operations ===

    pub async fn clean_expired_jobs(&self) -> Result<i64, FdbError> {
        let now = Self::now_ms();
        let mut cleaned = 0i64;

        for _ in 0..10 {
            let start_key = TTL_INDEX_PREFIX.to_vec();
            let end_key = Self::build_ttl_index_prefix_until(now);

            let trx = self.db.create_trx()?;
            let range = trx.get_range(
                &RangeOption::from((&start_key[..], &end_key[..])),
                100,
                false,
            ).await?;

            if range.is_empty() {
                break;
            }

            let batch_count = range.len();

            for kv in range.iter() {
                if let Ok(ttl_data) = serde_json::from_slice::<serde_json::Value>(kv.value()) {
                    // Parse TTL key to get team_id and job_id
                    // Key format: prefix + expires_at(8) + team_id_len(4) + team_id + job_id_len(4) + job_id
                    let key = kv.key();
                    if key.len() > 13 {
                        let team_id_len = u32::from_be_bytes([key[9], key[10], key[11], key[12]]) as usize;
                        if key.len() > 13 + team_id_len + 4 {
                            let team_id = std::str::from_utf8(&key[13..13 + team_id_len]).unwrap_or("");
                            let job_id_start = 13 + team_id_len + 4;
                            let job_id = std::str::from_utf8(&key[job_id_start..]).unwrap_or("");

                            let priority = ttl_data["priority"].as_i64().unwrap_or(0) as i32;
                            let created_at = ttl_data["createdAt"].as_i64().unwrap_or(0);
                            let crawl_id = ttl_data["crawlId"].as_str();

                            let queue_key = Self::build_queue_key(team_id, priority, created_at, job_id);
                            trx.clear(&queue_key);

                            let team_counter_key = Self::build_counter_key(COUNTER_TEAM, team_id);
                            trx.atomic_op(&team_counter_key, &Self::encode_i64_le(-1), MutationType::Add);

                            if let Some(cid) = crawl_id {
                                trx.clear(&Self::build_crawl_index_key(cid, job_id));
                                let crawl_counter_key = Self::build_counter_key(COUNTER_CRAWL, cid);
                                trx.atomic_op(&crawl_counter_key, &Self::encode_i64_le(-1), MutationType::Add);
                            }

                            trx.clear(kv.key());
                            cleaned += 1;
                        }
                    }
                }
            }

            trx.commit().await?;

            if batch_count < 100 {
                break;
            }
        }

        Ok(cleaned)
    }

    pub async fn clean_expired_active_jobs(&self) -> Result<i64, FdbError> {
        let now = Self::now_ms();
        let mut cleaned = 0i64;

        // Clean team active jobs
        loop {
            let start_key = ACTIVE_PREFIX.to_vec();
            let end_key = Self::end_key(&start_key);

            let trx = self.db.create_trx()?;
            let range = trx.get_range(
                &RangeOption::from((&start_key[..], &end_key[..])),
                100,
                false,
            ).await?;

            let batch_count = range.len();

            for kv in range.iter() {
                let expires_at = Self::decode_i64_be(kv.value());
                if expires_at < now {
                    // Extract team_id from key
                    let key = kv.key();
                    if key.len() > 5 {
                        let team_id_len = u32::from_be_bytes([key[1], key[2], key[3], key[4]]) as usize;
                        if let Ok(team_id) = std::str::from_utf8(&key[5..5 + team_id_len]) {
                            trx.clear(kv.key());
                            let counter_key = Self::build_counter_key(COUNTER_ACTIVE_TEAM, team_id);
                            trx.atomic_op(&counter_key, &Self::encode_i64_le(-1), MutationType::Add);
                            cleaned += 1;
                        }
                    }
                }
            }

            trx.commit().await?;

            if batch_count < 100 {
                break;
            }
        }

        // Clean crawl active jobs
        loop {
            let start_key = ACTIVE_CRAWL_PREFIX.to_vec();
            let end_key = Self::end_key(&start_key);

            let trx = self.db.create_trx()?;
            let range = trx.get_range(
                &RangeOption::from((&start_key[..], &end_key[..])),
                100,
                false,
            ).await?;

            let batch_count = range.len();

            for kv in range.iter() {
                let expires_at = Self::decode_i64_be(kv.value());
                if expires_at < now {
                    let key = kv.key();
                    if key.len() > 5 {
                        let crawl_id_len = u32::from_be_bytes([key[1], key[2], key[3], key[4]]) as usize;
                        if let Ok(crawl_id) = std::str::from_utf8(&key[5..5 + crawl_id_len]) {
                            trx.clear(kv.key());
                            let counter_key = Self::build_counter_key(COUNTER_ACTIVE_CRAWL, crawl_id);
                            trx.atomic_op(&counter_key, &Self::encode_i64_le(-1), MutationType::Add);
                            cleaned += 1;
                        }
                    }
                }
            }

            trx.commit().await?;

            if batch_count < 100 {
                break;
            }
        }

        Ok(cleaned)
    }

    pub async fn clean_stale_counters(&self) -> Result<i64, FdbError> {
        // Simplified implementation - just returns 0 for now
        // Full implementation would iterate through counters and check for orphans
        Ok(0)
    }

    // === Counter reconciliation ===

    pub async fn sample_team_counters(&self, limit: u32, after_team_id: Option<&str>) -> Result<Vec<String>, FdbError> {
        let start_key = match after_team_id {
            Some(tid) => Self::next_key(&Self::build_counter_key(COUNTER_TEAM, tid)),
            None => Self::build_counter_prefix(COUNTER_TEAM),
        };
        let end_key = Self::end_key(&Self::build_counter_prefix(COUNTER_TEAM));

        let trx = self.db.create_trx()?;
        let range = trx.get_range(
            &RangeOption::from((&start_key[..], &end_key[..])),
            limit as usize,
            false,
        ).await?;

        let mut team_ids = Vec::new();
        let prefix_len = Self::build_counter_prefix(COUNTER_TEAM).len();
        for kv in range.iter() {
            let key = kv.key();
            if key.len() > prefix_len + 4 {
                let id_len = u32::from_be_bytes([key[prefix_len], key[prefix_len + 1], key[prefix_len + 2], key[prefix_len + 3]]) as usize;
                if let Ok(team_id) = std::str::from_utf8(&key[prefix_len + 4..prefix_len + 4 + id_len]) {
                    team_ids.push(team_id.to_string());
                }
            }
        }

        Ok(team_ids)
    }

    pub async fn sample_crawl_counters(&self, limit: u32, after_crawl_id: Option<&str>) -> Result<Vec<String>, FdbError> {
        let start_key = match after_crawl_id {
            Some(cid) => Self::next_key(&Self::build_counter_key(COUNTER_CRAWL, cid)),
            None => Self::build_counter_prefix(COUNTER_CRAWL),
        };
        let end_key = Self::end_key(&Self::build_counter_prefix(COUNTER_CRAWL));

        let trx = self.db.create_trx()?;
        let range = trx.get_range(
            &RangeOption::from((&start_key[..], &end_key[..])),
            limit as usize,
            false,
        ).await?;

        let mut crawl_ids = Vec::new();
        let prefix_len = Self::build_counter_prefix(COUNTER_CRAWL).len();
        for kv in range.iter() {
            let key = kv.key();
            if key.len() > prefix_len + 4 {
                let id_len = u32::from_be_bytes([key[prefix_len], key[prefix_len + 1], key[prefix_len + 2], key[prefix_len + 3]]) as usize;
                if let Ok(crawl_id) = std::str::from_utf8(&key[prefix_len + 4..prefix_len + 4 + id_len]) {
                    crawl_ids.push(crawl_id.to_string());
                }
            }
        }

        Ok(crawl_ids)
    }

    pub async fn reconcile_team_queue_counter(&self, team_id: &str) -> Result<i64, FdbError> {
        let start_key = Self::build_queue_prefix(team_id);
        let end_key = Self::end_key(&start_key);

        let trx = self.db.create_trx()?;
        let range = trx.get_range(
            &RangeOption::from((&start_key[..], &end_key[..])),
            100000,
            false,
        ).await?;

        let actual_count = range.len() as i64;

        let counter_key = Self::build_counter_key(COUNTER_TEAM, team_id);
        let current_count = trx.get(&counter_key, false).await?
            .map(|v| Self::decode_i64_le(&v))
            .unwrap_or(0);

        if actual_count == current_count {
            return Ok(0);
        }

        let correction = actual_count - current_count;

        let trx = self.db.create_trx()?;
        trx.set(&counter_key, &Self::encode_i64_le(actual_count));
        trx.commit().await?;

        tracing::info!(
            team_id = team_id,
            previous_count = current_count,
            actual_count = actual_count,
            correction = correction,
            "Reconciled team queue counter"
        );

        Ok(correction)
    }

    pub async fn reconcile_crawl_queue_counter(&self, crawl_id: &str) -> Result<i64, FdbError> {
        let start_key = Self::build_crawl_index_prefix(crawl_id);
        let end_key = Self::end_key(&start_key);

        let trx = self.db.create_trx()?;
        let range = trx.get_range(
            &RangeOption::from((&start_key[..], &end_key[..])),
            100000,
            false,
        ).await?;

        let actual_count = range.len() as i64;

        let counter_key = Self::build_counter_key(COUNTER_CRAWL, crawl_id);
        let current_count = trx.get(&counter_key, false).await?
            .map(|v| Self::decode_i64_le(&v))
            .unwrap_or(0);

        if actual_count == current_count {
            return Ok(0);
        }

        let correction = actual_count - current_count;

        let trx = self.db.create_trx()?;
        trx.set(&counter_key, &Self::encode_i64_le(actual_count));
        trx.commit().await?;

        tracing::info!(
            crawl_id = crawl_id,
            previous_count = current_count,
            actual_count = actual_count,
            correction = correction,
            "Reconciled crawl queue counter"
        );

        Ok(correction)
    }

    pub async fn reconcile_team_active_counter(&self, team_id: &str) -> Result<i64, FdbError> {
        let now = Self::now_ms();
        let start_key = Self::build_active_prefix(team_id);
        let end_key = Self::end_key(&start_key);

        let trx = self.db.create_trx()?;
        let range = trx.get_range(
            &RangeOption::from((&start_key[..], &end_key[..])),
            10000,
            false,
        ).await?;

        let actual_count = range.iter()
            .filter(|kv| Self::decode_i64_be(kv.value()) > now)
            .count() as i64;

        let counter_key = Self::build_counter_key(COUNTER_ACTIVE_TEAM, team_id);
        let current_count = trx.get(&counter_key, false).await?
            .map(|v| Self::decode_i64_le(&v))
            .unwrap_or(0);

        if actual_count == current_count {
            return Ok(0);
        }

        let correction = actual_count - current_count;

        let trx = self.db.create_trx()?;
        trx.set(&counter_key, &Self::encode_i64_le(actual_count));
        trx.commit().await?;

        tracing::info!(
            team_id = team_id,
            previous_count = current_count,
            actual_count = actual_count,
            correction = correction,
            "Reconciled team active counter"
        );

        Ok(correction)
    }

    pub async fn reconcile_crawl_active_counter(&self, crawl_id: &str) -> Result<i64, FdbError> {
        let now = Self::now_ms();
        let start_key = Self::build_active_crawl_prefix(crawl_id);
        let end_key = Self::end_key(&start_key);

        let trx = self.db.create_trx()?;
        let range = trx.get_range(
            &RangeOption::from((&start_key[..], &end_key[..])),
            10000,
            false,
        ).await?;

        let actual_count = range.iter()
            .filter(|kv| Self::decode_i64_be(kv.value()) > now)
            .count() as i64;

        let counter_key = Self::build_counter_key(COUNTER_ACTIVE_CRAWL, crawl_id);
        let current_count = trx.get(&counter_key, false).await?
            .map(|v| Self::decode_i64_le(&v))
            .unwrap_or(0);

        if actual_count == current_count {
            return Ok(0);
        }

        let correction = actual_count - current_count;

        let trx = self.db.create_trx()?;
        trx.set(&counter_key, &Self::encode_i64_le(actual_count));
        trx.commit().await?;

        tracing::info!(
            crawl_id = crawl_id,
            previous_count = current_count,
            actual_count = actual_count,
            correction = correction,
            "Reconciled crawl active counter"
        );

        Ok(correction)
    }

    pub async fn health_check(&self) -> Result<bool, FdbError> {
        let trx = self.db.create_trx()?;
        trx.get(b"__health__", false).await?;
        Ok(true)
    }
}
