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
openai_api_key = os.getenv("OPENAI_API_KEY")
if not openai_api_key:
    print(f"{Colors.RED}Error: OPENAI_API_KEY not found in environment variables{Colors.RESET}")
    
client = OpenAI(api_key=openai_api_key)
firecrawl_api_key = os.getenv("FIRECRAWL_API_KEY")
serp_api_key = os.getenv("SERP_API_KEY")
tavily_api_key = os.getenv("TAVILY_API_KEY")

if not firecrawl_api_key:
    print(f"{Colors.RED}Warning: FIRECRAWL_API_KEY not found in environment variables{Colors.RESET}")

if not serp_api_key:
    print(f"{Colors.RED}Error: SERP_API_KEY not found in environment variables{Colors.RESET}")

def search_google(query, company):
    """Search Google using SerpAPI and return top results."""
    print(f"{Colors.YELLOW}Searching Google for information about {company}...{Colors.RESET}")
    if not serp_api_key:
        print(f"{Colors.RED}Cannot search Google: SERP_API_KEY is missing{Colors.RESET}")
        return []
    
    # Create a more effective search query
    search_query = f"{company} company {query}"
    
    params = {
        "q": search_query,
        "api_key": serp_api_key,
        "engine": "google",
        "google_domain": "google.com",
        "gl": "us",
        "hl": "en",
        "num": 10  # Request more results
    }
    
    try:
        search = GoogleSearch(params)
        results = search.get_dict()
        
        if "error" in results:
            print(f"{Colors.RED}SerpAPI Error: {results['error']}{Colors.RESET}")
            return []
        
        organic_results = results.get("organic_results", [])
        
        if not organic_results:
            print(f"{Colors.YELLOW}No organic results found, trying alternative search...{Colors.RESET}")
            # Try an alternative search
            alt_params = params.copy()
            alt_params["q"] = company
            
            try:
                alt_search = GoogleSearch(alt_params)
                alt_results = alt_search.get_dict()
                
                if "error" not in alt_results:
                    organic_results = alt_results.get("organic_results", [])
            except Exception as e:
                print(f"{Colors.RED}Error in alternative search: {str(e)}{Colors.RESET}")
        
        print(f"{Colors.GREEN}Found {len(organic_results)} search results{Colors.RESET}")
        return organic_results
    except Exception as e:
        print(f"{Colors.RED}Error in search_google: {str(e)}{Colors.RESET}")
        return []

def search_tavily(query, company):
    """Search the web using Tavily and return results in SerpAPI-compatible format."""
    search_query = f"{company} company {query}"
    print(f"{Colors.YELLOW}Searching with Tavily for information about {company}...{Colors.RESET}")
    client_tavily = TavilyClient(api_key=tavily_api_key)
    response = client_tavily.search(query=search_query, max_results=10)
    results = [{"title": r.get("title", ""), "link": r.get("url", ""), "snippet": r.get("content", "")}
               for r in response.get("results", [])]
    print(f"{Colors.GREEN}Found {len(results)} search results{Colors.RESET}")
    return results

def search_web(query, company):
    """Search the web using Tavily if available, otherwise fall back to SerpAPI."""
    if tavily_api_key and TavilyClient is not None:
        return search_tavily(query, company)
    return search_google(query, company)

def validate_official_source(url, company):
    """Check if a URL is likely an official company source."""
    company_name = company.lower().replace(" ", "")
    url_lower = url.lower()
    
    # Special cases
    if "ycombinator.com/companies/" in url_lower:
        return True
        
    if "workatastartup.com/companies/" in url_lower:
        return True
        
    if "crunchbase.com/organization/" in url_lower:
        return True
        
    if "producthunt.com" in url_lower:
        return True
        
    # Main domain check - more flexible approach
    domain = url_lower.split("//")[1].split("/")[0] if "//" in url_lower else url_lower
    
    # Company website usually has company name in domain
    company_terms = company_name.split()
    for term in company_terms:
        if len(term) > 3 and term in domain:  # Only match on significant terms
            return True
    
    # Common TLDs for tech companies
    if ".com" in url_lower or ".org" in url_lower or ".net" in url_lower or ".dev" in url_lower or ".io" in url_lower or ".ai" in url_lower:
        domain_without_tld = domain.split(".")[0]
        if company_name.replace(" ", "") in domain_without_tld.replace("-", "").replace(".", ""):
            return True
    
    # Explicitly non-official sources
    non_official_patterns = [
        "linkedin.com", "facebook.com", "twitter.com", 
        "instagram.com", "medium.com", "bloomberg.com"
    ]
    
    for pattern in non_official_patterns:
        if pattern in url_lower:
            return False
    
    # For any other domain that got through the filters, consider it potentially official
    return True

