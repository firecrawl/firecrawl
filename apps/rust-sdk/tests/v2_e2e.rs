//! End-to-end tests for Firecrawl v2 API.
//!
//! These tests require the following environment variables:
//! - API_URL: The Firecrawl API URL
//! - TEST_API_KEY: A valid API key (optional for self-hosted)
//!
//! Run with: cargo test --test v2_e2e -- --ignored

use dotenvy::dotenv;
use firecrawl::v2::{
    AgentOptions, BatchScrapeOptions, Client, CrawlOptions, Format, MapOptions, ScrapeOptions,
    SearchOptions, SitemapMode,
};
use serde_json::json;
use std::env;

fn get_client() -> Client {
    dotenv().ok();
    let api_url = env::var("API_URL").expect("API_URL environment variable is required");
    let api_key = env::var("TEST_API_KEY").ok();
    Client::new_selfhosted(api_url, api_key).expect("Failed to create client")
}

#[tokio::test]
#[ignore = "Requires API access"]
async fn test_v2_scrape() {
    let client = get_client();
    let doc = client
        .scrape("https://example.com", None)
        .await
        .expect("Scrape should succeed");

    assert!(doc.markdown.is_some(), "Response should contain markdown");
}

#[tokio::test]
#[ignore = "Requires API access"]
async fn test_v2_scrape_with_options() {
    let client = get_client();
    let options = ScrapeOptions {
        formats: Some(vec![Format::Markdown, Format::Html, Format::Links]),
        only_main_content: Some(true),
        ..Default::default()
    };

    let doc = client
        .scrape("https://example.com", options)
        .await
        .expect("Scrape with options should succeed");

    assert!(doc.markdown.is_some(), "Response should contain markdown");
    assert!(doc.html.is_some(), "Response should contain html");
}

#[tokio::test]
#[ignore = "Requires API access"]
async fn test_v2_scrape_with_schema() {
    let client = get_client();

    let schema = json!({
        "type": "object",
        "properties": {
            "title": { "type": "string" },
            "description": { "type": "string" }
        }
    });

    let data = client
        .scrape_with_schema("https://example.com", schema, Some("Extract page info"))
        .await
        .expect("Schema scrape should succeed");

    assert!(data.is_object(), "Response should be a JSON object");
}

#[tokio::test]
#[ignore = "Requires API access"]
async fn test_v2_search() {
    let client = get_client();
    let response = client
        .search("rust programming", None)
        .await
        .expect("Search should succeed");

    assert!(response.success, "Response should indicate success");
}

#[tokio::test]
#[ignore = "Requires API access"]
async fn test_v2_search_with_options() {
    let client = get_client();
    let options = SearchOptions {
        limit: Some(5),
        ..Default::default()
    };

    let response = client
        .search("firecrawl web scraping", options)
        .await
        .expect("Search with options should succeed");

    assert!(response.success, "Response should indicate success");
}

#[tokio::test]
#[ignore = "Requires API access"]
async fn test_v2_map() {
    let client = get_client();
    let response = client
        .map("https://example.com", None)
        .await
        .expect("Map should succeed");

    assert!(response.success, "Response should indicate success");
}

#[tokio::test]
#[ignore = "Requires API access"]
async fn test_v2_map_with_options() {
    let client = get_client();
    let options = MapOptions {
        sitemap: Some(SitemapMode::Include),
        limit: Some(50),
        ..Default::default()
    };

    let response = client
        .map("https://example.com", options)
        .await
        .expect("Map with options should succeed");

    assert!(response.success, "Response should indicate success");
}

#[tokio::test]
#[ignore = "Requires API access"]
async fn test_v2_crawl_async() {
    let client = get_client();
    let response = client
        .start_crawl("https://example.com", None)
        .await
        .expect("Start crawl should succeed");

    assert!(response.success, "Response should indicate success");
    assert!(!response.id.is_empty(), "Response should contain job ID");

    // Check status
    let status = client
        .get_crawl_status(&response.id)
        .await
        .expect("Get crawl status should succeed");
    assert!(
        matches!(
            status.status,
            firecrawl::v2::JobStatus::Scraping | firecrawl::v2::JobStatus::Completed
        ),
        "Status should be scraping or completed"
    );

    // Cancel the crawl to clean up
    let _ = client.cancel_crawl(&response.id).await;
}

