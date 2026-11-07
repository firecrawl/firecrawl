//! Monitor endpoint for Firecrawl API v2.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::client::Client;
use crate::FirecrawlError;

#[derive(Deserialize, Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MonitorSchedule {
    pub cron: String,
    pub timezone: Option<String>,
}

#[serde_with::skip_serializing_none]
#[derive(Deserialize, Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CreateMonitorRequest {
    pub name: String,
    pub schedule: MonitorSchedule,
    pub targets: Vec<Value>,
    pub webhook: Option<Value>,
    pub notification: Option<Value>,
    pub retention_days: Option<u32>,
    /// Optional natural-language description of what the monitor is
    /// watching for (max 2000 chars). When `goal` is set and
    /// `judge_enabled` is left as `None`, the API automatically enables
    /// judging for this monitor.
    pub goal: Option<String>,
    pub judge_enabled: Option<bool>,
}

#[serde_with::skip_serializing_none]
#[derive(Deserialize, Serialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UpdateMonitorRequest {
    pub name: Option<String>,
    pub status: Option<String>,
    pub schedule: Option<MonitorSchedule>,
    pub targets: Option<Vec<Value>>,
    pub webhook: Option<Value>,
    pub notification: Option<Value>,
    pub retention_days: Option<u32>,
    /// Same semantics as on [`CreateMonitorRequest`]; leave as `None` to
    /// keep the existing values.
    pub goal: Option<String>,
    pub judge_enabled: Option<bool>,
}

/// Search window for a [`MonitorSearchTarget`]: how far back the search
/// should look for results on each run.
#[derive(Deserialize, Serialize, Debug, Clone, Copy, PartialEq, Eq)]
pub enum MonitorSearchWindow {
    #[serde(rename = "5m")]
    FiveMinutes,
    #[serde(rename = "15m")]
    FifteenMinutes,
    #[serde(rename = "1h")]
    OneHour,
    #[serde(rename = "6h")]
    SixHours,
    #[serde(rename = "24h")]
    TwentyFourHours,
    #[serde(rename = "7d")]
    SevenDays,
}

/// A search monitor target. Serialize this and place it (as JSON) into the
/// `targets` of a [`CreateMonitorRequest`] or [`UpdateMonitorRequest`].
///
/// The `type` discriminator is always `"search"`.
#[serde_with::skip_serializing_none]
#[derive(Deserialize, Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase", tag = "type", rename = "search")]
pub struct MonitorSearchTarget {
    pub id: Option<String>,
    pub queries: Vec<String>,
    pub search_window: Option<MonitorSearchWindow>,
    pub include_domains: Option<Vec<String>>,
    pub exclude_domains: Option<Vec<String>>,
    pub max_results: Option<u32>,
}

/// Per-target result for a search target on a [`MonitorCheck`]. Decode the
/// entries of [`MonitorCheck::target_results`] into this when the target's
/// `type` is `"search"`.
#[serde_with::skip_serializing_none]
#[derive(Deserialize, Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase", tag = "type", rename = "search")]
pub struct MonitorSearchTargetResult {
    pub target_id: String,
    pub search_completed: Option<bool>,
    pub result_count: Option<u32>,
    pub matches: Option<u32>,
    pub summary: Option<String>,
    pub judge_degraded: Option<bool>,
    pub degraded_reason: Option<String>,
    pub search_credits: Option<f64>,
    pub judge_credits: Option<f64>,
    pub results_judged: Option<u32>,
}

#[derive(Deserialize, Serialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MonitorSummary {
    pub total_pages: u32,
    pub same: u32,
    pub changed: u32,
    pub new: u32,
    pub removed: u32,
    pub error: u32,
}

