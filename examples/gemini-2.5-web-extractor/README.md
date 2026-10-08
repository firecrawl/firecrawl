# Gemini 2.5 Web Extractor

A powerful web information extraction tool that combines Google's Gemini 2.5 Pro (Experimental) model with Firecrawl's web extraction capabilities to gather structured information about companies from the web.

## Features

- Uses Google Search (via SerpAPI) to find relevant web pages
- Leverages Gemini 2.5 Pro (Experimental) to intelligently select the most relevant URLs
- Extracts structured information using Firecrawl's advanced web extraction
- Real-time progress monitoring and colorized console output

## Prerequisites

- Python 3.10 or higher
- Google API Key (Gemini)
- Firecrawl API Key
- SerpAPI Key

## Setup

1. Clone the repository:

```bash
git clone <repository-url>
cd gemini-2.5-web-extractor
```

2. Install dependencies:

```bash
pip install -r requirements.txt
```

3. Set up environment variables:
   - Copy `.env.example` to `.env`
   - Fill in your API keys in the `.env` file:
     - `GOOGLE_API_KEY`: Your Google API key for Gemini
     - `FIRECRAWL_API_KEY`: Your Firecrawl API key
     - `SERP_API_KEY`: Your SerpAPI key

## Usage

Run the script:

```bash
python gemini-2.5-web-extractor.py
```

The script will:

1. Prompt you for a company name
2. Ask what information you want to extract about the company
3. Search for relevant web pages
4. Use Gemini to select the most relevant URLs
5. Extract structured information using Firecrawl
6. Display the results in a formatted JSON output

## Example

```bash
Enter the company name: Tesla
Enter what information you want about the company: latest electric vehicle models and their specifications
```

The script will then:

1. Search for relevant Tesla information
2. Select the most informative URLs about Tesla's current EV lineup
3. Extract and structure the vehicle specifications
4. Present the data in a clean, organized format

## Error Handling

The script includes comprehensive error handling for:

- API failures
- Network issues
- Invalid responses
- Timeout scenarios

All errors are clearly displayed with colored output for better visibility.

## License

[Add your license information here]
