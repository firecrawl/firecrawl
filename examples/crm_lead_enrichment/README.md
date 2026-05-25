# CRM Lead Enrichment

This example enriches HubSpot company records by scraping company websites with Firecrawl, extracting useful business context with OpenAI, and writing the enriched fields back to HubSpot.

## What it does

1. Reads company records from HubSpot
2. Filters for companies with a website
3. Scrapes each website with Firecrawl
4. Extracts structured company context with OpenAI
5. Updates the matching HubSpot company record

## Use cases

* CRM cleanup
* Lead qualification
* Sales research
* Account enrichment
* Market segmentation

## Requirements

* Python 3.10+
* Firecrawl API key
* OpenAI API key
* HubSpot private app access token

## Setup

Create a local environment file:

```
cp .env.example .env
```

Install dependencies:

```
pip install firecrawl-py openai hubspot-api-client python-dotenv
```

Run the example:

```
python crm_lead_enrichment.py
```

## Environment variables

```
FIRECRAWL_API_KEY=fc-YOUR_API_KEY
OPENAI_API_KEY=sk-YOUR_API_KEY
HUBSPOT_API_KEY=pat-YOUR_HUBSPOT_PRIVATE_APP_TOKEN
```

## Example output

The script logs each company as it's processed and prints the extracted JSON fields before updating HubSpot.

```
{
  "is_open_source": false,
  "value_proposition": "Helps teams collect and use web data",
  "main_product": "Web scraping API",
  "potential_scraping_use": "Lead enrichment and account research"
}
```

## Notes

Only run this against CRM data and websites you're authorized to process.

Review extracted fields before using them in customer facing workflows.
