# GPT-4.1 Company Researcher

A Python tool that uses GPT-4.1, Firecrawl, and SerpAPI to research companies and extract structured information.

## Features

- Search for company information using Google (via SerpAPI)
- Analyze search results with GPT-4.1 to identify relevant URLs
- Extract structured data from websites using Firecrawl
- Deduplicate and consolidate information for higher quality results
- Interactive command-line interface

## Requirements

- Python 3.10+
- OpenAI API key (with GPT-4.1 access)
- Firecrawl API key
- SerpAPI key

## Installation

1. Clone this repository
2. Install dependencies:
   ```
   pip install -r requirements.txt
   ```
3. Copy the `.env.example` file to `.env` and add your API keys:
   ```
   cp .env.example .env
   ```
4. Edit the `.env` file with your actual API keys

## Usage

Run the script:

```bash
python gpt-4.1-company-researcher.py
```

You will be prompted to:

1. Enter a company name
2. Specify what information you want about the company

The tool will then:

- Search for relevant information
- Select the most appropriate URLs using GPT-4.1
- Extract structured data using Firecrawl
- Deduplicate and consolidate the information
- Display the results in JSON format

## Example

```
Enter the company name: Anthropic
Enter what information you want about the company: founders and funding details

# Results will display structured information about Anthropic's founders and funding
```

## License

MIT