#[derive(Deserialize, Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Monitor {
    pub id: String,
    pub name: String,
    pub status: String,
    pub schedule: MonitorSchedule,
    pub next_run_at: Option<String>,
    pub last_run_at: Option<String>,
    pub current_check_id: Option<String>,
    pub targets: Vec<Value>,
    pub webhook: Option<Value>,
    pub notification: Option<Value>,
    pub retention_days: u32,
    pub estimated_credits_per_month: Option<u32>,
    pub last_check_summary: Option<MonitorSummary>,
    pub goal: Option<String>,
    #[serde(default)]
    pub judge_enabled: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Deserialize, Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MonitorCheck {
    pub id: String,
    pub monitor_id: String,
    pub status: String,
    pub trigger: String,
    pub scheduled_for: Option<String>,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub estimated_credits: Option<u32>,
    pub reserved_credits: Option<u32>,
    pub actual_credits: Option<u32>,
    pub billing_status: String,
    pub summary: MonitorSummary,
    pub target_results: Option<Value>,
    pub notification_status: Option<Value>,
    pub error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// Per-field diff entry returned for monitors that requested JSON extraction.
#[derive(Deserialize, Serialize, Debug, Clone)]
pub struct MonitorJsonFieldDiff {
    pub previous: Value,
    pub current: Value,
}

/// Diff payload returned alongside a monitor page when its scrape produced
/// a change. The shape depends on what the monitor's formats asked for:
///
/// - markdown-only monitors  → `text` is the unified diff and `json` is
///   the `parseDiff` AST (a `{ "files": [...] }` object).
/// - JSON-extraction monitors → `json` is the per-field
///   `{ previous, current }` map and `text` is absent.
/// - mixed (JSON + git-diff) monitors → both `text` (markdown sidecar)
///   and `json` (field-level diff) are present.
///
/// `json` is kept as a raw [`serde_json::Value`] so callers can decode it
/// into either shape (`HashMap<String, MonitorJsonFieldDiff>` for the
/// field-diff case, or a `{ files: [...] }` struct for the parseDiff AST).
#[derive(Deserialize, Serialize, Debug, Clone)]
pub struct MonitorPageDiff {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub json: Option<Value>,
}

/// Snapshot of the current JSON extraction at this run. Present on JSON
/// and mixed-mode monitors; absent for markdown-only.
#[derive(Deserialize, Serialize, Debug, Clone)]
pub struct MonitorPageSnapshot {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub json: Option<Value>,
}

/// Judge's verdict on whether a page change is meaningful. Populated on
/// monitor check pages when the monitor has a `goal` set and judging is
/// enabled.
#[derive(Deserialize, Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MonitorPageJudgment {
    pub meaningful: bool,
    pub confidence: String,
    pub reason: String,
    pub fields: Vec<String>,
}

#[derive(Deserialize, Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MonitorCheckPage {
    pub id: String,
    pub target_id: String,
    pub url: String,
    pub status: String,
    pub previous_scrape_id: Option<String>,
    pub current_scrape_id: Option<String>,
    pub status_code: Option<u16>,
    pub error: Option<String>,
    pub metadata: Option<Value>,
    pub diff: Option<MonitorPageDiff>,
    pub snapshot: Option<MonitorPageSnapshot>,
    pub judgment: Option<MonitorPageJudgment>,
    pub created_at: String,
}

#[derive(Deserialize, Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MonitorCheckDetail {
    #[serde(flatten)]
    pub check: MonitorCheck,
    pub pages: Vec<MonitorCheckPage>,
    pub next: Option<String>,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
