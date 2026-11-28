import os
import json
import time
import requests
from dotenv import load_dotenv
from openai import OpenAI
from serpapi.google_search import GoogleSearch

class Colors:
    CYAN = '\033[96m'
    YELLOW = '\033[93m'
    GREEN = '\033[92m'
    RED = '\033[91m'
    RESET = '\033[0m'

# Load environment variables
load_dotenv()
client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))
firecrawl_api_key = os.getenv("FIRECRAWL_API_KEY")
serp_api_key = os.getenv("SERP_API_KEY")

def search_product(product_name):
    """Search for specific product pages."""
    amazon_search = GoogleSearch({
        "q": f"site:amazon.com/ {product_name} -renewed -refurbished",
        "num": 5,
        "api_key": serp_api_key
    })
    
    walmart_search = GoogleSearch({
        "q": f"site:walmart.com/ {product_name}",
        "num": 5,
        "api_key": serp_api_key
    })
    
    return (
        amazon_search.get_dict().get("organic_results", [])[:3],
        walmart_search.get_dict().get("organic_results", [])[:3]
    )

def get_product_urls(amazon_results, walmart_results):
    """Get the product URL from each platform and make sure it is the actual product instead of any accesories and also make sure it is from the original reseller, if not available return error.Make sure it's the same product not accesorries but the actual product."""
    amazon_url = next((r['link'] for r in amazon_results if '/dp/' in r['link']), None)
    walmart_url = next((r['link'] for r in walmart_results if '/ip/' in r['link']), None)
    
    if amazon_url or walmart_url:
        print(f"{Colors.CYAN}Found product URLs:{Colors.RESET}")
        if amazon_url:
            print(f"Amazon: {amazon_url}")
        if walmart_url:
            print(f"Walmart: {walmart_url}")
    
    return amazon_url, walmart_url

def poll_extraction(extraction_id, api_key, max_attempts=20):
    """Poll for extraction results with detailed logging."""
    url = f"https://api.firecrawl.dev/v1/extract/{extraction_id}"
    headers = {'Authorization': f'Bearer {api_key}'}
    
    for attempt in range(max_attempts):
        try:
            # print(f"{Colors.YELLOW}Polling attempt {attempt + 1}/{max_attempts}...{Colors.RESET}")
            response = requests.get(url, headers=headers)
            # print(f"Response status: {response.status_code}")
            
            print(f"Raw response: {response.text}")
            
            data = response.json()
            print(f"Parsed data: {json.dumps(data, indent=2)}")
            
            if data.get('success') and data.get('data'):
                print(f"Returning data: {json.dumps(data['data'], indent=2)}")
                return data['data']
            elif not data.get('success'):
                print(f"{Colors.RED}Polling failed: {data.get('error')}{Colors.RESET}")
            else:
                print(f"{Colors.YELLOW}Still processing...{Colors.RESET}")
            
            if attempt < max_attempts - 1:
                print(f"Waiting 10 seconds before retry...")
                time.sleep(10)
                
        except Exception as e:
            print(f"{Colors.RED}Polling error: {str(e)}{Colors.RESET}")
            if attempt < max_attempts - 1:
                print(f"Waiting 10 seconds before retry...")
                time.sleep(10)
            continue
            
    print(f"{Colors.RED}Extraction timed out after {max_attempts} attempts{Colors.RESET}")
    return None

