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
    pub diff: Option<Value>,
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
                .get(next)
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