def select_urls_with_gpt(company, objective, serp_results):
    """
    Use GPT-4.1 to select URLs from SERP results.
    Returns a list of URLs.
    """
    try:
        serp_data = [{"title": r.get("title"), "link": r.get("link"), "snippet": r.get("snippet")} 
                     for r in serp_results if r.get("link")]
        
        print(f"{Colors.CYAN}Found {len(serp_data)} search results to analyze{Colors.RESET}")
        
        if not serp_data:
            print(f"{Colors.YELLOW}No search results found to analyze{Colors.RESET}")
            return []

        prompt = (
            "Task: Select the most relevant URLs from search results that contain factual information about the company.\n\n"
            "Instructions:\n"
            "1. Prioritize official company websites and documentation\n"
            "2. Select URLs that directly contain information about the requested topic\n"
            "3. Return ONLY a JSON object with the following structure: {\"selected_urls\": [\"url1\", \"url2\"]}\n"
            "4. Include up to 3 most relevant URLs\n"
            "5. Consider startup directories like Crunchbase, YCombinator, ProductHunt as good sources\n"
            "6. If official website is available, prioritize it first\n"
            f"Company: {company}\n"
            f"Information Needed: {objective}\n"
            f"Search Results: {json.dumps(serp_data, indent=2)}\n\n"
            "Response Format: {\"selected_urls\": [\"https://example.com\", \"https://example2.com\"]}\n"
        )

        try:
            print(f"{Colors.YELLOW}Calling OpenAI model...{Colors.RESET}")
            response = client.chat.completions.create(
                model="gpt-4.1",
                messages=[{"role": "user", "content": prompt}],
            )
            
            cleaned_response = response.choices[0].message.content.strip()

            import re
            json_match = re.search(r'\{[\s\S]*"selected_urls"[\s\S]*\}', cleaned_response)
            if json_match:
                cleaned_response = json_match.group(0)

            if cleaned_response.startswith('```'):
                cleaned_response = cleaned_response.split('```')[1]
                if cleaned_response.startswith('json'):
                    cleaned_response = cleaned_response[4:]
            cleaned_response = cleaned_response.strip()

            try:
                result = json.loads(cleaned_response)
                if isinstance(result, dict) and "selected_urls" in result:
                    urls = result["selected_urls"]
                else:
                    urls = []
            except json.JSONDecodeError:
                urls = [line.strip() for line in cleaned_response.split('\n') 
                       if line.strip().startswith(('http://', 'https://'))]

            cleaned_urls = [url.replace('/*', '').rstrip('/') for url in urls]
            cleaned_urls = [url for url in cleaned_urls if url]

            if not cleaned_urls:
                print(f"{Colors.YELLOW}No valid URLs found in response.{Colors.RESET}")
                return []

            for url in cleaned_urls:
                print(f"- {url} {Colors.RESET}")

            # Consider all selected URLs as valid sources
            return cleaned_urls[:3]  # Limit to top 3

        except Exception as e:
            print(f"{Colors.RED}Error calling OpenAI: {str(e)}{Colors.RESET}")
            return []

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
    
    enhanced_prompt = (
        f"Extract factual information about {prompt} for {company}.\n"
        f"Stick STRICTLY to information found on the provided URLs and DO NOT add any additional facts that are not explicitly mentioned.\n"
        f"Only extract information EXACTLY as stated in the source - no inferences or additions.\n"
        f"If information on {prompt} is not clearly provided in the source documents, just leave fields empty."
    )
    
    payload = {
        "urls": urls,
        "prompt": enhanced_prompt,
        "enableWebSearch": False
    }
    
    try:
        response = requests.post(
            "https://api.firecrawl.dev/v1/extract",
            headers=headers,
            json=payload,
            timeout=120
        )
        
        if response.status_code != 200:
            print(f"{Colors.RED}API returned status code {response.status_code}: {response.text}{Colors.RESET}")
            return None
            
        data = response.json()
        
        if not data.get('success'):
            print(f"{Colors.RED}API returned error: {data.get('error', 'No error message')}{Colors.RESET}")
            return None
        
        extraction_id = data.get('id')
        if not extraction_id:
            print(f"{Colors.RED}No extraction ID found in response.{Colors.RESET}")
            return None

        return poll_firecrawl_result(extraction_id, api_key, interval=5, max_attempts=120)

    except requests.exceptions.Timeout:
        print(f"{Colors.RED}Request timed out. The operation might still be processing in the background.{Colors.RESET}")
        print(f"{Colors.YELLOW}You may want to try again with fewer URLs or a more specific prompt.{Colors.RESET}")
        return None
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
                print(f"{Colors.GREEN}Data successfully extracted{Colors.RESET}")
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

