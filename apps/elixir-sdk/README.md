# Firecrawl

Auto-generated Elixir client for the [Firecrawl API v2](https://docs.firecrawl.dev/api-reference).

Built with [`Req`](https://hexdocs.pm/req) — minimal, idiomatic, auto-generated from the OpenAPI spec with [`NimbleOptions`](https://hexdocs.pm/nimble_options) validation.

## Installation

Add `firecrawl` to your list of dependencies in `mix.exs`:

```elixir
def deps do
  [
    {:firecrawl, "~> 1.4"}
  ]
end
```

## Configuration

Set your API key in application config:

```elixir
config :firecrawl, api_key: "fc-your-api-key"
```

Or pass it as an option to any function:

```elixir
Firecrawl.scrape_and_extract_from_url([url: "https://example.com"], api_key: "fc-your-api-key")
```

If no API key is found in config or options, a `RuntimeError` is raised with instructions.

## Usage

All params are passed as keyword lists with snake_case keys. Invalid keys, missing required params, and type errors are caught immediately by `NimbleOptions`.

```elixir
# Scrape a URL
{:ok, response} = Firecrawl.scrape_and_extract_from_url(
  url: "https://example.com",
  formats: ["markdown"]
)

# Extract video from supported video URLs
{:ok, response} = Firecrawl.scrape_and_extract_from_url(
  url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  formats: ["video"]
)

# Structured product extraction from product pages
# `product` pulls title, variants, and per-variant price/availability. It's
# the deterministic counterpart to the LLM `json` format. Read the result
# from the response body's "product" key.
{:ok, response} = Firecrawl.scrape_and_extract_from_url(
  url: "https://example.com/products/widget",
  formats: ["product"]
)

# Structured menu extraction from restaurant/menu pages
# `menu` pulls structured menu data (sections, items, prices). Read the
# result from the response body's "menu" key.
{:ok, response} = Firecrawl.scrape_and_extract_from_url(
  url: "https://example.com/menu",
  formats: ["menu"]
)

# Crawl a site
{:ok, response} = Firecrawl.crawl_urls(
  url: "https://example.com",
  limit: 100,
  sitemap: :skip
)

# Map URLs
{:ok, response} = Firecrawl.map_urls(url: "https://example.com")

# Search
{:ok, response} = Firecrawl.search_and_scrape(query: "firecrawl web scraping")

# Check crawl status
{:ok, response} = Firecrawl.get_crawl_status("job-uuid")

# Parse a file (PDF, DOCX, HTML, etc.)
{:ok, response} = Firecrawl.parse_file(
  [filename: "report.pdf", data: File.read!("report.pdf"), content_type: "application/pdf"],
  formats: ["markdown"]
)

# List the file formats parse_file accepts on this deployment
{:ok, formats} = Firecrawl.get_parse_formats()

for %Firecrawl.ParseFormat{format: format, kind: kind, mime_types: mime_types, available: true} <- formats do
  IO.puts("#{format} (#{kind}): #{Enum.join(mime_types, ", ")}")
end

# Self-hosted instance
{:ok, response} = Firecrawl.scrape_and_extract_from_url(
  [url: "https://example.com"],
  base_url: "https://your-instance.com/v2"
)
```

### Bang variants

Every function has a `!` variant that raises on error instead of returning `{:error, _}`:

```elixir
response = Firecrawl.scrape_and_extract_from_url!(url: "https://example.com")
```

## Regenerating from the OpenAPI Spec

The client is generated from the Firecrawl OpenAPI specification. To regenerate after spec changes:

```bash
mix run generate.exs
```

This will:

1. Fetch the latest OpenAPI JSON from GitHub
2. Generate all API wrapper functions in `lib/firecrawl.ex` and, if the code changed, save the spec it came from as `openapi.json`
3. Bump the version in `mix.exs` using semver (only if the generated code changed):
   - **Major** bump if public functions were removed (breaking change)
   - **Minor** bump if new public functions were added
   - **Patch** bump for any other changes (signatures, docs, etc.)

Re-running when nothing changed is a no-op, and the version is not bumped.

To regenerate without the network, from the vendored spec:

```bash
FIRECRAWL_OPENAPI_SPEC=openapi.json mix run generate.exs
```

Hand-written functions live between the `BEGIN HAND-WRITTEN` and `END HAND-WRITTEN` markers in `lib/firecrawl.ex`. The generator copies that region verbatim and skips the spec routes listed in `@hand_written_routes`, so edit code there rather than in generated functions. `mix test` fails if `lib/firecrawl.ex` differs from what the generator produces from `openapi.json`.

## License

MIT
