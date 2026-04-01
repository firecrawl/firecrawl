import os
import json
import time
import requests
from dotenv import load_dotenv
from serpapi.google_search import GoogleSearch
try:
    from tavily import TavilyClient
except ImportError:
    TavilyClient = None
from openai import OpenAI

# ANSI color codes
class Colors:
    CYAN = '\033[96m'
    YELLOW = '\033[93m'
    GREEN = '\033[92m'
    RED = '\033[91m'
    MAGENTA = '\033[95m'
    BLUE = '\033[94m'
    RESET = '\033[0m'

# Load environment variables
load_dotenv()

# Initialize clients
openrouter_api_key = os.getenv("OPENROUTER_API_KEY")
firecrawl_api_key = os.getenv("FIRECRAWL_API_KEY")
serp_api_key = os.getenv("SERP_API_KEY")
tavily_api_key = os.getenv("TAVILY_API_KEY")

if not openrouter_api_key:
    print(f"{Colors.RED}Warning: OPENROUTER_API_KEY not found in environment variables{Colors.RESET}")
if not firecrawl_api_key:
    print(f"{Colors.RED}Warning: FIRECRAWL_API_KEY not found in environment variables{Colors.RESET}")
if not serp_api_key:
    print(f"{Colors.RED}Warning: SERP_API_KEY not found in environment variables{Colors.RESET}")

# Initialize OpenRouter client
client = OpenAI(
    base_url="https://openrouter.ai/api/v1",
    api_key=openrouter_api_key
)

def clean_url(url):
    """Clean a URL by removing tracking parameters and unnecessary query strings."""
    if not isinstance(url, str):
        return None
    
    # Remove any query parameters
    base_url = url.split('?')[0]
    
    # Remove trailing slashes and cleanup
    cleaned = base_url.rstrip('/')
    cleaned = cleaned.replace('/*', '')
    
    # Ensure it's a valid http(s) URL
    if not cleaned.startswith(('http://', 'https://')):
        return None
        
    return cleaned

def search_google(query):
    """Search Google using SerpAPI and return top results."""
    print(f"{Colors.YELLOW}Searching Google for '{query}'...{Colors.RESET}")
    search = GoogleSearch({"q": query, "api_key": serp_api_key})
    return search.get_dict().get("organic_results", [])

def search_tavily(query):
    """Search the web using Tavily and return results in SerpAPI-compatible format."""
    print(f"{Colors.YELLOW}Searching with Tavily for '{query}'...{Colors.RESET}")
    client_tavily = TavilyClient(api_key=tavily_api_key)
    response = client_tavily.search(query=query, max_results=10)
    return [{"title": r.get("title", ""), "link": r.get("url", ""), "snippet": r.get("content", "")}
            for r in response.get("results", [])]

def search_web(query):
    """Search the web using Tavily if available, otherwise fall back to SerpAPI."""
    if tavily_api_key and TavilyClient is not None:
        return search_tavily(query)
    return search_google(query)

def select_urls_with_claude(company, objective, serp_results):
    """
    Use Claude 3.7 Sonnet to select URLs from SERP results.
    Returns a list of URLs.
    """
    try:
        serp_data = [{"title": r.get("title"), "link": r.get("link"), "snippet": r.get("snippet")} 
                     for r in serp_results if r.get("link")]

        prompt = (
            "Task: Select relevant URLs from search results.\n\n"
            "Instructions:\n"
            "1. Analyze the search results for information about the specified company\n"
            "2. Select URLs that are most likely to contain the requested information\n"
            "3. Return ONLY a JSON object with the following structure: {\"selected_urls\": [\"url1\", \"url2\"]}\n"
            "4. Do not include social media links\n\n"
            f"Company: {company}\n"
            f"Information Needed: {objective}\n"
            f"Search Results: {json.dumps(serp_data, indent=2)}\n\n"
            "Response Format: {\"selected_urls\": [\"https://example.com\", \"https://example2.com\"]}"
        )

        # Using OpenRouter's API to select URLs
        response = client.chat.completions.create(
            model="deepseek/deepseek-chat-v3-0324:free",
            messages=[{
                "role": "system",
                "content": "You are a URL selection assistant. Your task is to select relevant URLs from search results. You MUST return a valid JSON object containing at least one URL."
            }, {
                "role": "user",
                "content": prompt
            }]
        )
        
        result = response.choices[0].message.content.strip()
        
        # Clean the response text
        if result.startswith('```'):
            result = result.split('```')[1]
            if result.startswith('json'):
                result = result[4:]
        result = result.strip()

        try:
            # Parse JSON response
            parsed_result = json.loads(result)
            if isinstance(parsed_result, dict) and "selected_urls" in parsed_result:
                urls = parsed_result["selected_urls"]
            else:
                # Fallback to text parsing
                urls = [line.strip() for line in result.split('\n') 
                       if line.strip().startswith(('http://', 'https://'))]
        except json.JSONDecodeError:
            # Fallback to text parsing
            urls = [line.strip() for line in result.split('\n') 
                   if line.strip().startswith(('http://', 'https://'))]

        # Clean up URLs
        cleaned_urls = [url.replace('/*', '').rstrip('/') for url in urls]
        cleaned_urls = [url for url in cleaned_urls if url]

        if not cleaned_urls:
            print(f"{Colors.YELLOW}No valid URLs found in response.{Colors.RESET}")
            return []

        print(f"{Colors.CYAN}Selected URLs for extraction:{Colors.RESET}")
        for url in cleaned_urls:
            print(f"- {url}")

        return cleaned_urls

    except Exception as e:
        print(f"{Colors.RED}Error selecting URLs: {str(e)}{Colors.RESET}")
        return []