#[tokio::test]
#[ignore = "Requires API access"]
async fn test_v2_crawl_sync() {
    let client = get_client();
    let options = CrawlOptions {
        limit: Some(2),
        poll_interval: Some(2000),
        ..Default::default()
    };

    let job = client
        .crawl("https://example.com", options)
        .await
        .expect("Crawl should succeed");

    assert!(
        job.status == firecrawl::v2::JobStatus::Completed,
        "Job should be completed"
    );
}

#[tokio::test]
#[ignore = "Requires API access"]
async fn test_v2_batch_scrape_async() {
    let client = get_client();
    let urls = vec![
        "https://example.com".to_string(),
        "https://example.org".to_string(),
    ];

    let response = client
        .start_batch_scrape(urls, None)
        .await
        .expect("Start batch scrape should succeed");

    assert!(response.success, "Response should indicate success");
    assert!(!response.id.is_empty(), "Response should contain job ID");
}

#[tokio::test]
#[ignore = "Requires API access"]
async fn test_v2_batch_scrape_sync() {
    let client = get_client();
    let urls = vec!["https://example.com".to_string()];

    let options = BatchScrapeOptions {
        options: Some(ScrapeOptions {
            formats: Some(vec![Format::Markdown]),
            ..Default::default()
        }),
        poll_interval: Some(2000),
        ..Default::default()
    };

    let job = client
        .batch_scrape(urls, options)
        .await
        .expect("Batch scrape should succeed");

    assert!(
        job.status == firecrawl::v2::JobStatus::Completed,
        "Job should be completed"
    );
}

#[tokio::test]
#[ignore = "Requires API access"]
async fn test_v2_agent_async() {
    let client = get_client();
    let options = AgentOptions {
        urls: Some(vec!["https://example.com".to_string()]),
        prompt: "Describe what this website is about".to_string(),
        ..Default::default()
    };

    let response = client
        .start_agent(options)
        .await
        .expect("Start agent should succeed");

    assert!(response.success, "Response should indicate success");
    assert!(!response.id.is_empty(), "Response should contain task ID");
}

#[tokio::test]
#[ignore = "Requires API access"]
async fn test_v2_agent_with_schema() {
    let client = get_client();

    #[derive(Debug, serde::Deserialize)]
    #[allow(dead_code)]
    struct WebsiteInfo {
        title: Option<String>,
        description: Option<String>,
    }

    let schema = json!({
        "type": "object",
        "properties": {
            "title": { "type": "string" },
            "description": { "type": "string" }
        }
    });

    let result: Option<WebsiteInfo> = client
        .agent_with_schema(
            vec!["https://example.com".to_string()],
            "Extract the title and description",
            schema,
        )
        .await
        .expect("Agent with schema should succeed");

    // Agent may or may not return data depending on the page
    if let Some(info) = result {
        println!("Agent extracted: {:?}", info);
    }
}

// Test that the v2 client can be created with different configurations
// This test doesn't require API access
#[test]
fn test_v2_client_creation() {
    // Cloud client requires API key
    let cloud_result = Client::new("test-key");
    assert!(cloud_result.is_ok());

    // Cloud client without API key should fail
    let cloud_no_key = Client::new_selfhosted("https://api.firecrawl.dev", None::<&str>);
    assert!(cloud_no_key.is_err());

    // Self-hosted client without API key should work
    let selfhosted = Client::new_selfhosted("http://localhost:3000", None::<&str>);
    assert!(selfhosted.is_ok());

    // Self-hosted client with API key should work
    let selfhosted_with_key = Client::new_selfhosted("http://localhost:3000", Some("key"));
    assert!(selfhosted_with_key.is_ok());
}
