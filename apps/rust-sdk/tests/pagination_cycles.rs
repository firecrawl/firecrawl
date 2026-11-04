use firecrawl::{Client, FirecrawlError};
use serde_json::json;
use tokio::time::{timeout, Duration};

async fn exercise(kind: &str, mode: &str) {
    let cycle = mode != "distinct";
    let mut server = mockito::Server::new_async().await;
    let path = match kind {
        "crawl" => "/v2/crawl/owned",
        "batch" => "/v2/batch/scrape/owned",
        _ => "/v2/monitor/owned/checks/owned",
    };
    let page_path = format!("{}?skip=1", path);
    let next = format!("{}{}", server.url(), page_path);
    let second_path = format!("{}?skip=2", path);
    let second_url = format!("{}{}", server.url(), second_path);
    let body = |next: Option<&str>| {
        if kind == "monitor" {
            json!({"success":true,"data":{"id":"owned","monitorId":"owned","status":"completed","trigger":"manual","billingStatus":"billed","summary":{"totalPages":0,"same":0,"changed":0,"new":0,"removed":0,"error":0},"createdAt":"2026-10-10T00:00:00Z","updatedAt":"2026-10-10T00:00:00Z","pages":[],"next":next}}).to_string()
        } else {
            json!({"status":"completed","total":0,"completed":0,"data":[],"next":next}).to_string()
        }
    };
    let first = server
        .mock("GET", path)
        .with_status(200)
        .with_header("content-type", "application/json")
        .with_body(body(Some(&next)))
        .expect(1)
        .create_async()
        .await;
    let page = server
        .mock("GET", page_path.as_str())
        .with_status(200)
        .with_header("content-type", "application/json")
        .with_body(body(Some(match mode {
            "alias" => &page_path,
            "two" | "distinct" => &second_url,
            _ => &next,
        })))
        .expect(1)
        .create_async()
        .await;
    let second = if mode == "two" || mode == "distinct" {
        Some(
            server
                .mock("GET", second_path.as_str())
                .with_status(200)
                .with_header("content-type", "application/json")
                .with_body(body(if mode == "two" { Some(&next) } else { None }))
                .expect(1)
                .create_async()
                .await,
        )
    } else {
        None
    };
    let client = Client::new_selfhosted(server.url(), Some("owned-key")).unwrap();
    let result = timeout(Duration::from_secs(1), async {
        match kind {
            "crawl" => client.get_crawl_status("owned").await.map(|_| ()),
            "batch" => client.get_batch_scrape_status("owned").await.map(|_| ()),
            _ => client
                .get_monitor_check("owned", "owned", None, None, None)
                .await
                .map(|_| ()),
        }
    })
    .await
    .expect("pagination must terminate before the caller deadline");
    if cycle {
        assert!(
            matches!(result, Err(FirecrawlError::Misuse(ref message)) if message.contains("repeated"))
        );
    } else {
        result.unwrap();
    }
    first.assert_async().await;
    page.assert_async().await;
    if let Some(second) = second {
        second.assert_async().await;
    }
}

#[tokio::test]
async fn crawl_repeated_cursor() {
    exercise("crawl", "self").await;
}
#[tokio::test]
async fn batch_repeated_cursor() {
    exercise("batch", "self").await;
}
#[tokio::test]
async fn monitor_repeated_cursor() {
    exercise("monitor", "self").await;
}
#[tokio::test]
async fn crawl_distinct_cursor() {
    exercise("crawl", "distinct").await;
}
#[tokio::test]
async fn batch_distinct_cursor() {
    exercise("batch", "distinct").await;
}
#[tokio::test]
async fn monitor_distinct_cursor() {
    exercise("monitor", "distinct").await;
}

#[tokio::test]
async fn crawl_two_page_cycle() {
    exercise("crawl", "two").await;
}
#[tokio::test]
async fn batch_two_page_cycle() {
    exercise("batch", "two").await;
}
#[tokio::test]
async fn monitor_two_page_cycle() {
    exercise("monitor", "two").await;
}
#[tokio::test]
async fn crawl_relative_alias_cycle() {
    exercise("crawl", "alias").await;
}
#[tokio::test]
async fn batch_relative_alias_cycle() {
    exercise("batch", "alias").await;
}
#[tokio::test]
async fn monitor_relative_alias_cycle() {
    exercise("monitor", "alias").await;
}
