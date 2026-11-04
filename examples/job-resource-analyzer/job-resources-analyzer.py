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

load_dotenv()

# Initialize clients
client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))
firecrawl_api_key = os.getenv("FIRECRAWL_API_KEY")
serp_api_key = os.getenv("SERP_API_KEY")

def extract_job_requirements(url, api_key):
    """Extract essential job requirements using Firecrawl."""
    print(f"{Colors.YELLOW}Extracting job requirements...{Colors.RESET}")
    
    headers = {
        'Content-Type': 'application/json',
        'Authorization': f'Bearer {api_key}'
    }
    
    prompt = """
    Extract only:
    - job_title: position title (string)
    - required_skills: top 5 technical skills (array)
    - experience_level: years required (string)
    """
    
    payload = {
        "urls": [url],
        "prompt": prompt,
        "enableWebSearch": False
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
            return None
        
        return poll_extraction_result(data.get('id'), api_key)

    except Exception as e:
        print(f"{Colors.RED}Error extracting job requirements: {str(e)}{Colors.RESET}")
        return None

def poll_extraction_result(extraction_id, api_key, interval=5, max_attempts=12):
    """Poll for extraction results."""
    url = f"https://api.firecrawl.dev/v1/extract/{extraction_id}"
    headers = {'Authorization': f'Bearer {api_key}'}

    for _ in range(max_attempts):
        try:
            response = requests.get(url, headers=headers, timeout=30)
            data = response.json()
            if data.get('success') and data.get('data'):
                return data['data']
            time.sleep(interval)
        except Exception as e:
            print(f"{Colors.YELLOW}Polling attempt failed, retrying...{Colors.RESET}")
            continue
    return None

def rank_and_summarize_resources(resources, skills):
    """Use OpenAI to rank and summarize learning resources."""
    try:
        # Prepare resources for ranking
        all_resources = []
        for category, items in resources.items():
            for item in items:
                all_resources.append({
                    "category": category,
                    "title": item["title"],
                    "url": item["url"]
                })
        
        # Create prompt for OpenAI
        skills_str = ", ".join(skills)
        prompt = f"""Given these learning resources for skills ({skills_str}), 
        rank them by relevance and quality, and provide a brief summary:

        Resources:
        {json.dumps(all_resources, indent=2)}

        For each resource, provide:
        1. Relevance score (1-10)
        2. Brief summary (max 2 sentences)
        3. Why it's useful for the target skills

        Format as JSON with structure:
        {{
            "ranked_resources": [
                {{
                    "category": "...",
                    "title": "...",
                    "url": "...",
                    "relevance_score": X,
                    "summary": "...",
                    "usefulness": "..."
                }}
            ]
        }}"""

        response = client.chat.completions.create(
            model="gpt-5-mini",
            messages=[
                {"role": "system", "content": "You are a technical learning resource curator."},
                {"role": "user", "content": prompt}
            ],
        )
        
        # Parse and return ranked resources
        ranked_data = json.loads(response.choices[0].message.content)
        return ranked_data["ranked_resources"]

    except Exception as e:
        print(f"{Colors.RED}Error in ranking resources: {str(e)}{Colors.RESET}")
        return None

def get_prep_resources(skills):
    """Get and rank learning resources for top skills."""
    try:
        core_resources = {
            "Tutorials": [],
            "Practice": [],
            "Documentation": []
        }
        
        # Search for top 2 skills to reduce API usage
        top_skills = skills[:2]
        search = GoogleSearch({
            "q": f"learn {' '.join(top_skills)} tutorial practice exercises documentation",
            "api_key": serp_api_key,
            "num": 6
        })
        results = search.get_dict().get("organic_results", [])
        
        for result in results[:6]:
            url = result.get("link", "")
            title = result.get("title", "")
            
            if "tutorial" in title.lower() or "guide" in title.lower():
                core_resources["Tutorials"].append({"title": title, "url": url})
            elif "practice" in title.lower() or "exercise" in title.lower():
                core_resources["Practice"].append({"title": title, "url": url})
            elif "doc" in title.lower() or "reference" in title.lower():
                core_resources["Documentation"].append({"title": title, "url": url})
        
        # Rank and summarize resources
        ranked_resources = rank_and_summarize_resources(core_resources, top_skills)
        return ranked_resources

    except Exception as e:
        print(f"{Colors.RED}Error getting resources: {str(e)}{Colors.RESET}")
        return None

def generate_weekly_plan(skills):
    """Generate a concise weekly preparation plan."""
    weeks = []
    total_skills = len(skills)
    
    # Week 1: Fundamentals
    weeks.append({
        "focus": "Fundamentals",
        "skills": skills[:2] if total_skills >= 2 else skills,
        "tasks": ["Study core concepts", "Complete basic tutorials"]
    })
    
    # Week 2: Advanced Concepts
    if total_skills > 2:
        weeks.append({
            "focus": "Advanced Topics",
            "skills": skills[2:4],
            "tasks": ["Deep dive into advanced features", "Practice exercises"]
        })
    
    # Week 3: Projects & Practice
    weeks.append({
        "focus": "Projects",
        "skills": "All core skills",
        "tasks": ["Build small projects", "Solve practice problems"]
    })
    
    # Week 4: Interview Prep
    weeks.append({
        "focus": "Interview Prep",
        "skills": "All skills",
        "tasks": ["Mock interviews", "Code reviews"]
    })
    
    return weeks

def format_output(job_info, ranked_resources, weeks):
    """Format output in a concise way with ranked resources."""
    output = f"\n{Colors.GREEN}=== Job Preparation Guide ==={Colors.RESET}\n"
    
    # Job Requirements
    output += f"\n{Colors.CYAN}Position:{Colors.RESET} {job_info.get('job_title', 'N/A')}"
    output += f"\n{Colors.CYAN}Experience:{Colors.RESET} {job_info.get('experience_level', 'N/A')}"
    output += f"\n{Colors.CYAN}Key Skills:{Colors.RESET}"
    for skill in job_info.get('required_skills', []):
        output += f"\n- {skill}"

    # Weekly Plan
    output += f"\n\n{Colors.CYAN}4-Week Plan:{Colors.RESET}"
    for i, week in enumerate(weeks, 1):
        output += f"\n\n📅 Week {i}: {week['focus']}"
        output += f"\n   Skills: {', '.join(week['skills']) if isinstance(week['skills'], list) else week['skills']}"
        output += f"\n   Tasks: {' → '.join(week['tasks'])}"

    # Ranked Learning Resources
    if ranked_resources:
        output += f"\n\n{Colors.CYAN}Top Recommended Resources:{Colors.RESET}"
        
        # Sort resources by relevance score
        sorted_resources = sorted(ranked_resources, key=lambda x: x['relevance_score'], reverse=True)
        
        for res in sorted_resources[:5]:  # Show top 5 resources
            output += f"\n\n📚 {res['title']} (Score: {res['relevance_score']}/10)"
            output += f"\n   {res['summary']}"
            output += f"\n   Why useful: {res['usefulness']}"
            output += f"\n   URL: {res['url']}"

    return output

def main():
    """Main execution function."""
    try:
        job_url = input(f"{Colors.YELLOW}Enter job posting URL: {Colors.RESET}")
        
        # Extract requirements
        job_info = extract_job_requirements(job_url, firecrawl_api_key)
        if not job_info:
            print(f"{Colors.RED}Failed to extract job requirements.{Colors.RESET}")
            return
        
        # Get resources and generate plan
        print(f"{Colors.YELLOW}Finding and ranking preparation resources...{Colors.RESET}")
        resources = get_prep_resources(job_info.get('required_skills', []))
        weeks = generate_weekly_plan(job_info.get('required_skills', []))
        
        # Display results
        print(format_output(job_info, resources, weeks))

    except Exception as e:
        print(f"{Colors.RED}An error occurred: {str(e)}{Colors.RESET}")

if __name__ == "__main__":
    main()