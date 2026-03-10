use napi_derive::napi;
use serde::{Deserialize, Serialize};
use strsim::levenshtein;
use tokio::task;

/// Result of evaluating a single URL across different engines
#[derive(Deserialize, Serialize)]
#[napi(object)]
pub struct EngpickerUrlResult {
    pub url: String,
    pub cdp_basic_markdown: Option<String>,
    pub cdp_basic_success: bool,
    pub cdp_stealth_markdown: Option<String>,
    pub cdp_stealth_success: bool,
    pub tls_basic_markdown: Option<String>,
    pub tls_basic_success: bool,
    pub tls_stealth_markdown: Option<String>,
    pub tls_stealth_success: bool,
}

/// Verdict for a single URL
#[derive(Serialize)]
#[napi(object)]
pub struct EngpickerUrlVerdict {
    pub url: String,
    pub tls_client_sufficient: bool,
    pub cdp_failed: bool,
    pub similarity: Option<f64>,
    pub reason: String,
}

/// Final verdict enum
#[derive(Serialize)]
#[napi(string_enum)]
pub enum EngpickerFinalVerdict {
    /// tlsclient is sufficient for this site
    TlsClientOk,
    /// Chrome CDP is required for proper rendering
    ChromeCdpRequired,
    /// Too many CDP failures to determine verdict
    Uncertain,
}

/// Final verdict result
#[derive(Serialize)]
#[napi(object)]
pub struct EngpickerVerdict {
    pub url_verdicts: Vec<EngpickerUrlVerdict>,
    pub tls_client_ok_count: u32,
    pub chrome_cdp_required_count: u32,
    pub cdp_failed_count: u32,
    pub total_urls: u32,
    pub verdict: EngpickerFinalVerdict,
}

/// Compute engpicker verdict using Levenshtein distance to compare tlsclient vs chrome-cdp results.
/// 
/// Chrome-CDP is the gold standard. We compare tlsclient markdown against it to determine
/// if tlsclient is sufficient for scraping this site (i.e., JS rendering not required).
/// 
/// Arguments:
/// - results: scrape results for each URL
/// - similarity_threshold: minimum similarity (0.0-1.0) for tlsclient to be considered sufficient
/// - success_rate_threshold: minimum ratio of successful comparisons for a definitive verdict
/// - cdp_failure_threshold: maximum ratio of CDP failures before verdict becomes uncertain
#[napi]
pub async fn compute_engpicker_verdict(
    results: Vec<EngpickerUrlResult>,
    similarity_threshold: f64,
    success_rate_threshold: f64,
    cdp_failure_threshold: f64,
) -> napi::Result<EngpickerVerdict> {
    task::spawn_blocking(move || {
        _compute_engpicker_verdict(results, similarity_threshold, success_rate_threshold, cdp_failure_threshold)
    })
    .await
    .map_err(|e| {
        napi::Error::new(
            napi::Status::GenericFailure,
            format!("compute_engpicker_verdict join error: {e}"),
        )
    })?
}

fn _compute_engpicker_verdict(
    results: Vec<EngpickerUrlResult>,
    similarity_threshold: f64,
    success_rate_threshold: f64,
    cdp_failure_threshold: f64,
) -> napi::Result<EngpickerVerdict> {
    let url_verdicts: Vec<EngpickerUrlVerdict> = results
        .iter()
        .map(|result| {
            // Get the best chrome-cdp result as gold standard (prefer stealth if both succeeded)
            let gold_standard = if result.cdp_stealth_success && result.cdp_stealth_markdown.is_some() {
                result.cdp_stealth_markdown.as_ref()
            } else if result.cdp_basic_success && result.cdp_basic_markdown.is_some() {
                result.cdp_basic_markdown.as_ref()
            } else {
                None
            };

            // Get the best tlsclient result (prefer stealth if both succeeded)
            let tls_result = if result.tls_stealth_success && result.tls_stealth_markdown.is_some() {
                result.tls_stealth_markdown.as_ref()
            } else if result.tls_basic_success && result.tls_basic_markdown.is_some() {
                result.tls_basic_markdown.as_ref()
            } else {
                None
            };

            // If chrome-cdp failed, we can't evaluate this URL
            let gold_standard = match gold_standard {
                Some(gs) if !gs.is_empty() => gs,
                _ => {
                    return EngpickerUrlVerdict {
                        url: result.url.clone(),
                        tls_client_sufficient: false,
                        cdp_failed: true,
                        similarity: None,
                        reason: "chrome-cdp failed".to_string(),
                    };
                }
            };

            // If tlsclient failed entirely, it's definitely not enough
            let tls_result = match tls_result {
                Some(tls) if !tls.is_empty() => tls,
                _ => {
                    return EngpickerUrlVerdict {
                        url: result.url.clone(),
                        tls_client_sufficient: false,
                        cdp_failed: false,
                        similarity: None,
                        reason: "tlsclient failed".to_string(),
                    };
                }
            };

            // Calculate Levenshtein distance and normalize to similarity score
            let distance = levenshtein(gold_standard, tls_result);
            let max_length = gold_standard.len().max(tls_result.len());
            let similarity = if max_length > 0 {
                1.0 - (distance as f64 / max_length as f64)
            } else {
                1.0
            };

            let tls_client_sufficient = similarity >= similarity_threshold;

            let reason = if tls_client_sufficient {
                format!("{:.1}% similar - tlsclient captures full content", similarity * 100.0)
            } else {
                format!("{:.1}% similar - JS rendering likely required", similarity * 100.0)
            };

            EngpickerUrlVerdict {
                url: result.url.clone(),
                tls_client_sufficient,
                cdp_failed: false,
                similarity: Some(similarity),
                reason,
            }
        })
        .collect();

    let total_urls = url_verdicts.len() as u32;
    let cdp_failed_count = url_verdicts.iter().filter(|v| v.cdp_failed).count() as u32;
    let tls_client_ok_count = url_verdicts.iter().filter(|v| v.tls_client_sufficient).count() as u32;
    let chrome_cdp_required_count = url_verdicts.iter().filter(|v| !v.tls_client_sufficient && !v.cdp_failed).count() as u32;

    // Determine final verdict
    let verdict = if total_urls == 0 {
        EngpickerFinalVerdict::Uncertain
    } else {
        let cdp_failure_rate = cdp_failed_count as f64 / total_urls as f64;
        
        // If too many CDP failures, we can't make a confident verdict
        if cdp_failure_rate > cdp_failure_threshold {
            EngpickerFinalVerdict::Uncertain
        } else {
            // Calculate success rate among URLs where we could actually compare
            let comparable_urls = total_urls - cdp_failed_count;
            if comparable_urls == 0 {
                EngpickerFinalVerdict::Uncertain
            } else {
                let tls_ok_rate = tls_client_ok_count as f64 / comparable_urls as f64;
                if tls_ok_rate >= success_rate_threshold {
                    EngpickerFinalVerdict::TlsClientOk
                } else {
                    EngpickerFinalVerdict::ChromeCdpRequired
                }
            }
        }
    };

    Ok(EngpickerVerdict {
        url_verdicts,
        tls_client_ok_count,
        chrome_cdp_required_count,
        cdp_failed_count,
        total_urls,
        verdict,
    })
}

