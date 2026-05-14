# Migration Guide: Firecrawl Self-Hosted Enhanced

## Breaking Changes Summary

### Agent API Enhancements
**Before (Hosted):**
```javascript
const result = await firecrawl.agent({
  urls: ["https://example.com"],
  prompt: "Extract data",
  maxCredits: 1000
});
```

**After (Self-Hosted Enhanced):**
```javascript
const result = await firecrawl.agent({
  urls: ["https://example.com"],
  prompt: "Extract data",
  maxDepth: 5,        // NEW: configurable research depth
  maxUrls: 20,        // NEW: configurable source limits
  timeLimit: 600,     // NEW: extended processing time
  formats: ["markdown", "json"], // NEW: multi-format output
  schema: {...}       // Enhanced structured extraction
});
```

### Response Format Changes
- Added `processingMode: "local-enhanced"`
- Added `capabilities: ["deep-research", "multi-source-analysis", ...]`
- Extended `expiresAt` to 7 days
- `creditsUsed` always 0 (no costs)

### Authentication
- Principal tokens (`principal_*`) for production
- API keys still supported for compatibility

### MCP Tools
- `firecrawl_agent`: Now supports enhanced parameters
- `firecrawl_agent_status`: Shows local processing indicators

## Benefits of Migration
- Unlimited processing (no API limits)
- Better AI research quality
- Configurable processing parameters
- Enhanced structured data extraction
- No credit costs or rate limits