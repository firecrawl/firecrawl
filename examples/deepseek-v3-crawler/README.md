# DeepSeek V3 Web Crawler

This script uses the DeepSeek V3 large language model (via Hugging Face's Inference API) and FireCrawl to crawl websites based on specific objectives.

## Prerequisites

- Python 3.10+
- A FireCrawl API key (get one at [FireCrawl's website](https://firecrawl.app))
- A Hugging Face API key with access to inference API

## Installation

1. Clone this repository:

```bash
git clone <repository-url>
cd <repository-directory>
```

2. Install the required packages:

```bash
pip install -r requirements.txt
```

3. Create a `.env` file in the root directory with your API keys:

```
FIRECRAWL_API_KEY=your_firecrawl_api_key
HUGGINGFACE_API_KEY=your_huggingface_api_key
```

## Usage

Run the script:

```bash
python deepseek-v3-crawler.py
```

The script will prompt you to:

1. Enter a website URL to crawl
2. Enter your objective (what information you're looking for)

The script will then:

- Use DeepSeek V3 to generate optimal search parameters for the website
- Map the website to find relevant pages
- Crawl the most relevant pages to extract information based on your objective
- Output the results in JSON format if successful

## Example

Input:

- Website: https://www.example.com
- Objective: Find information about their pricing plans

Output:

- The script will output structured JSON data containing the pricing information found on the website.

## Notes

- The script uses DeepSeek V3, an advanced language model, to analyze web content.
- The model is accessed via Hugging Face's Inference API.
- You may need to adjust temperature or max_new_tokens parameters in the script based on your needs.
