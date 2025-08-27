from firecrawl.client import Firecrawl

# Initialize Firecrawl client
firecrawl = Firecrawl(api_key="YOUR_API_KEY")

# =============================================================================
# SCRAPE EXAMPLES
# =============================================================================

# Basic scraping - Get markdown content
print("=== Basic Scrape (Markdown) ===")
# doc = firecrawl.scrape("https://firecrawl.dev", formats=["markdown"])
# print(doc.markdown)

# Scraping with location settings
print("\n=== Scrape with Location Settings ===")
# doc = firecrawl.scrape('https://docs.firecrawl.dev',
#     formats=['markdown'],
#     location={
#         'country': 'US',
#         'languages': ['en']
#     }
# )
# print(doc)

# Scraping with JSON extraction using Pydantic schema
print("\n=== Scrape with JSON Schema (Pydantic) ===")
# from pydantic import BaseModel
# 
# class JsonSchema(BaseModel):
#     company_mission: str
#     supports_sso: bool
#     is_open_source: bool
#     is_in_yc: bool
# 
# result = firecrawl.scrape(
#     'https://firecrawl.dev',
#     formats=[{
#       "type": "json",
#       "schema": JsonSchema
#     }],
#     only_main_content=False,
#     max_age=120000000
# )
# print(result)

# Scraping with JSON extraction using prompt
print("\n=== Scrape with JSON Prompt ===")
# result = firecrawl.scrape(
#     'https://firecrawl.dev',
#     formats=[{
#       "type": "json",
#       "prompt": "Extract the company mission from the page."
#     }],
#     only_main_content=False,
#     timeout=120000
# )
# print(result.json["companyMission"])

# Advanced scraping with multiple formats and options
print("\n=== Advanced Scrape (Multiple Formats + Options) ===")
# response = firecrawl.scrape('https://docs.firecrawl.dev',
#     formats=[
#         'markdown',
#         { 'type': 'json', 'schema': { 'type': 'object', 'properties': { 'title': { 'type': 'string' } } } }
#     ],
#     proxy='auto',
#     max_age=600000,
#     only_main_content=True
# )
# print(response)

# =============================================================================
# CRAWL EXAMPLES
# =============================================================================

# Basic crawling
print("\n=== Basic Crawl ===")
# docs = firecrawl.crawl(url="https://docs.firecrawl.dev", limit=10)  
# print(docs)

# =============================================================================
# BATCH SCRAPE EXAMPLES
# =============================================================================

# Batch scraping multiple URLs
print("\n=== Batch Scrape ===")
# from firecrawl import Firecrawl
# 
# firecrawl = Firecrawl(api_key="fc-YOUR-API-KEY")
# 
# job = firecrawl.batch_scrape([
#     "https://firecrawl.dev",
#     "https://docs.firecrawl.dev",
# ], formats=["markdown"], poll_interval=2, wait_timeout=120)
# print(job)

# =============================================================================
# SEARCH EXAMPLES
# =============================================================================

# Search functionality
print("\n=== Search ===")
# search = firecrawl.search(query="firecrawl", sources=[{"type": "web"}], limit=5)
# print(search.web[0].title)

# =============================================================================
# MAP EXAMPLES
# =============================================================================

# Website mapping
print("\n=== Map Website ===")
# res = firecrawl.map(url="https://firecrawl.dev", limit=50, sitemap="include", search="price")
# print(res.links[0].url)
# print(res.links[1].url)
# print(res.links[2].url)
# print(res.links[3].url)

# =============================================================================
# EXTRACT EXAMPLES
# =============================================================================

# Data extraction with schema
print("\n=== Extract with Schema ===")
# schema = {
#     "type": "object",
#     "properties": {"title": {"type": "string"}},
#     "required": ["title"],
# }
# 
# res = firecrawl.extract(
#     urls=["https://docs.firecrawl.dev"],
#     prompt="Extract the page title",
#     schema=schema,
# )
# print(res.data["title"])