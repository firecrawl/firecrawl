# Fire Enrich

A powerful AI-powered CSV enrichment tool that transforms basic contact lists into comprehensive business intelligence data using specialized AI agents, web scraping, and intelligent data extraction.

## Overview

Fire Enrich is an advanced data enrichment platform that takes CSV files containing company email addresses and automatically enhances them with valuable business information. Built on a sophisticated multi-agent architecture, it leverages Firecrawl for web scraping and OpenAI GPT-4 for intelligent data extraction.

## Architecture

### Core Components

#### 1. Multi-Agent System
Fire Enrich employs five specialized AI agents, each optimized for specific data extraction tasks:

- **Company Research Agent**: Extracts company fundamentals (name, description, industry, employee count)
- **Fundraising Intelligence Agent**: Discovers funding rounds, investors, and valuation data
- **Executive Research Agent**: Identifies leadership teams, founders, and key personnel
- **Product & Technology Agent**: Uncovers product offerings, tech stack, and competitive landscape
- **Contact Information Agent**: Finds emails, phone numbers, and social media profiles

#### 2. Service Layer Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   Frontend UI   │────▶│   API Routes     │────▶│  Service Layer  │
│  (React/Next)   │     │   (SSE Stream)   │     │                 │
└─────────────────┘     └──────────────────┘     └─────────────────┘
                                                           │
                              ┌────────────────────────────┼────────────────────┐
                              │                            │                    │
                    ┌─────────▼────────┐      ┌───────────▼──────┐   ┌─────────▼────────┐
                    │ FirecrawlService │      │  OpenAIService   │   │SpecializedAgents│
                    │  (Web Scraping)  │      │ (GPT-4 Extract)  │   │   (AI Agents)    │
                    └──────────────────┘      └──────────────────┘   └──────────────────┘
