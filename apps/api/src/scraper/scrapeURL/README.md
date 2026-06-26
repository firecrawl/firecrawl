# `scrapeURL`

Single-URL scraper for Firecrawl.

## Signal flow

```mermaid
flowchart TD;
    scrapeURL --> meta[build meta];
    meta --> robots[robots check];
    robots --> index{index eligible?};
    index -- hit --> parser[parse engine result];
    index -- miss --> specialty{specialty URL?};
    specialty -- yes --> specialEngine[run specialty engine once];
    specialty -- no --> mainEngine[run configured main engine];
    mainEngine -- reliable retrieval error and proxy auto --> enhancedRetry[retry same main engine with enhanced proxy];
    specialEngine --> parser;
    mainEngine --> parser;
    enhancedRetry --> parser;
    parser --> document[document];
    document --> transformers[run transformers];
```

## Engine selection

- Feature support does not select engines. Unsupported features produce warnings on the returned document.
- Parsers materialize `Document` from `EngineScrapeResult`. HTML is the default parser; PDF and document parsers inspect fetched file payloads from the engine result.
- Specialty URL engines are terminal once selected.
- `proxy: "auto"` tries the main engine with basic proxy first, then retries the same main engine with enhanced proxy only when the engine raises `ReliableRetrievalError`.
