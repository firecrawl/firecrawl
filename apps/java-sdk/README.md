# Firecrawl Java SDK

Java SDK for the [Firecrawl](https://firecrawl.dev) v2 web scraping API.

## Prerequisites

Before using the Java SDK, ensure you have the following installed:

### Java Development Kit (JDK)

- **Required:** Java 11 or later
- **Installation (macOS):**
  ```bash
  brew install openjdk
  ```
  
  Then add Java to your PATH:
  ```bash
  echo 'export PATH="/opt/homebrew/opt/openjdk/bin:$PATH"' >> ~/.zshrc
  source ~/.zshrc
  ```

- **Installation (Linux):**
  ```bash
  # Ubuntu/Debian
  sudo apt-get update
  sudo apt-get install openjdk-11-jdk
  
  # Fedora/RHEL
  sudo dnf install java-11-openjdk-devel
  ```

- **Verify Installation:**
  ```bash
  java --version
  ```

### Gradle (for building from source)

- **Required:** Gradle 8+ 
- **Installation (macOS):**
  ```bash
  brew install gradle
  ```

- **Installation (Linux):**
  ```bash
  # Ubuntu/Debian
  sudo apt-get install gradle
  
  # Or use SDKMAN
  curl -s "https://get.sdkman.io" | bash
  sdk install gradle
  ```

- **Verify Installation:**
  ```bash
  gradle --version
  ```

### API Key Setup

1. Get your API key from [Firecrawl Dashboard](https://firecrawl.dev)
2. Set it as an environment variable:
   ```bash
   export FIRECRAWL_API_KEY="fc-your-api-key-here"
   ```

3. **Or** add it to your shell profile for persistence:
   ```bash
   # For Zsh (macOS/Linux)
   echo 'export FIRECRAWL_API_KEY="fc-your-api-key-here"' >> ~/.zshrc
   source ~/.zshrc
   
   # For Bash
   echo 'export FIRECRAWL_API_KEY="fc-your-api-key-here"' >> ~/.bashrc
   source ~/.bashrc
   ```

## Installation

### Gradle (Kotlin DSL)

```kotlin
implementation("com.firecrawl:firecrawl-java:1.0.0")
```

### Gradle (Groovy)

```groovy
implementation 'com.firecrawl:firecrawl-java:1.0.0'
```

### Maven

```xml
<dependency>
    <groupId>com.firecrawl</groupId>
    <artifactId>firecrawl-java</artifactId>
    <version>1.0.0</version>
</dependency>
```

## Quick Start

```java
import com.firecrawl.client.FirecrawlClient;
import com.firecrawl.models.*;
import java.util.List;

// Create client with explicit API key
FirecrawlClient client = FirecrawlClient.builder()
    .apiKey("fc-your-api-key")
    .build();

// Scrape a page
Document doc = client.scrape("https://example.com",
    ScrapeOptions.builder()
        .formats(List.of("markdown"))
        .build());

System.out.println(doc.getMarkdown());
```

Or create a client from the environment variable:

```java
// export FIRECRAWL_API_KEY=fc-your-api-key
FirecrawlClient client = FirecrawlClient.fromEnv();
```

## API Reference

### Scrape

Scrape a single URL and get the content in various formats.

```java
Document doc = client.scrape("https://example.com",
    ScrapeOptions.builder()
        .formats(List.of("markdown", "html"))
        .onlyMainContent(true)
        .waitFor(5000)
        .build());

System.out.println(doc.getMarkdown());
System.out.println(doc.getMetadata().get("title"));
```

#### JSON Extraction

```java
import com.firecrawl.models.JsonFormat;

JsonFormat jsonFmt = JsonFormat.builder()
    .prompt("Extract the product name and price")
    .schema(Map.of(
        "type", "object",
        "properties", Map.of(
            "name", Map.of("type", "string"),
            "price", Map.of("type", "number")
        )
    ))
    .build();

Document doc = client.scrape("https://example.com/product",
    ScrapeOptions.builder()
        .formats(List.of(jsonFmt))
        .build());

System.out.println(doc.getJson());
```

### Crawl

Crawl an entire website. The `crawl()` method polls until completion.

```java
// Convenience method — polls until done
CrawlJob job = client.crawl("https://example.com",
    CrawlOptions.builder()
        .limit(50)
        .maxDiscoveryDepth(3)
        .scrapeOptions(ScrapeOptions.builder()
            .formats(List.of("markdown"))
            .build())
        .build());

for (Document doc : job.getData()) {
    System.out.println(doc.getMetadata().get("sourceURL"));
}
```

#### Async Crawl (manual polling)

```java
CrawlResponse start = client.startCrawl("https://example.com",
    CrawlOptions.builder().limit(100).build());

System.out.println("Job started: " + start.getId());

// Poll manually
CrawlJob status;
do {
    try { Thread.sleep(2000); } catch (InterruptedException e) { Thread.currentThread().interrupt(); break; }
    status = client.getCrawlStatus(start.getId());
    System.out.println(status.getCompleted() + "/" + status.getTotal());
} while (!status.isDone());
```

### Batch Scrape

Scrape multiple URLs in parallel.

```java
BatchScrapeJob job = client.batchScrape(
    List.of("https://example.com", "https://example.org"),
    BatchScrapeOptions.builder()
        .options(ScrapeOptions.builder()
            .formats(List.of("markdown"))
            .build())
        .build());

for (Document doc : job.getData()) {
    System.out.println(doc.getMarkdown());
}
```

### Map

Discover all URLs on a website.

```java
MapData data = client.map("https://example.com",
    MapOptions.builder()
        .limit(100)
        .search("blog")
        .build());

for (Map<String, Object> link : data.getLinks()) {
    System.out.println(link.get("url") + " - " + link.get("title"));
}
```

### Search

Search the web and optionally scrape results.

```java
SearchData results = client.search("firecrawl web scraping",
    SearchOptions.builder()
        .limit(10)
        .build());

if (results.getWeb() != null) {
    for (Map<String, Object> result : results.getWeb()) {
        System.out.println(result.get("title") + " — " + result.get("url"));
    }
}
```

### Agent

Run an AI-powered agent to research and extract data from the web.

```java
AgentStatusResponse result = client.agent(
    AgentOptions.builder()
        .prompt("Find the pricing plans for Firecrawl and compare them")
        .build());

System.out.println(result.getData());
```

### Usage & Metrics

```java
ConcurrencyCheck conc = client.getConcurrency();
System.out.println("Concurrency: " + conc.getConcurrency() + "/" + conc.getMaxConcurrency());

CreditUsage credits = client.getCreditUsage();
System.out.println("Remaining credits: " + credits.getRemainingCredits());
```

## Async Support

All methods have async variants that return `CompletableFuture`:

```java
import java.util.concurrent.CompletableFuture;

CompletableFuture<Document> future = client.scrapeAsync(
    "https://example.com",
    ScrapeOptions.builder().formats(List.of("markdown")).build());

future.thenAccept(doc -> System.out.println(doc.getMarkdown()));
```

## Error Handling

The SDK throws unchecked exceptions:

```java
import com.firecrawl.errors.*;

try {
    Document doc = client.scrape("https://example.com");
} catch (AuthenticationException e) {
    // 401 — invalid API key
    System.err.println("Auth failed: " + e.getMessage());
} catch (RateLimitException e) {
    // 429 — too many requests
    System.err.println("Rate limited: " + e.getMessage());
} catch (JobTimeoutException e) {
    // Async job timed out
    System.err.println("Job " + e.getJobId() + " timed out after " + e.getTimeoutSeconds() + "s");
} catch (FirecrawlException e) {
    // All other API errors
    System.err.println("Error " + e.getStatusCode() + ": " + e.getMessage());
}
```

## Configuration

```java
FirecrawlClient client = FirecrawlClient.builder()
    .apiKey("fc-your-api-key")            // Required (or set FIRECRAWL_API_KEY env var)
    .apiUrl("https://api.firecrawl.dev")  // Optional (or set FIRECRAWL_API_URL env var)
    .timeoutMs(300_000)                   // HTTP timeout: 5 min default
    .maxRetries(3)                        // Auto-retries for transient failures
    .backoffFactor(0.5)                   // Exponential backoff factor (seconds)
    .asyncExecutor(myExecutor)            // Custom executor for async methods
    .build();
```

## Building from Source

### Clone and Build

```bash
# Clone the repository (if you haven't already)
git clone https://github.com/firecrawl/firecrawl.git
cd firecrawl/apps/java-sdk

# Build the project
gradle build
```

### Generate JAR

```bash
gradle jar
# Output: build/libs/firecrawl-java-1.0.0.jar
```

### Install Locally

```bash
gradle publishToMavenLocal
# Now available as: com.firecrawl:firecrawl-java:1.0.0 in local Maven repository
```

## Running Tests

The SDK includes both unit tests and E2E integration tests.

### Unit Tests (No API Key Required)

Unit tests verify SDK functionality without making actual API calls:

```bash
gradle test
```

### E2E Integration Tests (API Key Required)

E2E tests make real API calls and require a valid API key. These tests will be **skipped** if `FIRECRAWL_API_KEY` is not set:

```bash
# Set your API key
export FIRECRAWL_API_KEY="fc-your-api-key-here"

# Run all tests including E2E
gradle test
```

### Run Specific Tests

```bash
# Run only scrape tests
gradle test --tests "*testScrape*"

# Run only E2E tests
gradle test --tests "*E2E"

# Run specific test class
gradle test --tests "com.firecrawl.FirecrawlClientTest"
```

### View Test Results

After running tests, view the detailed report:

```bash
open build/reports/tests/test/index.html  # macOS
xdg-open build/reports/tests/test/index.html  # Linux
```

## Development Setup

If you're contributing to the SDK or testing local changes:

1. **Install Prerequisites** (see Prerequisites section above)

2. **Set Environment Variables:**
   ```bash
   export FIRECRAWL_API_KEY="fc-your-api-key"
   # Optional: use local API server
   export FIRECRAWL_API_URL="http://localhost:3002"
   ```

3. **Build and Test:**
   ```bash
   gradle clean build test
   ```

4. **Make Changes and Retest:**
   ```bash
   # Quick compilation check
   gradle compileJava
   
   # Run tests
   gradle test --tests "*testYourFeature*"
   ```