```

#### 3. Data Flow Pipeline

1. **Email Parsing**: Intelligent extraction of company information from email patterns
2. **Search Query Generation**: Creates multiple targeted search queries per company
3. **Multi-Source Scraping**: Aggregates data from multiple websites
4. **AI Synthesis**: Combines and validates information using GPT-4
5. **Confidence Scoring**: Each field includes a 0-1 confidence score
6. **Source Attribution**: Tracks origin of each data point

### User Flow

#### Step 1: CSV Upload
```
User uploads CSV → Parse with Papa Parse → Auto-detect email columns → 
Extract unique domains → Preview data structure
```

#### Step 2: Field Configuration
```
Select email column → Choose enrichment fields → Add custom fields →
Toggle agent mode → Preview enrichment plan
```

#### Step 3: Real-time Enrichment
```
For each row:
├─ Extract company from email
├─ Generate search queries
├─ Scrape multiple sources (Firecrawl)
├─ Select specialized agents
├─ Extract structured data (GPT-4)
├─ Stream results via SSE
└─ Update UI with animations
```

#### Step 4: Export Results
```
View enriched data → Click for details → Download CSV/JSON →
Includes confidence scores and sources
```

## Setup Instructions

### Prerequisites

1. **Node.js** 18+ and npm/yarn/pnpm
2. **API Keys** (see below)

### API Key Configuration

Fire Enrich requires two API keys:

#### 1. Firecrawl API Key
- Sign up at [firecrawl.dev](https://firecrawl.dev)
- Get your API key from the dashboard
- Used for web scraping and search

#### 2. OpenAI API Key
- Sign up at [platform.openai.com](https://platform.openai.com)
- Create an API key with GPT-4 access
- Used for intelligent data extraction

### Installation

1. Clone the repository:
```bash
git clone <repository-url>
cd hostedTools
```

2. Install dependencies:
```bash
pnpm install
```

3. Configure environment variables:
```bash
# Create .env.local file
FIRECRAWL_API_KEY=your_firecrawl_key
OPENAI_API_KEY=your_openai_key
```

4. Run the development server:
```bash
pnpm dev
```

5. Open [http://localhost:3000/fire-enrich](http://localhost:3000/fire-enrich)

### Alternative: Browser-based API Keys

If you prefer not to use environment variables, Fire Enrich supports entering API keys directly in the browser:
1. Visit the Fire Enrich page
2. Click "Enter API Keys" when prompted
3. Keys are stored securely in localStorage

## Features

### Smart Email Detection
- Regex-based email column detection
- Domain extraction with edge case handling
- Company name inference from email patterns

### Agent-Based Enrichment
- Specialized agents for different data types
- Dynamic agent selection based on requested fields
- Parallel processing for efficiency

### Real-time Progress Tracking
- Server-Sent Events for live updates
- Animated cell population
- Progress indicators and status messages

### Flexible Field Selection
**Preset Fields:**
- Company Name
- Industry & Description
- Employee Count
- Revenue
- Headquarters Location
- Social Media Profiles
- Leadership Team
- And more...

**Custom Fields:**
- Natural language field generation
- AI interprets your requirements
- Examples:
  - "Find the CEO's email and LinkedIn"
  - "Get their main product pricing"
  - "Find recent news mentions"

### Export Options
- **CSV Format**: Original data + enriched columns
- **JSON Format**: Complete metadata and structure
- **Confidence Scores**: Data quality indicators
- **Source URLs**: Full attribution

## Technical Details

### Performance Optimizations
- Concurrent processing with rate limiting
- Smart caching of search results
- Deduplication of search queries
- 1-second delay between rows (API protection)

### Error Handling
- Graceful degradation on API failures
- Retry logic for transient errors
- Clear error messages in UI
- Fallback to basic extraction mode

### Data Quality
- Multi-source validation
- Confidence scoring algorithm
- Source diversity tracking
- Recent data prioritization

## Advanced Configuration

### Agent Mode vs Traditional Mode

**Agent Mode** (Recommended):
- Uses specialized AI agents
- Better accuracy for specific fields
- Higher quality extraction
- Slightly slower processing

**Traditional Mode**:
- Direct GPT-4 extraction
- Faster processing
- Good for simple fields
- Lower token usage

### Field Generation Tips

1. **Be Specific**: "CEO name and email" > "contact info"
2. **Separate Concerns**: One field per data type
3. **Use Examples**: "Revenue (e.g., $10M ARR)"
4. **Leverage Context**: Mention your use case

### Rate Limits

- **Firecrawl**: Check your plan limits
- **OpenAI**: GPT-4 token limits apply
- **Processing**: 1 row per second default
- **Max Fields**: 10 per enrichment
- **To set limit higher**: Feel free to pull the GitHub repo and deploy your own version

## Troubleshooting

### Common Issues

1. **"No API Keys Found"**
   - Check environment variables
   - Try browser-based key entry
   - Verify key validity

2. **Slow Enrichment**
   - Normal: ~5-15 seconds per row
   - Check API rate limits
   - Consider traditional mode

3. **Missing Data**
   - Some companies have limited online presence
   - Check confidence scores
   - Review source URLs

4. **Export Issues**
   - Ensure enrichment is complete
   - Check browser console for errors
   - Try different export format

## Privacy & Security

- **Local Storage**: API keys stored client-side only
- **No Data Retention**: Processed data not stored server-side
- **Secure Transmission**: HTTPS for all requests
- **Source Transparency**: All data sources tracked

## Best Practices

1. **Start Small**: Test with 5-10 rows first
2. **Review Fields**: Ensure fields match your needs
3. **Check Sources**: Verify data accuracy via source URLs
4. **Monitor Progress**: Watch for errors or timeouts
5. **Export Regularly**: Download results as you go

## Support

For issues or questions:
- Use this template: [https://github.com/mendableai/fire-enrich](https://github.com/mendableai/fire-enrich)
- Check the [GitHub Issues](https://github.com/mendableai/fire-enrich/issues)
- Review error messages and logs
- Ensure API keys have sufficient credits
