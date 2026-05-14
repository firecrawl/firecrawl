# Firecrawl MCP Server Versioning

This document explains the versioning system for the Firecrawl MCP Server, which supports both legacy (V1) and modern (V2) versions of the Firecrawl API.

## Overview

The server provides versioned endpoints to maintain backward compatibility while supporting the latest Firecrawl features:

- **V1 (Legacy)**: Uses Firecrawl JS 1.29.3 with extended tools
- **V2 (Current)**: Uses Firecrawl JS 3.1.0 with modern API

## Endpoints

### Cloud Service (CLOUD_SERVICE=true)

When running in cloud mode, the server provides versioned endpoints:

#### V1 Endpoints (Legacy)
- **SSE**: `/:apiKey/sse`
- **Messages**: `/:apiKey/messages`

#### V2 Endpoints (Current)
- **SSE**: `/:apiKey/v2/sse`
- **Messages**: `/:apiKey/v2/messages`

#### Health Check
- **Health**: `/health`

### Local Service

Local services (stdio, SSE local, HTTP streamable) use the V2 implementation by default.

## Version Differences

### V1 (Firecrawl JS 1.29.3)
**Available Tools:**
- `firecrawl_scrape` - Uses `client.scrapeUrl()`
- `firecrawl_map` - Uses `client.mapUrl()`
- `firecrawl_crawl` - Uses `client.asyncCrawlUrl()`
- `firecrawl_check_crawl_status` - Uses `client.checkCrawlStatus()`
- `firecrawl_search` - Web search functionality
- `firecrawl_extract` - LLM-powered extraction
- `firecrawl_deep_research` - Deep research capabilities
- `firecrawl_generate_llmstxt` - Generate LLMs.txt files

**Key Features:**
- Legacy API parameter names (`ScrapeParams`, `MapParams`, `CrawlParams`)
- Deep research functionality
- LLMs.txt generation
- System prompt support in extraction

### V2 (Firecrawl JS 3.1.0)
**Available Tools:**
- `firecrawl_scrape` - Uses `client.scrape()`
- `firecrawl_map` - Uses `client.map()`
- `firecrawl_crawl` - Uses `client.crawl()`
- `firecrawl_check_crawl_status` - Uses `client.getCrawlStatus()`
- `firecrawl_search` - Enhanced web search
- `firecrawl_extract` - Improved extraction

**Key Features:**
- Modern API parameter names (`ScrapeOptions`, `MapOptions`)
- Enhanced JSON extraction with schema support
- Improved format handling
- Better caching with `maxAge` defaults
- Support for multiple search sources (web, images, news)

## Migration Guide

### From V1 to V2

1. **Update Endpoint URLs:**
   ```
   Old: /:apiKey/sse
   New: /:apiKey/v2/sse
   
   Old: /:apiKey/messages
   New: /:apiKey/v2/messages
   ```

2. **Tool Changes:**
   - Remove usage of `firecrawl_deep_research` and `firecrawl_generate_llmstxt`
   - Update extraction calls to use the new schema format
   - Leverage enhanced JSON extraction capabilities

3. **Parameter Updates:**
   - `maxAge` now defaults to 172800000ms (48 hours) instead of 0
   - `onlyMainContent` defaults to `true`
   - Enhanced format options with JSON extraction support

## Testing

Use the provided test script to verify endpoint functionality:

```bash
# Test all endpoints
npm run test:endpoints

# Test with custom URL and API key
TEST_BASE_URL=http://localhost:8080 TEST_API_KEY=your-key npm run test:endpoints
```

## Deployment

### Cloud Service
```bash
# Start versioned cloud server
npm run start:cloud
```

### Local Development
```bash
# Start local server (V2 by default)
npm start

# Start SSE local server
SSE_LOCAL=true npm start

# Start HTTP streamable server
HTTP_STREAMABLE_SERVER=true npm start
```

## Environment Variables

- `CLOUD_SERVICE=true` - Enable versioned cloud endpoints
- `FIRECRAWL_API_KEY` - Your Firecrawl API key
- `FIRECRAWL_API_URL` - Custom Firecrawl API URL (optional)
- `PORT` - Server port (default: 3000)

## Backward Compatibility

V1 endpoints will continue to be supported to ensure existing integrations work without modification. However, new features will only be added to V2.

## Support

For issues or questions about versioning:
1. Check the health endpoint: `/health`
2. Review the endpoint documentation above
3. Test with the provided test script
4. Open an issue on GitHub with version information
