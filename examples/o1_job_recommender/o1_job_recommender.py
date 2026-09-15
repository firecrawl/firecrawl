# %%
# %%
import os
import requests
import json
from dotenv import load_dotenv
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

# Initialize the FirecrawlApp with your API key
firecrawl_api_key = os.getenv("FIRECRAWL_API_KEY")
client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))

# Set the jobs page URL
jobs_page_url = "https://openai.com/careers/search"

# Resume
resume_paste = """"
Eric Ciarla
Co-Founder @ Firecrawl
San Francisco, California, United States
Summary
Building…
Experience
Firecrawl
Co-Founder
April 2024 - Present (6 months)
San Francisco, California, United States
Firecrawl by Mendable. Building data extraction infrastructure for AI. Used by
Amazon, Zapier, and Nvidia (YC S22)
Mendable
2 years 7 months
Co-Founder @ Mendable.ai
March 2022 - Present (2 years 7 months)
San Francisco, California, United States
- Built an AI powered search platform that served millions of queries for
hundreds of customers (YC S22)
- We were one of the first LLM powered apps adopted by industry leaders like
Coinbase, Snap, DoorDash, and MongoDB
Co-Founder @ SideGuide
March 2022 - Present (2 years 7 months)
San Francisco, California, United States
- Built and scaled an online course platform with a community of over 50,000
developers
- Selected for Y Combinator S22 batch, 2% acceptance rate
Fracta
Data Engineer
2022 - 2022 (less than a year)
Palo Alto, California, United States
- Demoed tool during sales calls and provided technical support during the
entire customer lifecycle
Page 1 of 2
- Mined, wrangled, & visualized geospatial and water utility data for predictive
analytics & ML workflows (Python, QGIS)
Ford Motor Company
Data Scientist
2021 - 2021 (less than a year)
Dearborn, Michigan, United States
- Extracted, cleaned, and joined data from multiple sources using SQL,
Hadoop, and Alteryx
- Used Bayesian Network Structure Learning (BNLearn, R) to uncover the
relationships between survey free response verbatim topics (derived from
natural language processing models) and numerical customer experience
scores
MDRemindME
Co-Founder
2018 - 2020 (2 years)
Durham, New Hampshire, United States
- Founded and led a healthtech startup aimed at improving patient adherence
to treatment plans through an innovative engagement and retention tool
- Piloted the product with healthcare providers and patients, gathering critical
insights to refine functionality and enhance user experience
- Secured funding through National Science Foundation I-CORPS Grant and
UNH Entrepreneurship Center Seed Grant
Education
Y Combinator
S22
University of New Hampshire
Economics and Philosophy
"""

# First, scrape the jobs page using Firecrawl
try:
    response = requests.post(
        "https://api.firecrawl.dev/v1/scrape",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {firecrawl_api_key}"
        },
        json={
            "url": jobs_page_url,
            "formats": ["markdown"]
        }
    )
    
    if response.status_code == 200:
        result = response.json()
        if result.get('success'):
            html_content = result['data']['markdown']
            # Define the O1 prompt for extracting apply links
            prompt = f"""
            Extract up to 30 job application links from the given markdown content.
            Return the result as a JSON object with a single key 'apply_links' containing an array of strings (the links).
            The output should be a valid JSON object, with no additional text.
            Do not include any JSON markdown formatting or code block indicators.
            Provide only the raw JSON object as the response.

            Example of the expected format:
            {{"apply_links": ["https://example.com/job1", "https://example.com/job2", ...]}}

            Markdown content:
            {html_content[:100000]}
            """
            print(f"{Colors.GREEN}Successfully scraped the jobs page{Colors.RESET}")
        else:
            print(f"{Colors.RED}Failed to scrape the jobs page: {result.get('message', 'Unknown error')}{Colors.RESET}")
            html_content = ""
    else:
        print(f"{Colors.RED}Error {response.status_code}: {response.text}{Colors.RESET}")
        html_content = ""
except requests.RequestException as e:
    print(f"{Colors.RED}An error occurred while scraping: {str(e)}{Colors.RESET}")
    html_content = ""
