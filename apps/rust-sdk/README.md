# Firecrawl Rust SDK
The Firecrawl Rust SDK is a library that lets you easily search, scrape, and interact with the web for AI agents — returning clean Markdown or structured data your agents can ship with. It provides a simple and intuitive interface for the Firecrawl API.

## Installation

To install the Firecrawl Rust SDK, add the following to your `Cargo.toml`:

```toml
[dependencies]
firecrawl = "2.5.0"
tokio = { version = "^1", features = ["full"] }
```

To add it in your codebase.

## Usage

First, you need to obtain an API key from [firecrawl.dev](https://firecrawl.dev). Then, you need to initialize the `Client` like so:

```rust
use firecrawl::Client;

#[tokio::main]
async fn main() {
    let client = Client::new("fc-YOUR-API-KEY").expect("Failed to initialize Client");

    // ...
}
```

### Scraping a URL

To scrape a single URL, use the `scrape_url` method. It takes the URL as a parameter and returns the scraped data as a `Document`.

```rust
let scrape_result = app.scrape_url("https://firecrawl.dev", None).await;
match scrape_result {
    Ok(data) => println!("Scrape result:\n{}", data.markdown),
    Err(e) => eprintln!("Scrape failed: {}", e),
}
```

### Video extraction

Use `Format::Video` on supported video URLs, including YouTube and TikTok. The returned `video` field is a signed URL to the extracted video file.

```rust
use firecrawl::{Format, ScrapeOptions};

let options = ScrapeOptions {
    formats: Some(vec![Format::Video]),
    ..Default::default()
};

let doc = client
    .scrape("https://www.youtube.com/watch?v=dQw4w9WgXcQ", options)
    .await?;
println!("{:?}", doc.video);
```

### Product extraction

Use `Format::Product` on product pages for structured product extraction (title, price, availability, variants). The result is returned on the document's `product` field. This is the deterministic counterpart to the LLM-based `json` format.

```rust
use firecrawl::{Format, ScrapeOptions};

let options = ScrapeOptions {
    formats: Some(vec![Format::Product]),
    ..Default::default()
};

let doc = client
    .scrape("https://www.example.com/product/123", options)
    .await?;
println!("{:?}", doc.product);
```

### Menu extraction

Use `Format::Menu` on restaurant/menu pages for structured menu extraction (merchant, sections, items, prices, availability). The result is returned on the document's `menu` field. This is the deterministic counterpart to the LLM-based `json` format.

```rust
use firecrawl::{Format, ScrapeOptions};

let options = ScrapeOptions {
    formats: Some(vec![Format::Menu]),
    ..Default::default()
};

let doc = client
    .scrape("https://www.example.com/menu", options)
    .await?;
println!("{:?}", doc.menu);
```

### Parsing uploaded files (v2)

Use the v2 client `parse` method to upload local files (`html`, `pdf`, `docx`, etc.) as multipart form data.

```rust
use firecrawl::{Client, ParseFile, ParseFormat, ParseOptions};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let client = Client::new("fc-YOUR-API-KEY")?;

    let file = ParseFile::from_bytes(
        "upload.html",
        b"<!DOCTYPE html><html><body><h1>Rust Parse</h1></body></html>".to_vec(),
    )
    .with_content_type("text/html");

    let options = ParseOptions {
        formats: Some(vec![ParseFormat::Markdown]),
        ..Default::default()
    };

    let doc = client.parse(file, Some(options)).await?;
    println!("{:?}", doc.markdown);
    Ok(())
}
```

### Scraping with Extract

With Extract, you can easily extract structured data from any URL. You need to specify your schema in the JSON Schema format, using the `serde_json::json!` macro.

```rust
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
    formats: vec![ ScrapeFormats::Extract ].into(),
    extract: ExtractOptions {
        schema: json_schema.into(),
        ..Default::default()
    }.into(),
    ..Default::default()
};

let llm_extraction_result = app
    .scrape_url("https://news.ycombinator.com", llm_extraction_options)
    .await;

match llm_extraction_result {
    Ok(data) => println!("LLM Extraction Result:\n{:#?}", data.extract.unwrap()),
    Err(e) => eprintln!("LLM Extraction failed: {}", e),
}
```

### Crawling a Website

To crawl a website, use the `crawl_url` method. This will wait for the crawl to complete, which may take a long time based on your starting URL and your options.

```rust
let crawl_options = CrawlOptions {
    exclude_paths: vec![ "blog/*".into() ].into(),
    ..Default::default()
};

let crawl_result = app
    .crawl_url("https://mendable.ai", crawl_options)
    .await;

match crawl_result {
    Ok(data) => println!("Crawl Result (used {} credits):\n{:#?}", data.credits_used, data.data),
    Err(e) => eprintln!("Crawl failed: {}", e),
}
```

#### Crawling asynchronously

To crawl without waiting for the result, use the `crawl_url_async` method. It takes the same parameters, but it returns a `CrawlAsyncRespone` struct, containing the crawl's ID. You can use that ID with the `check_crawl_status` method to check the status at any time. Do note that completed crawls are deleted after 24 hours.

```rust
let crawl_id = app.crawl_url_async("https://mendable.ai", None).await?.id;

// ... later ...

let status = app.check_crawl_status(crawl_id).await?;

if status.status == CrawlStatusTypes::Completed {
    println!("Crawl is done: {:#?}", status.data);
} else {
    // ... wait some more ...
}
```

### Map a URL (Alpha)

Map all associated links from a starting URL.

```rust
let map_result = app
    .map_url("https://firecrawl.dev", None)
    .await;

match map_result {
    Ok(data) => println!("Mapped URLs: {:#?}", data),
    Err(e) => eprintln!("Map failed: {}", e),
}
```

### Scrape-bound interactive browsing (v2)

Use a scrape job ID to keep interacting with the replayed browser context:

```rust
use firecrawl::{Client, ScrapeExecuteLanguage, ScrapeExecuteOptions};

let client = Client::new("fc-YOUR-API-KEY")?;
let job_id = "550e8400-e29b-41d4-a716-446655440000";

let run = client
    .interact(
        job_id,
        ScrapeExecuteOptions {
            code: Some("console.log(await page.url())".to_string()),
            language: Some(ScrapeExecuteLanguage::Node),
            timeout: Some(60),
            ..Default::default()
        },
    )
    .await?;

println!("{:?}", run.stdout);
client.stop_interaction(job_id).await?;
```

## Error Handling

The SDK handles errors returned by the Firecrawl API and by our dependencies, and combines them into the `FirecrawlError` enum, implementing `Error`, `Debug` and `Display`. All of our methods return a `Result<T, FirecrawlError>`.

## Running the Tests with Cargo

To ensure the functionality of the Firecrawl Rust SDK, we have included end-to-end tests using `cargo`. These tests cover various aspects of the SDK, including URL scraping, web searching, and website crawling.

### Running the Tests

To run the tests, execute the following commands:
```bash
$ export $(xargs < ./tests/.env)
$ cargo test --test e2e_with_auth
```

## Contributing

Contributions to the Firecrawl Rust SDK are welcome! If you find any issues or have suggestions for improvements, please open an issue or submit a pull request on the GitHub repository.

## License

The Firecrawl Rust SDK is open-source and released under the [MIT License](https://opensource.org/licenses/MIT).