def deduplicate_data(data):
    """Deduplicate data from the extraction results."""
    if not data:
        return data
    
    print(f"{Colors.YELLOW}Deduplicating extracted data...{Colors.RESET}")
    
    for key, value in data.items():
        if isinstance(value, list):
            if value and isinstance(value[0], dict):
                seen = set()
                unique_items = []
                
                for item in value:
                    item_tuple = tuple(sorted((k, str(v)) for k, v in item.items()))
                    
                    if item_tuple not in seen:
                        seen.add(item_tuple)
                        unique_items.append(item)
                
                data[key] = unique_items
                print(f"{Colors.GREEN}Deduplicated '{key}': removed {len(value) - len(unique_items)} duplicate entries{Colors.RESET}")
            
            else:
                unique_items = list(dict.fromkeys(value))
                data[key] = unique_items
                print(f"{Colors.GREEN}Deduplicated '{key}': removed {len(value) - len(unique_items)} duplicate entries{Colors.RESET}")
    
    return data

def consolidate_data(data, company):
    """Consolidate data by filling in missing fields and removing lower quality entries."""
    if not data:
        return data
    
    print(f"{Colors.YELLOW}Consolidating and validating data...{Colors.RESET}")
    
    for key, value in data.items():
        if isinstance(value, list) and value and isinstance(value[0], dict):
            if 'name' in value[0]:
                consolidated = {}
                
                for item in value:
                    name = item.get('name', '').strip().lower()
                    if not name:
                        continue
                        
                    if len(name) < 2 or len(name) > 50:
                        continue
                    
                    name_parts = name.split()
                    if len(name_parts) == 1:
                        found = False
                        for full_name in list(consolidated.keys()):
                            if full_name.startswith(name) or full_name.endswith(name):
                                found = True
                                break
                        if found:
                            continue
                    
                    if name not in consolidated or len(item) > len(consolidated[name]):
                        consolidated[name] = item
                    
                data[key] = list(consolidated.values())
                print(f"{Colors.GREEN}Consolidated '{key}': {len(value)} entries into {len(data[key])} unique entries{Colors.RESET}")
    
    # Clean up output data - remove empty fields
    for key, value in data.items():
        if isinstance(value, list):
            for item in value:
                if isinstance(item, dict):
                    # Remove empty string values
                    for field_key in list(item.keys()):
                        if item[field_key] == "":
                            # For 'role' field, set default to "Founder" if empty
                            if field_key == 'role':
                                item[field_key] = "Founder"
                            else:
                                del item[field_key]
    
    return data

def main():
    company = input(f"{Colors.BLUE}Enter the company name: {Colors.RESET}")
    objective = input(f"{Colors.BLUE}Enter what information you want about the company: {Colors.RESET}")
    
    serp_results = search_web(objective, company)
    if not serp_results:
        print(f"{Colors.RED}No search results found.{Colors.RESET}")
        return
    
    selected_urls = select_urls_with_gpt(company, objective, serp_results)
    
    if not selected_urls:
        print(f"{Colors.RED}No URLs were selected.{Colors.RESET}")
        return
    
    raw_data = extract_company_info(selected_urls, objective, company, firecrawl_api_key)
    
    if raw_data:
        deduped_data = deduplicate_data(raw_data)
        final_data = consolidate_data(deduped_data, company)
        print(json.dumps(final_data, indent=2))
        print(f"{Colors.GREEN}Extraction completed successfully.{Colors.RESET}")
    else:
        print(f"{Colors.RED}Failed to extract the requested information. Try refining your prompt or choosing a different company.{Colors.RESET}")

if __name__ == "__main__":
    main()