def extract_product_info_and_reviews(urls):
    """Extract product information and reviews and the best URL from amazon or walmart according to the deal."""
    headers = {
        'Content-Type': 'application/json',
        'Authorization': f'Bearer {firecrawl_api_key}'
    }
    
    payload = {
        "urls": urls,
        "prompt": """
            Extract the following information for each product URL:
            1. Current price (as a number only)
            2. Stock status (in stock or out of stock)
            3. Shipping information
            4. Overall product rating
            5. Top 15 most helpful customer reviews
            6.Which URL has the cheapest price and the best deal between amazon and walmart
            
            Format the response as JSON with these exact keys:
            {
                "price": number,
                "stock_status": string,
                "shipping": string,
                "rating": number,
                "reviews": array of strings,
                "best_deal_url": string
            }
        """,
        "enableWebSearch": False
    }
    
    try:
        print(f"{Colors.YELLOW}Starting extraction...{Colors.RESET}")
        response = requests.post(
            "https://api.firecrawl.dev/v1/extract",
            headers=headers,
            json=payload,
            timeout=45
        )
        
        print(f"Response status: {response.status_code}")
        data = response.json()
        
        if not data.get('success'):
            print(f"{Colors.RED}Extraction failed: {data.get('error')}{Colors.RESET}")
            return None
            
        extraction_id = data.get('id')
        if not extraction_id:
            print(f"{Colors.RED}No extraction ID received{Colors.RESET}")
            return None
            
        print(f"{Colors.YELLOW}Waiting for results...{Colors.RESET}")
        return poll_extraction(extraction_id, firecrawl_api_key)

    except Exception as e:
        print(f"{Colors.RED}Extraction error: {str(e)}{Colors.RESET}")
        return None

def display_comparison(data):
    """Display price and review comparison with improved formatting and the best deal providing platform name between amazon and walmart."""
    if not data:
        print(f"{Colors.RED}No data to display{Colors.RESET}")
        return
        
    print(f"\n{Colors.CYAN}=== Product Comparison ==={Colors.RESET}")
    
    # Handle the data structure returned by Firecrawl
    if isinstance(data, dict):
        product_info = data
        
        print(f"\n{Colors.GREEN}Product Information:{Colors.RESET}")
        print(f"Price: ${product_info.get('price', 'N/A')}")
        print(f"Stock: {product_info.get('stock_status', 'N/A')}")
        print(f"Shipping: {product_info.get('shipping', 'N/A')}")
        print(f"Rating: {product_info.get('rating', 'N/A')}/5")
        print(f"Best URL to Buy From: {product_info.get('best_deal_url', 'N/A')}")
        
        reviews = product_info.get('reviews', [])
        if reviews:
            print(f"\n{Colors.YELLOW}Review Analysis:{Colors.RESET}")
            
            # Analyze reviews using OpenAI
            prompt = f"""Analyze these product reviews and provide:
            1. Top 3 most frequently mentioned PROS
            2. Top 3 most frequently mentioned CONS
            3. Overall sentiment (positive/negative/mixed)
            4. Provide the best URL to choose for buying the particular product
            
            Reviews: {' | '.join(reviews)}
            
            Response format:
            {{
                "pros": ["pro1", "pro2", "pro3"],
                "cons": ["con1", "con2", "con3"],
                "sentiment": "overall sentiment",
                "best url to buy from": "best url between amazon_url and walmart_url"
            }}
            """
            
            try:
                response = client.chat.completions.create(
                    model="gpt-5-mini",
                    messages=[{"role": "user", "content": prompt }],
                )
                
                analysis = json.loads(response.choices[0].message.content)
                
                print("\n📈 PROS:")
                for pro in analysis['pros']:
                    print(f"✓ {pro}")
                    
                print("\n📉 CONS:")
                for con in analysis['cons']:
                    print(f"✗ {con}")
                    
                print(f"\n🎯 Overall Sentiment: {analysis['sentiment']}")
                
            except Exception as e:
                print(f"{Colors.RED}Error analyzing reviews: {str(e)}{Colors.RESET}")
                
            print(f"\n{Colors.YELLOW}Sample Reviews:{Colors.RESET}")
            for i, review in enumerate(reviews[:5], 1):
                print(f"{i}. {review}")
            
            print(f"Best URL to Buy From: {product_info.get('best_deal_url', 'N/A')}")


def main():
    product_name = input(f"{Colors.CYAN}Enter product name to compare: {Colors.RESET}")
    
    # Search and get URLs
    amazon_results, walmart_results = search_product(product_name)
    amazon_url, walmart_url = get_product_urls(amazon_results, walmart_results)
    
    if not (amazon_url or walmart_url):
        print(f"{Colors.RED}No valid product URLs found.{Colors.RESET}")
        return
    
    # Extract info and reviews
    urls = [url for url in [amazon_url, walmart_url] if url]
    product_data = extract_product_info_and_reviews(urls)
    
    # Display results with improved formatting
    display_comparison(product_data)

if __name__ == "__main__":
    main()