import json
import os
from dotenv import load_dotenv
from openai import OpenAI
from hubspot import HubSpot
from firecrawl import FirecrawlApp

# Load environment variables
load_dotenv()

# Initialize clients
def initialize_clients():
    firecrawl_api_key = os.getenv("FIRECRAWL_API_KEY")
    openai_api_key = os.getenv("OPENAI_API_KEY")
    hubspot_api_key = os.getenv("HUBSPOT_API_KEY")
    
    openai_client = OpenAI(api_key=openai_api_key)
    hubspot_client = HubSpot(access_token=hubspot_api_key)
    firecrawl_client = FirecrawlApp(api_key=firecrawl_api_key)
    
    return openai_client, hubspot_client, firecrawl_client

# Get list of companies from HubSpot
def get_companies_from_hubspot(hubspot_client):
    companies = []
    after = None
    while True:
        try:
            response = hubspot_client.crm.companies.basic_api.get_page(
                limit=100, 
                properties=["name", "website"],
                after=after
            )
            companies.extend(response.results)
            if not response.paging:
                break
            after = response.paging.next.after
        except Exception as e:
            print(f"Error fetching companies from HubSpot: {str(e)}")
            break
    return [company for company in companies if company.properties.get("website")]

# Scrape URL using Firecrawl
def scrape_url(firecrawl_client, url):
    try:
        return firecrawl_client.scrape_url(url, params={'formats': ['markdown']})
    except Exception as e:
        print(f"Error scraping URL {url}: {str(e)}")
        return None

# Extract information using OpenAI
def extract_info(openai_client, content):
    prompt = f"""
    Based on the markdown content, extract the following information in JSON format: 
    {{
        "is_open_source": boolean,
        "value_proposition": "string",
        "main_product": "string",
        "potential_scraping_use": "string"
    }}

    Are they open source?
    What is their value proposition?
    What are their main products?
    How could they use a web scraping service in one one their products?

    Markdown content:
    {content}

    Respond only with the JSON object, ensuring all fields are present even if the information is not found (use null in that case). Do not include the markdown code snippet like ```json or ``` at all in the response.
    """
    
    try:
        completion = openai_client.chat.completions.create(
            model="gpt-4o",
            messages=[{"role": "user", "content": prompt}]
        )
        return json.loads(completion.choices[0].message.content)
    except Exception as e:
        print(f"Error extracting information: {str(e)}")
        print(completion.choices[0].message.content)
        return None

# Update company properties in HubSpot
def update_hubspot(hubspot_client, company, extracted_info):
    try:
        hubspot_client.crm.companies.basic_api.update(
            company_id=company.id,
            simple_public_object_input={
                "properties": {
                    "is_open_source": str(extracted_info["is_open_source"]).lower(),
                    "value_prop": extracted_info["value_proposition"],
                    "main_products_offered": extracted_info["main_product"],
                    "how_they_can_use_scraping": extracted_info["potential_scraping_use"]
                }
            }
        )
        print(f"Successfully updated HubSpot for company {company.properties['name']}")
    except Exception as e:
        print(f"Error updating HubSpot for company {company.properties['name']}: {str(e)}")

# Main process
def main():
    openai_client, hubspot_client, firecrawl_client = initialize_clients()
    companies = get_companies_from_hubspot(hubspot_client)
    
    scraped_data = []
    for company in companies:
        company_name = company.properties.get("name", "Unknown")
        url = company.properties["website"]
        print(f"Processing {company_name} at {url}...")
        
        scrape_status = scrape_url(firecrawl_client, url)
        if not scrape_status:
            continue
        
        # the current SDK exposes the scraped body as `markdown` (v1's `content` field is gone)
        extracted_info = extract_info(openai_client, scrape_status["markdown"])
        if not extracted_info:
            continue
        
        update_hubspot(hubspot_client, company, extracted_info)
        
        scraped_data.append({
            "company": company_name,
            "url": url,
            "markdown": scrape_status["markdown"],
            "extracted_info": extracted_info
        })
        
        print(f"Successfully processed {company_name}")
        print(json.dumps(extracted_info, indent=2))

    print(f"Scraped, analyzed, and updated {len(scraped_data)} companies")

if __name__ == "__main__":
    main()