struct DataResponse<T> {
    data: T,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
struct SuccessResponse {
    success: bool,
}

fn query(limit: Option<u32>, offset: Option<u32>, status: Option<&str>) -> String {
    let mut params = Vec::new();
    if let Some(limit) = limit {
        params.push(format!("limit={}", limit));
    }
    if let Some(offset) = offset {
        params.push(format!("offset={}", offset));
    }
    if let Some(status) = status {
        params.push(format!("status={}", status));
    }
    if params.is_empty() {
        String::new()
    } else {
        format!("?{}", params.join("&"))
    }
}

fn check_page_query(limit: Option<u32>, skip: Option<u32>, status: Option<&str>) -> String {
    let mut params = Vec::new();
    if let Some(limit) = limit {
        params.push(format!("limit={}", limit));
    }
    if let Some(skip) = skip {
        params.push(format!("skip={}", skip));
    }
    if let Some(status) = status {
        params.push(format!("status={}", status));
    }
    if params.is_empty() {
        String::new()
    } else {
        format!("?{}", params.join("&"))
    }
}

impl Client {
    pub async fn create_monitor(
        &self,
        request: CreateMonitorRequest,
    ) -> Result<Monitor, FirecrawlError> {
        let response = self
            .client
            .post(self.url("/monitor"))
            .headers(self.prepare_headers(None))
            .json(&request)
            .send()
            .await
            .map_err(|e| FirecrawlError::HttpError("Creating monitor".to_string(), e))?;

        let response: DataResponse<Monitor> =
            self.handle_response(response, "create monitor").await?;
        Ok(response.data)
    }

    pub async fn list_monitors(
        &self,
        limit: Option<u32>,
        offset: Option<u32>,
    ) -> Result<Vec<Monitor>, FirecrawlError> {
        let response = self
            .client
            .get(self.url(&format!("/monitor{}", query(limit, offset, None))))
            .headers(self.prepare_headers(None))
            .send()
            .await
            .map_err(|e| FirecrawlError::HttpError("Listing monitors".to_string(), e))?;

        let response: DataResponse<Vec<Monitor>> =
            self.handle_response(response, "list monitors").await?;
        Ok(response.data)
    }

    pub async fn get_monitor(
        &self,
        monitor_id: impl AsRef<str>,
    ) -> Result<Monitor, FirecrawlError> {
        let response = self
            .client
            .get(self.url(&format!("/monitor/{}", monitor_id.as_ref())))
            .headers(self.prepare_headers(None))
            .send()
            .await
            .map_err(|e| FirecrawlError::HttpError("Getting monitor".to_string(), e))?;

        let response: DataResponse<Monitor> = self.handle_response(response, "get monitor").await?;
        Ok(response.data)
    }

    pub async fn update_monitor(
        &self,
        monitor_id: impl AsRef<str>,
        request: UpdateMonitorRequest,
    ) -> Result<Monitor, FirecrawlError> {
        let response = self
            .client
            .patch(self.url(&format!("/monitor/{}", monitor_id.as_ref())))
            .headers(self.prepare_headers(None))
            .json(&request)
            .send()
            .await
            .map_err(|e| FirecrawlError::HttpError("Updating monitor".to_string(), e))?;

        let response: DataResponse<Monitor> =
            self.handle_response(response, "update monitor").await?;
        Ok(response.data)
    }

    pub async fn delete_monitor(
        &self,
        monitor_id: impl AsRef<str>,
    ) -> Result<bool, FirecrawlError> {
        let response = self
            .client
            .delete(self.url(&format!("/monitor/{}", monitor_id.as_ref())))
            .headers(self.prepare_headers(None))
            .send()
            .await
            .map_err(|e| FirecrawlError::HttpError("Deleting monitor".to_string(), e))?;

        let response: SuccessResponse = self.handle_response(response, "delete monitor").await?;
        Ok(response.success)
    }

    pub async fn run_monitor(
        &self,
        monitor_id: impl AsRef<str>,
    ) -> Result<MonitorCheck, FirecrawlError> {
        let response = self
            .client
            .post(self.url(&format!("/monitor/{}/run", monitor_id.as_ref())))
            .headers(self.prepare_headers(None))
            .json(&serde_json::json!({}))
            .send()
            .await
            .map_err(|e| FirecrawlError::HttpError("Running monitor".to_string(), e))?;

        let response: DataResponse<MonitorCheck> =
            self.handle_response(response, "run monitor").await?;
        Ok(response.data)
    }

