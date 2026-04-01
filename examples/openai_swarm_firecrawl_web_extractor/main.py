import os
from firecrawl import FirecrawlApp
from swarm import Agent
from swarm.repl import run_demo_loop
import dotenv
from serpapi import GoogleSearch
try:
    from tavily import TavilyClient
except ImportError:
    TavilyClient = None
from openai import OpenAI

dotenv.load_dotenv()

# Initialize FirecrawlApp and OpenAI
app = FirecrawlApp(api_key=os.getenv("FIRECRAWL_API_KEY"))
client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))

def search_google(query, objective):
    """Search Google using SerpAPI."""
    print(f"Parameters: query={query}, objective={objective}")
    search = GoogleSearch({"q": query, "api_key": os.getenv("SERP_API_KEY")})
    results = search.get_dict().get("organic_results", [])
    return {"objective": objective, "results": results}

def search_tavily(query, objective):
    """Search the web using Tavily."""
    print(f"Parameters: query={query}, objective={objective}")
    tavily_api_key = os.getenv("TAVILY_API_KEY")
    client_tavily = TavilyClient(api_key=tavily_api_key)
    response = client_tavily.search(query=query, max_results=10)
    results = [{"title": r.get("title", ""), "link": r.get("url", ""), "snippet": r.get("content", "")}
               for r in response.get("results", [])]
    return {"objective": objective, "results": results}

def search_web(query, objective):
    """Search the web using Tavily if available, otherwise fall back to SerpAPI."""
    tavily_api_key = os.getenv("TAVILY_API_KEY")
    if tavily_api_key and TavilyClient is not None:
        return search_tavily(query, objective)
    return search_google(query, objective)

def map_url_pages(url, objective):
    """Map a website's pages using Firecrawl."""
   
    search_query = generate_completion(
        "website search query generator",
        f"Generate a 1-2 word search query for the website: {url} based on the objective",
        "Objective: " + objective
    )
    print(f"Parameters: url={url}, objective={objective}, search_query={search_query}")
    map_status = app.map_url(url, params={'search': search_query})
    if map_status.get('status') == 'success':
        links = map_status.get('links', [])
        top_link = links[0] if links else None
        return {"objective": objective, "results": [top_link] if top_link else []}
    else:
        return {"objective": objective, "results": []}

def scrape_url(url, objective):
    """Scrape a website using Firecrawl."""
    print(f"Parameters: url={url}, objective={objective}")
    scrape_status = app.scrape_url(
        url,
        params={'formats': ['markdown']}
    )
    return {"objective": objective, "results": scrape_status}

def analyze_website_content(content, objective):
    """Analyze the scraped website content using OpenAI."""
    print(f"Parameters: content={content[:50]}..., objective={objective}")
    analysis = generate_completion(
        "website data extractor",
        f"Analyze the following website content and extract a JSON object based on the objective.",
        "Objective: " + objective + "\nContent: " + content
    )
    return {"objective": objective, "results": analysis}

def generate_completion(role, task, content):
    """Generate a completion using OpenAI."""
    print(f"Parameters: role={role}, task={task[:50]}..., content={content[:50]}...")
    response = client.chat.completions.create(
        model="gpt-4o",
        messages=[
            {"role": "system", "content": f"You are a {role}. {task}"},
            {"role": "user", "content": content}
        ]
    )
    return response.choices[0].message.content

def handoff_to_search_google():
    """Hand off the search query to the search google agent."""
    return google_search_agent

def handoff_to_map_url():
    """Hand off the url to the map url agent."""
    return map_url_agent

def handoff_to_website_scraper():
    """Hand off the url to the website scraper agent."""
    return website_scraper_agent

def handoff_to_analyst():
    """Hand off the website content to the analyst agent."""
    return analyst_agent



user_interface_agent = Agent(
    name="User Interface Agent",
    instructions="You are a user interface agent that handles all interactions with the user. You need to always start with an web data extraction objective that the user wants to achieve by searching the web, mapping the web pages, and extracting the content from a specific page. Be concise.",
    functions=[handoff_to_search_google],
)

google_search_agent = Agent(
    name="Google Search Agent",
    instructions="You are a google search agent specialized in searching the web. Only search for the website not any specific page. When you are done, you must hand off to the map agent.",
    functions=[search_web, handoff_to_map_url],
)

map_url_agent = Agent(
    name="Map URL Agent",
    instructions="You are a map url agent specialized in mapping the web pages. When you are done, you must hand off the results to the website scraper agent.",
    functions=[map_url_pages, handoff_to_website_scraper],
)

website_scraper_agent = Agent(
    name="Website Scraper Agent",
    instructions="You are a website scraper agent specialized in scraping website content. When you are done, you must hand off the website content to the analyst agent to extract the data based on the objective.",
    functions=[scrape_url, handoff_to_analyst],
)

analyst_agent = Agent(
    name="Analyst Agent",
    instructions="You are an analyst agent that examines website content and returns a JSON object. When you are done, you must return a JSON object.",
    functions=[analyze_website_content],
)

if __name__ == "__main__":
    # Run the demo loop with the user interface agent
    run_demo_loop(user_interface_agent, stream=True)