except json.JSONDecodeError as e:
    print(f"{Colors.RED}Error decoding JSON response: {str(e)}{Colors.RESET}")
    html_content = ""
except Exception as e:
    print(f"{Colors.RED}An unexpected error occurred while scraping: {str(e)}{Colors.RESET}")
    html_content = ""

# Extract apply links from the scraped HTML using O1
apply_links = []
if html_content:
    try:
        completion = client.chat.completions.create(
            model="gpt-4o",
            messages=[
                {
                    "role": "user",
                    "content": prompt
                }
            ]
        )
        
        if completion.choices:
            print(completion.choices[0].message.content)
            result = json.loads(completion.choices[0].message.content.strip())
        
            apply_links = result['apply_links']
            print(f"{Colors.GREEN}Successfully extracted {len(apply_links)} apply links{Colors.RESET}")
        else:
            print(f"{Colors.RED}No apply links extracted{Colors.RESET}")
    except json.JSONDecodeError as e:
        print(f"{Colors.RED}Error decoding JSON from OpenAI response: {str(e)}{Colors.RESET}")
    except KeyError as e:
        print(f"{Colors.RED}Expected key not found in OpenAI response: {str(e)}{Colors.RESET}")
    except Exception as e:
        print(f"{Colors.RED}An unexpected error occurred during extraction: {str(e)}{Colors.RESET}")
else:
    print(f"{Colors.RED}No HTML content to process{Colors.RESET}")

# Initialize a list to store the extracted data
extracted_data = []


# %%
print(f"{Colors.CYAN}Apply links:{Colors.RESET}")
for link in apply_links:
    print(f"{Colors.YELLOW}{link}{Colors.RESET}")

# %%
# Process each apply link
for index, link in enumerate(apply_links):
    try:
        response = requests.post(
            "https://api.firecrawl.dev/v1/scrape",
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {firecrawl_api_key}"
            },
            json={
                "url": link,
                "formats": ["extract"],
                "actions": [{
                    "type": "click",
                    "selector": "#job-overview"
                }],
                "extract": {
                    "schema": {
                        "type": "object",
                        "properties": {
                            "job_title": {"type": "string"},
                            "sub_division_of_organization": {"type": "string"},
                            "key_skills": {"type": "array", "items": {"type": "string"}},
                            "compensation": {"type": "string"},
                            "location": {"type": "string"},
                            "apply_link": {"type": "string"}
                        },
                        "required": ["job_title", "sub_division_of_organization", "key_skills", "compensation", "location", "apply_link"]
                    }
                }
            }
        )
        
        if response.status_code == 200:
            result = response.json()
            if result.get('success'):
                extracted_data.append(result['data']['extract'])
                print(f"{Colors.GREEN}Data extracted for job {index}{Colors.RESET}")
            else:
                print(f"")
        else:
            print(f"")
    except Exception as e:
        print(f"")


# %%
# %%
# Print the extracted data
print(f"{Colors.CYAN}Extracted data:{Colors.RESET}")
for job in extracted_data:
    print(json.dumps(job, indent=2))
    print(f"{Colors.MAGENTA}{'-' * 50}{Colors.RESET}")


# %%




# Use o1-preview to choose which jobs should be applied to based on the resume
prompt = f"""
Please analyze the resume and job listings, and return a JSON list of the top 3 roles that best fit the candidate's experience and skills. Include only the job title, compensation, and apply link for each recommended role. The output should be a valid JSON array of objects in the following format, with no additional text:

[
  {{
    "job_title": "Job Title",
    "compensation": "Compensation (if available, otherwise empty string)",
    "apply_link": "Application URL"
  }},
  ...
]

Based on the following resume:
{resume_paste}

And the following job listings:
{json.dumps(extracted_data, indent=2)}
"""

completion = client.chat.completions.create(
    model="o1-preview",
    messages=[
        {
            "role": "user",
            "content": [
                {
                    "type": "text",
                    "text": prompt
                }
            ]
        }
    ]
)

recommended_jobs = json.loads(completion.choices[0].message.content.strip())

print(f"{Colors.CYAN}Recommended jobs:{Colors.RESET}")
print(json.dumps(recommended_jobs, indent=2))


