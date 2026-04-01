import csv
import json
import os

from dotenv import load_dotenv
from firecrawl import FirecrawlApp
from openai import OpenAI
from serpapi import GoogleSearch
from swarm import Agent
from swarm.repl import run_demo_loop

load_dotenv()

# Initialize FirecrawlApp and OpenAI
app = FirecrawlApp(api_key=os.getenv("FIRECRAWL_API_KEY"))
client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))

def crawl_and_analyze_url(url, objective):
    """Crawl a website using Firecrawl and analyze the content."""
    print(f"Parameters: url={url}, objective={objective}")
    # Crawl the website
    crawl_status = app.crawl_url(
        url,
        params={'limit': 10, 'scrapeOptions': {'formats': ['markdown']}},
        poll_interval=5
    )
    crawl_status = crawl_status['data']
    # Process each 'markdown' element individually
    combined_results = []
    for item in crawl_status:
        if 'markdown' in item:
            content = item['markdown']
            # Analyze the content
            analysis = generate_completion(
                "website data extractor",
                f"Analyze the following website content and extract a JSON object based on the objective. Do not write the ```json and ``` to denote a JSON when returning a response",
                "Objective: " + objective + "\nContent: " + content
            )
            # Parse the JSON result
            try:
                result = json.loads(analysis)
                combined_results.append(result)
            except json.JSONDecodeError:
                print(f"Could not parse JSON from analysis: {analysis}")
    # Combine the results
    return {"objective": objective, "results": combined_results}

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

def handoff_to_crawl_url():
    """Hand off the url to the crawl url agent."""
    return crawl_website_agent

user_interface_agent = Agent(
    name="User Interface Agent",
    instructions="You are a user interface agent that handles all interactions with the user. You need to always start by asking for a URL to crawl and the web data extraction objective. Be concise.",
    functions=[handoff_to_crawl_url],
)

crawl_website_agent = Agent(
    name="Crawl Website Agent",
    instructions="You are a crawl URL agent specialized in crawling web pages and analyzing their content. When you are done, you must print the results to the console.",
    functions=[crawl_and_analyze_url],
)

if __name__ == "__main__":
    # Run the demo loop with the user interface agent
    run_demo_loop(user_interface_agent, stream=True)
