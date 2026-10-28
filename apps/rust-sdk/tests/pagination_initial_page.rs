use firecrawl::{Client, FirecrawlError};
use serde_json::json;
use tokio::time::{timeout, Duration};

type TestResult = Result<(), Box<dyn std::error::Error>>;

fn page_body(kind: &str, next: Option<&str>, label: &str) -> String {
    if kind == "monitor" {
        json!({"success":true,"data":{
            "id":"owned","monitorId":"owned","status":"completed","trigger":"manual",
            "billingStatus":"billed","summary":{"totalPages":3,"same":3,"changed":0,"new":0,"removed":0,"error":0},
            "createdAt":"2026-10-10T00:00:00Z","updatedAt":"2026-10-10T00:00:00Z",
            "pages":[{"id":label,"targetId":"owned","url":"https://example.com",
                "status":"same","createdAt":"2026-10-10T00:00:00Z"}],"next":next
        }}).to_string()
    } else {
        json!({"status":"completed","total":3,"completed":3,
            "data":[{"markdown":label}],"next":next})
        .to_string()
    }
}

async fn fetch_labels(
    client: &Client,
    kind: &str,
    query: bool,
) -> Result<Vec<String>, FirecrawlError> {
    match kind {
        "crawl" => Ok(client
            .get_crawl_status("owned")
            .await?
            .data
            .into_iter()
            .map(|d| d.markdown.unwrap_or_default())
            .collect()),
        "batch" => Ok(client
            .get_batch_scrape_status("owned")
            .await?
            .data
            .into_iter()
            .map(|d| d.markdown.unwrap_or_default())
            .collect()),
        _ => Ok(client
            .get_monitor_check(
                "owned",
                "owned",
                query.then_some(1),
                query.then_some(0),
                query.then_some("same"),
            )
            .await?
            .pages
            .into_iter()
            .map(|p| p.id)
            .collect()),
    }
}

async fn initial_status_aliases(kind: &str) -> TestResult {
    for query in [false, true] {
        if query && kind != "monitor" {
            continue;
        }
        for return_after_page in [false, true] {
            for foreign_alias in [false, true] {
                let mut server = mockito::Server::new_async().await;
                let base_path = match kind {
                    "crawl" => "/v2/crawl/owned",
                    "batch" => "/v2/batch/scrape/owned",
                    _ => "/v2/monitor/owned/checks/owned",
                };
                let initial_path = format!(
                    "{}{}",
                    base_path,
                    if query {
                        "?limit=1&skip=0&status=same"
                    } else {
                        ""
                    }
                );
                // Both cursors normalize to the exact URL already requested.
                let alias = if foreign_alias {
                    format!("https://cursor.example{}#ignored", initial_path)
                } else {
                    initial_path.clone()
                };
                let page_path = format!("{}?skip=1", base_path);
                let first = server
                    .mock("GET", initial_path.as_str())
                    .match_header("authorization", "Bearer owned-key")
                    .with_status(200)
                    .with_header("content-type", "application/json")
                    .with_body(page_body(
                        kind,
                        Some(if return_after_page {
                            &page_path
                        } else {
                            &alias
                        }),
                        "first",
                    ))
                    .expect(1)
                    .create_async()
                    .await;
                let page = server
                    .mock("GET", page_path.as_str())
                    .with_status(200)
                    .with_header("content-type", "application/json")
                    .with_body(page_body(kind, Some(&alias), "second"))
                    .expect(usize::from(return_after_page))
                    .create_async()
                    .await;
                let client = Client::new_selfhosted(server.url(), Some("owned-key"))?;
                let result =
                    timeout(Duration::from_secs(5), fetch_labels(&client, kind, query)).await?;
                assert!(matches!(result, Err(FirecrawlError::Misuse(ref message))
                        if message == "repeated pagination cursor"));
                first.assert_async().await;
                page.assert_async().await;
            }
        }
    }
    Ok(())
}

async fn distinct_pages(kind: &str) -> TestResult {
    let mut server = mockito::Server::new_async().await;
    let path = match kind {
        "crawl" => "/v2/crawl/owned",
        "batch" => "/v2/batch/scrape/owned",
        _ => "/v2/monitor/owned/checks/owned",
    };
    let page_path = format!("{}?skip=1", path);
    let final_path = format!("{}?skip=2", path);
    let mut mocks = Vec::new();
    for (request_path, next, label) in [
        (path, Some(page_path.as_str()), "first"),
        (page_path.as_str(), Some(final_path.as_str()), "second"),
        (final_path.as_str(), None, "third"),
    ] {
        mocks.push(
            server
                .mock("GET", request_path)
                .match_header("authorization", "Bearer owned-key")
                .with_status(200)
                .with_header("content-type", "application/json")
                .with_body(page_body(kind, next, label))
                .expect(1)
                .create_async()
                .await,
        );
    }
    let client = Client::new_selfhosted(server.url(), Some("owned-key"))?;
    let labels = timeout(Duration::from_secs(5), fetch_labels(&client, kind, false)).await??;
    assert_eq!(labels, ["first", "second", "third"]);
    for mock in mocks {
        mock.assert_async().await;
    }
    Ok(())
}

#[tokio::test]
async fn crawl_initial_status_aliases() -> TestResult {
    initial_status_aliases("crawl").await
}

#[tokio::test]
async fn crawl_distinct_pages_keep_documents_in_order() -> TestResult {
    distinct_pages("crawl").await
}

#[tokio::test]
async fn batch_initial_status_aliases() -> TestResult {
    initial_status_aliases("batch").await
}

#[tokio::test]
async fn batch_distinct_pages_keep_documents_in_order() -> TestResult {
    distinct_pages("batch").await
}

#[tokio::test]
async fn monitor_initial_status_aliases() -> TestResult {
    initial_status_aliases("monitor").await
}

#[tokio::test]
async fn monitor_distinct_pages_keep_documents_in_order() -> TestResult {
    distinct_pages("monitor").await
}
