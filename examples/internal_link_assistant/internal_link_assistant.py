import os
import json
from firecrawl import FirecrawlApp
from dotenv import load_dotenv
from openai import OpenAI

# Load environment variables
load_dotenv()

# Retrieve API keys from environment variables
firecrawl_api_key = os.getenv("FIRECRAWL_API_KEY")
openai_api_key = os.getenv("OPENAI_API_KEY")

# Initialize the FirecrawlApp and set OpenAI API key
app = FirecrawlApp(api_key=firecrawl_api_key)
client = OpenAI(api_key=openai_api_key)

def main():
    # Get user input
    blog_url = input("Enter the blog URL: ")

    if not blog_url.strip():
        blog_url = "https://www.firecrawl.dev/blog/how-to-use-openai-o1-reasoning-models-in-applications"

    # Scrape the blog content
    print("Scraping the blog content...")
    blog_scrape_result = app.scrape_url(blog_url, params={'formats': ['markdown']})

    # Get the blog content in markdown format
    blog_content = blog_scrape_result.get('markdown', '')

    # Turn the blog URL into a top-level domain
    top_level_domain = '/'.join(blog_url.split('/')[:3])

    # Map the website to get all links
    print("Mapping the website to get all links...")
    site_map = app.map_url(top_level_domain)

    # Get the list of URLs from the site map
    # v2 map results carry link objects with a `url` field, not v1's plain URL strings
    site_links = [link.url for link in site_map.get('links', [])]


    prompt = f"""
You are an AI assistant helping to improve a blog post.

Here is the original blog post content:

{blog_content}

Here is a list of other pages on the website:

{json.dumps(site_links, indent=2)}

Please revise the blog post to include internal links to some of these pages where appropriate. Make sure the internal links are relevant and enhance the content.

Only return the revised blog post in markdown format.
"""

    import re

    # Function to count links in a markdown content
    def count_links(markdown_content):
        return len(re.findall(r'\[.*?\]\(.*?\)', markdown_content))

    # Use OpenAI API to get the revised blog post
    print("Generating the revised blog post with internal links...")
    completion = client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[
            {
                "role": "user",
                "content": prompt
            }
        ],
        prediction={
            "type": "content",
            "content": blog_content
        }
    );

    revised_blog_post = completion.choices[0].message.content

    # Count links in the original and revised blog post
    original_links_count = count_links(blog_content)
    revised_links_count = count_links(revised_blog_post)

    # Output a portion of the revised blog post and link counts
    print("\nRevised blog post (first 500 characters):")
    print(revised_blog_post[:500])
    print(f"\nNumber of links in the original blog post: {original_links_count}")
    print(f"Number of links in the revised blog post: {revised_links_count}")

if __name__ == "__main__":
    main()
