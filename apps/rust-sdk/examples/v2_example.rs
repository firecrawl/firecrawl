//! Example usage of Firecrawl v2 API.
//!
//! Run with: cargo run --example v2_example

use firecrawl::v2::{
    AgentModel, AgentOptions, BatchScrapeOptions, Client, CrawlOptions, Format, MapOptions,
    ScrapeOptions, SearchOptions, SitemapMode,
};
use serde::Deserialize;
use serde_json::json;

#[tokio::main]
async fn main() {
    // Initialize the v2 Client with the API key
    let client = Client::new("fc-YOUR-API-KEY").expect("Failed to initialize Client");

    // Or, connect to a self-hosted instance:
    // let client = Client::new_selfhosted("http://localhost:3002", None::<&str>)
    //     .expect("Failed to initialize Client");

    // Example 1: Simple Scrape
    println!("=== Example 1: Simple Scrape ===");
    let result = client.scrape("https://example.com", None).await;
    match result {
        Ok(doc) => println!("Markdown: {:?}", doc.markdown),
        Err(e) => eprintln!("Scrape failed: {}", e),
    }

    // Example 2: Scrape with Options
    println!("\n=== Example 2: Scrape with Options ===");
    let options = ScrapeOptions {
        formats: Some(vec![Format::Markdown, Format::Html, Format::Links]),
        only_main_content: Some(true),
        ..Default::default()
    };
    let result = client.scrape("https://example.com", options).await;
    match result {
        Ok(doc) => {
            println!("Links: {:?}", doc.links);
        }
        Err(e) => eprintln!("Scrape with options failed: {}", e),
    }

    // Example 3: Scrape with JSON Schema Extraction
    println!("\n=== Example 3: JSON Schema Extraction ===");
    let schema = json!({
        "type": "object",
        "properties": {
            "title": { "type": "string" },
            "description": { "type": "string" }
        }
    });
    let result = client
        .scrape_with_schema(
            "https://example.com",
            schema,
            Some("Extract title and description"),
        )
        .await;
    match result {
        Ok(data) => println!(
            "Extracted: {}",
            serde_json::to_string_pretty(&data).unwrap()
        ),
        Err(e) => eprintln!("Schema extraction failed: {}", e),
    }

    // Example 4: Search
    println!("\n=== Example 4: Search ===");
    let options = SearchOptions {
        limit: Some(5),
        ..Default::default()
    };
    let result = client.search("rust programming", options).await;
    match result {
        Ok(response) => {
            if let Some(web) = response.data.web {
                for item in web {
                    match item {
                        firecrawl::v2::SearchResultOrDocument::WebResult(r) => {
                            println!("Result: {} - {}", r.url, r.title.unwrap_or_default());
                        }
                        firecrawl::v2::SearchResultOrDocument::Document(d) => {
                            if let Some(meta) = d.metadata {
                                println!("Document: {:?}", meta.title);
                            }
                        }
                    }
                }
            }
        }
        Err(e) => eprintln!("Search failed: {}", e),
    }

    // Example 5: Map a Website
    println!("\n=== Example 5: Map ===");
    let options = MapOptions {
        sitemap: Some(SitemapMode::Include),
        limit: Some(20),
        ..Default::default()
    };
    let result = client.map("https://example.com", options).await;
    match result {
        Ok(response) => {
            println!("Found {} links", response.links.len());
            for link in response.links.iter().take(5) {
                println!("  - {}", link.url);
            }
        }
        Err(e) => eprintln!("Map failed: {}", e),
    }

    // Example 6: Crawl a Website
    println!("\n=== Example 6: Crawl ===");
    let options = CrawlOptions {
        limit: Some(5),
        sitemap: Some(SitemapMode::Include),
        poll_interval: Some(3000),
        ..Default::default()
    };
    let result = client.crawl("https://example.com", options).await;
    match result {
        Ok(job) => {
            println!("Crawled {} pages", job.data.len());
            for doc in job.data.iter().take(3) {
                if let Some(meta) = &doc.metadata {
                    println!("  - {:?}", meta.source_url);
                }
            }
        }
        Err(e) => eprintln!("Crawl failed: {}", e),
    }

    // Example 7: Batch Scrape
    println!("\n=== Example 7: Batch Scrape ===");
    let urls = vec![
        "https://example.com".to_string(),
        "https://example.org".to_string(),
    ];
    let options = BatchScrapeOptions {
        options: Some(ScrapeOptions {
            formats: Some(vec![Format::Markdown]),
            ..Default::default()
        }),
        poll_interval: Some(2000),
        ..Default::default()
    };
    let result = client.batch_scrape(urls, options).await;
    match result {
        Ok(job) => {
            println!("Batch scraped {} pages", job.data.len());
        }
        Err(e) => eprintln!("Batch scrape failed: {}", e),
    }

    // Example 8: Agent (Autonomous Web Browsing)
    println!("\n=== Example 8: Agent ===");
    let options = AgentOptions {
        urls: Some(vec!["https://example.com".to_string()]),
        prompt: "Describe what this website is about and list any key features mentioned"
            .to_string(),
        model: Some(AgentModel::Spark1Pro),
        timeout: Some(60),
        ..Default::default()
    };
    let result = client.agent(options).await;
    match result {
        Ok(response) => {
            println!("Agent status: {:?}", response.status);
            if let Some(data) = response.data {
                println!("Result: {}", serde_json::to_string_pretty(&data).unwrap());
            }
        }
        Err(e) => eprintln!("Agent failed: {}", e),
    }

    // Example 9: Agent with Typed Schema
    println!("\n=== Example 9: Agent with Typed Schema ===");

    #[derive(Debug, Deserialize)]
    struct CompanyInfo {
        name: String,
        description: Option<String>,
        industry: Option<String>,
    }

    let schema = json!({
        "type": "object",
        "properties": {
            "name": { "type": "string" },
            "description": { "type": "string" },
            "industry": { "type": "string" }
        },
        "required": ["name"]
    });

    let result: Result<Option<CompanyInfo>, _> = client
        .agent_with_schema(
            vec!["https://firecrawl.dev".to_string()],
            "Extract company information from this website",
            schema,
        )
        .await;

    match result {
        Ok(Some(info)) => {
            println!("Company: {}", info.name);
            println!("Description: {:?}", info.description);
            println!("Industry: {:?}", info.industry);
        }
        Ok(None) => println!("No data extracted"),
        Err(e) => eprintln!("Agent with schema failed: {}", e),
    }

    println!("\n=== All examples completed ===");
}
