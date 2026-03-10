use firecrawl::{
    crawl::CrawlOptions,
    scrape::{JsonOptions, ScrapeFormats, ScrapeOptions},
    FirecrawlApp,
};
use serde_json::json;

#[tokio::main]
async fn main() {
    // Initialize the FirecrawlApp with the API key
    let app = FirecrawlApp::new("fc-YOUR-API-KEY").expect("Failed to initialize FirecrawlApp");

    // Or, connect to a self-hosted instance:
    // let app = FirecrawlApp::new_selfhosted("http://localhost:3002", None).expect("Failed to initialize FirecrawlApp");

    // Scrape a website
    let scrape_result = app.scrape_url("https://firecrawl.dev", None).await;

    match scrape_result {
        Ok(data) => println!("Scrape Result:\n{}", data.markdown.unwrap()),
        Err(e) => eprintln!("Scrape failed: {:#?}", e),
    }

    // Crawl a website
    let crawl_options = CrawlOptions {
        exclude_paths: vec!["blog/*".into()].into(),
        ..Default::default()
    };

    let crawl_result = app.crawl_url("https://mendable.ai", crawl_options).await;

    match crawl_result {
        Ok(data) => println!(
            "Crawl Result (used {} credits):\n{:#?}",
            data.credits_used, data.data
        ),
        Err(e) => eprintln!("Crawl failed: {}", e),
    }

    // Scrape with Extract
    let json_schema = json!({
        "type": "object",
        "properties": {
            "top": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "title": {"type": "string"},
                        "points": {"type": "number"},
                        "by": {"type": "string"},
                        "commentsURL": {"type": "string"}
                    },
                    "required": ["title", "points", "by", "commentsURL"]
                },
                "minItems": 5,
                "maxItems": 5,
                "description": "Top 5 stories on Hacker News"
            }
        },
        "required": ["top"]
    });

    let llm_extraction_options = ScrapeOptions {
        formats: vec![ScrapeFormats::Json].into(),
        json_options: JsonOptions {
            schema: json_schema.into(),
            ..Default::default()
        }
        .into(),
        ..Default::default()
    };

    let llm_extraction_result = app
        .scrape_url("https://news.ycombinator.com", llm_extraction_options)
        .await;

    match llm_extraction_result {
        Ok(data) => println!("LLM Extraction Result:\n{:#?}", data.extract.unwrap()),
        Err(e) => eprintln!("LLM Extraction failed: {}", e),
    }

    // Map a website (Alpha)
    let map_result = app.map_url("https://firecrawl.dev", None).await;

    match map_result {
        Ok(data) => println!("Mapped URLs: {:#?}", data),
        Err(e) => eprintln!("Map failed: {}", e),
    }
}
