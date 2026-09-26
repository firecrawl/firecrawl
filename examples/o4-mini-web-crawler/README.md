# O4 Mini Web Crawler

A simple web crawler that uses Firecrawl and OpenAI's o4-mini model to search websites based on user objectives.

## Features

- Maps websites to find relevant URLs
- Uses AI to rank URLs by relevance to the objective
- Scrapes content and analyzes it with o4-mini
- Returns structured data when objectives are met

## Prerequisites

- Python 3.6+
- Firecrawl API key
- OpenAI API key

## Installation

1. Clone this repository
2. Install the required packages:
   ```
   pip install -r requirements.txt
   ```
3. Copy `.env.example` to `.env` and fill in your API keys:
   ```
   cp .env.example .env
   ```

## Usage

Run the script:

```
python o4-mini-web-crawler.py
```

You will be prompted to:

1. Enter a website URL to crawl
2. Define your objective (what information you're looking for)

The crawler will then:

- Map the website to find relevant URLs
- Rank the most relevant pages
- Scrape and analyze the content
- Return structured data if the objective is met

## Example

```
Enter the website to crawl: https://example.com
Enter your objective: Find the company's headquarters address
```

The crawler will search for pages likely to contain this information, analyze them, and return the address in a structured format.

## License

[MIT](../../LICENSE)