    pub async fn list_monitor_checks(
        &self,
        monitor_id: impl AsRef<str>,
        limit: Option<u32>,
        offset: Option<u32>,
    ) -> Result<Vec<MonitorCheck>, FirecrawlError> {
        let path = format!(
            "/monitor/{}/checks{}",
            monitor_id.as_ref(),
            query(limit, offset, None)
        );
        let response = self
            .client
            .get(self.url(&path))
            .headers(self.prepare_headers(None))
            .send()
            .await
            .map_err(|e| FirecrawlError::HttpError("Listing monitor checks".to_string(), e))?;

        let response: DataResponse<Vec<MonitorCheck>> = self
            .handle_response(response, "list monitor checks")
            .await?;
        Ok(response.data)
    }

    pub async fn get_monitor_check(
        &self,
        monitor_id: impl AsRef<str>,
        check_id: impl AsRef<str>,
        limit: Option<u32>,
        skip: Option<u32>,
        status: Option<&str>,
    ) -> Result<MonitorCheckDetail, FirecrawlError> {
        let path = format!(
            "/monitor/{}/checks/{}{}",
            monitor_id.as_ref(),
            check_id.as_ref(),
            check_page_query(limit, skip, status)
        );
        let response = self
            .client
            .get(self.url(&path))
            .headers(self.prepare_headers(None))
            .send()
            .await
            .map_err(|e| FirecrawlError::HttpError("Getting monitor check".to_string(), e))?;

        let response: DataResponse<MonitorCheckDetail> =
            self.handle_response(response, "get monitor check").await?;
        let mut check = response.data;

        while let Some(next) = check.next.clone() {
            let response = self
                .client
                .get(self.pin_to_api_origin(&next)?)
                .headers(self.prepare_headers(None))
                .send()
                .await
                .map_err(|e| {
                    FirecrawlError::HttpError("Getting monitor check page".to_string(), e)
                })?;
            let response: DataResponse<MonitorCheckDetail> = self
                .handle_response(response, "get monitor check page")
                .await?;
            check.pages.extend(response.data.pages);
            check.next = response.data.next;
        }

        Ok(check)
    }

