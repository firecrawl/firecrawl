# GPT-4.1 Web Crawler

A smart web crawler powered by GPT-4.1 that intelligently searches websites to find specific information based on user objectives.

## Features

- Intelligently maps website content using semantic search
- Ranks website pages by relevance to your objective
- Extracts structured information using GPT-4.1
- Returns results in clean JSON format

## Prerequisites

- Python 3.8+
- Firecrawl API key
- OpenAI API key (with access to GPT-4.1 models)

## Installation

1. Clone this repository:

   ```
   git clone https://github.com/yourusername/gpt-4.1-web-crawler.git
   cd gpt-4.1-web-crawler
   ```

2. Install the required dependencies:

   ```
   pip install -r requirements.txt
   ```

3. Set up environment variables:
   ```
   cp .env.example .env
   ```
   Then edit the `.env` file and add your API keys.

## Usage

Run the script:

```
python gpt-4.1-web-crawler.py
```

The program will prompt you for:

1. The website URL to crawl
2. Your specific objective (what information you want to find)

Example:

```
Enter the website to crawl: https://example.com
Enter your objective: Find the company's leadership team with their roles and short bios
```

The crawler will then:

1. Map the website
2. Identify the most relevant pages
3. Scrape and analyze those pages
4. Return structured information if the objective is met

## How It Works

1. **Mapping**: The crawler uses Firecrawl to map the website structure and find relevant pages based on search terms derived from your objective.

2. **Ranking**: GPT-4.1 analyzes the URLs to determine which pages are most likely to contain the information you're looking for.

3. **Extraction**: The top pages are scraped and analyzed to extract the specific information requested in your objective.

4. **Results**: If found, the information is returned in a clean, structured JSON format.

## License

[MIT License](../../LICENSE)

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.