def extract_company_info(urls, prompt, company, api_key):
    """Use requests to call Firecrawl's extract endpoint with selected URLs."""
    print(f"{Colors.YELLOW}Extracting structured data from the provided URLs using Firecrawl...{Colors.RESET}")
    
    headers = {
        'Content-Type': 'application/json',
        'Authorization': f'Bearer {api_key}'
    }
    
    payload = {
        "urls": urls,
        "prompt": prompt + " for " + company,
        "enableWebSearch": True
    }
    
    try:
        response = requests.post(
            "https://api.firecrawl.dev/v1/extract",
            headers=headers,
            json=payload,
            timeout=30
        )
        
        data = response.json()
        
        if not data.get('success'):
            print(f"{Colors.RED}API returned error: {data.get('error', 'No error message')}{Colors.RESET}")
            return None
        
        extraction_id = data.get('id')
        if not extraction_id:
            print(f"{Colors.RED}No extraction ID found in response.{Colors.RESET}")
            return None

        return poll_firecrawl_result(extraction_id, api_key)

    except requests.exceptions.RequestException as e:
        print(f"{Colors.RED}Request failed: {e}{Colors.RESET}")
        return None
    except json.JSONDecodeError as e:
        print(f"{Colors.RED}Failed to parse response: {e}{Colors.RESET}")
        return None
    except Exception as e:
        print(f"{Colors.RED}Failed to extract data: {e}{Colors.RESET}")
        return None

def poll_firecrawl_result(extraction_id, api_key, interval=10, max_attempts=60):
    """Poll Firecrawl API to get the extraction result."""
    url = f"https://api.firecrawl.dev/v1/extract/{extraction_id}"
    headers = {
        'Authorization': f'Bearer {api_key}'
    }

    print(f"{Colors.YELLOW}Waiting for extraction to complete...{Colors.RESET}")
    
    for attempt in range(1, max_attempts + 1):
        try:
            response = requests.get(url, headers=headers, timeout=30)
            response.raise_for_status()
            data = response.json()

            if data.get('success') and data.get('data'):
                print(f"{Colors.GREEN}Data successfully extracted:{Colors.RESET}")
                print(json.dumps(data['data'], indent=2))
                return data['data']
            elif data.get('success') and not data.get('data'):
                if attempt % 6 == 0:  
                    print(f"{Colors.YELLOW}Still processing... (attempt {attempt}/{max_attempts}){Colors.RESET}")
                time.sleep(interval)
            else:
                print(f"{Colors.RED}API Error: {data.get('error', 'No error message provided')}{Colors.RESET}")
                return None

        except requests.exceptions.RequestException as e:
            print(f"{Colors.RED}Request error: {str(e)}{Colors.RESET}")
            return None
        except json.JSONDecodeError as e:
            print(f"{Colors.RED}JSON parsing error: {str(e)}{Colors.RESET}")
            return None
        except Exception as e:
            print(f"{Colors.RED}Unexpected error: {str(e)}{Colors.RESET}")
            return None

    print(f"{Colors.RED}Max polling attempts reached. Extraction did not complete in time.{Colors.RESET}")
    return None

def main():
    company = input(f"{Colors.BLUE}Enter the company name: {Colors.RESET}")
    objective = input(f"{Colors.BLUE}Enter what information you want about the company: {Colors.RESET}")
    
    serp_results = search_web(f"{company}")
    if not serp_results:
        print(f"{Colors.RED}No search results found.{Colors.RESET}")
        return
    
    selected_urls = select_urls_with_claude(company, objective, serp_results)
    
    if not selected_urls:
        print(f"{Colors.RED}No URLs were selected.{Colors.RESET}")
        return
    
    data = extract_company_info(selected_urls, objective, company, firecrawl_api_key)
    
    if data:
        print(f"{Colors.GREEN}Extraction completed successfully.{Colors.RESET}")
    else:
        print(f"{Colors.RED}Failed to extract the requested information. Try refining your prompt or choosing a different company.{Colors.RESET}")

if __name__ == "__main__":
    main()