    pub async fn get_monitor_check_page(
        &self,
        monitor_id: impl AsRef<str>,
        check_id: impl AsRef<str>,
        limit: Option<u32>,
        skip: Option<u32>,
        status: Option<&str>,
    ) -> Result<MonitorCheckDetail, FirecrawlError> {
        let path = format!(
            "/monitor/{}/checks/{}{}",
            monitor_id.as_ref(),
            check_id.as_ref(),
            check_page_query(limit, skip, status)
        );
        let response = self
            .client
            .get(self.url(&path))
            .headers(self.prepare_headers(None))
            .send()
            .await
            .map_err(|e| FirecrawlError::HttpError("Getting monitor check".to_string(), e))?;

        let response: DataResponse<MonitorCheckDetail> =
            self.handle_response(response, "get monitor check").await?;
        Ok(response.data)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn search_target_serializes_to_camel_case_wire_format() {
        let target = MonitorSearchTarget {
            id: Some("t1".to_string()),
            queries: vec![
                "firecrawl funding".to_string(),
                "firecrawl news".to_string(),
            ],
            search_window: Some(MonitorSearchWindow::TwentyFourHours),
            include_domains: Some(vec!["techcrunch.com".to_string()]),
            exclude_domains: None,
            max_results: Some(10),
        };

        let json = serde_json::to_value(&target).unwrap();
        assert_eq!(json["type"], "search");
        assert_eq!(json["id"], "t1");
        assert_eq!(json["queries"][0], "firecrawl funding");
        assert_eq!(json["searchWindow"], "24h");
        assert_eq!(json["includeDomains"][0], "techcrunch.com");
        assert_eq!(json["maxResults"], 10);
        // skip_serializing_none drops absent fields.
        assert!(json.get("excludeDomains").is_none());
    }

    #[test]
    fn search_target_round_trips() {
        let raw = serde_json::json!({
            "type": "search",
            "queries": ["rust release"],
            "searchWindow": "7d",
            "maxResults": 5
        });
        let target: MonitorSearchTarget = serde_json::from_value(raw).unwrap();
        assert_eq!(target.queries, vec!["rust release".to_string()]);
        assert_eq!(target.search_window, Some(MonitorSearchWindow::SevenDays));
        assert_eq!(target.max_results, Some(5));
        assert!(target.id.is_none());
    }

    #[test]
    fn search_target_result_deserializes_from_wire_format() {
        let raw = serde_json::json!({
            "targetId": "t1",
            "type": "search",
            "searchCompleted": true,
            "resultCount": 12,
            "matches": 3,
            "summary": "Found new funding coverage",
            "judgeDegraded": false,
            "degradedReason": null,
            "searchCredits": 2.5,
            "judgeCredits": 1.0,
            "resultsJudged": 12
        });
        let result: MonitorSearchTargetResult = serde_json::from_value(raw).unwrap();
        assert_eq!(result.target_id, "t1");
        assert_eq!(result.search_completed, Some(true));
        assert_eq!(result.result_count, Some(12));
        assert_eq!(result.matches, Some(3));
        assert_eq!(
            result.summary.as_deref(),
            Some("Found new funding coverage")
        );
        assert_eq!(result.judge_degraded, Some(false));
        assert_eq!(result.degraded_reason, None);
        assert_eq!(result.search_credits, Some(2.5));
        assert_eq!(result.judge_credits, Some(1.0));
        assert_eq!(result.results_judged, Some(12));

        let json = serde_json::to_value(&result).unwrap();
        assert_eq!(json["type"], "search");
        assert_eq!(json["targetId"], "t1");
        assert_eq!(json["searchCredits"], 2.5);
    }

    #[tokio::test]
    async fn test_get_monitor_check_pins_next_to_api_origin() {
        use mockito::Matcher;

        let check = |next: Option<&str>, page_id: &str| {
            serde_json::json!({
                "success": true,
                "data": {
                    "id": "check-1",
                    "monitorId": "mon-1",
                    "status": "completed",
                    "trigger": "manual",
                    "billingStatus": "billed",
                    "summary": { "totalPages": 2, "same": 2, "changed": 0, "new": 0, "removed": 0, "error": 0 },
                    "createdAt": "2026-09-01T00:00:00Z",
                    "updatedAt": "2026-09-01T00:00:00Z",
                    "pages": [{
                        "id": page_id,
                        "targetId": "t1",
                        "url": "https://example.com",
                        "status": "same",
                        "createdAt": "2026-09-01T00:00:00Z"
                    }],
                    "next": next
                }
            })
            .to_string()
        };
        let mut server = mockito::Server::new_async().await;
        let mut other = mockito::Server::new_async().await;
        let foreign = other
            .mock("GET", Matcher::Any)
            .expect(0)
            .create_async()
            .await;
        let client = Client::new_selfhosted(server.url(), Some("test_key")).unwrap();
        let path = "/v2/monitor/mon-1/checks/check-1?skip=1";
        let mut nexts = vec![format!("{}{}", server.url(), path)];
        nexts.extend(crate::client::foreign_next_urls(
            &server.url(),
            &other.url(),
            path,
        ));

        for next in nexts {
            let first = server
                .mock("GET", "/v2/monitor/mon-1/checks/check-1")
                .with_status(200)
                .with_header("content-type", "application/json")
                .with_body(check(Some(&next), "p1"))
                .create_async()
                .await;
            let page = server
                .mock("GET", path)
                .match_header("authorization", "Bearer test_key")
                .with_status(200)
                .with_header("content-type", "application/json")
                .with_body(check(None, "p2"))
                .create_async()
                .await;

            let detail = client
                .get_monitor_check("mon-1", "check-1", None, None, None)
                .await
                .unwrap();

            assert_eq!(detail.pages.len(), 2, "next = {}", next);
            first.assert_async().await;
            page.assert_async().await;
        }
        foreign.assert_async().await;
    }
}
