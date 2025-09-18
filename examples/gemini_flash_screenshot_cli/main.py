import os
import argparse
from datetime import datetime
from urllib.parse import urlparse
from dotenv import load_dotenv

# Import your clients from the clients package
from clients.firecrawl_client import FirecrawlClient
from clients.gemini_client import GeminiClient

# Import prompts from utils
from utils.prompts import FEATURES

# Load environment variables from .env
load_dotenv()

# Retrieve keys
FIRECRAWL_API_KEY = os.getenv("FIRECRAWL_API_KEY")
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")

if not FIRECRAWL_API_KEY or not GEMINI_API_KEY:
    raise ValueError("API keys not found in environment. Check your .env file.")

# Presets for common workflows
PRESETS = {
    "ux_review": ["dark_mode", "wireframe", "highlight_cta"],
    "marketing": ["poster", "mobile_mockup", "redesign"],
    "accessibility": ["accessibility", "highlight_cta"],
}

def is_valid_url(url: str) -> bool:
    """Basic URL validation"""
    try:
        result = urlparse(url)
        return all([result.scheme in ["http", "https"], result.netloc])
    except Exception:
        return False

def process_url(url, feature_list, firecrawl, gemini, args):
    """Process a single URL with multiple features"""
    results = []
    if not is_valid_url(url):
        print(f"[ERROR] Invalid URL: {url}")
        return results

    try:
        print(f"[INFO] Capturing screenshot of {url}...")
        mobile_flag = "mobile_mockup" in feature_list
        screenshot_bytes = firecrawl.capture(url, full_page=True, mobile=mobile_flag)
        if not screenshot_bytes:
            print(f"[WARNING] Screenshot capture returned no data for {url}")
            return results
        print("[INFO] Screenshot captured successfully")

        for feature in feature_list:
            try:
                # Prepare prompt based on feature
                if feature == "mobile_mockup":
                    prompt = FEATURES[feature](args.device)
                elif feature == "localization":
                    prompt = FEATURES[feature](args.language)
                elif feature == "poster":
                    prompt = FEATURES[feature](args.poster_title, args.poster_color)
                else:
                    prompt = FEATURES[feature]()

                print(f"[INFO] Applying {feature} edits via Gemini...")
                edited_bytes = gemini.edit_image(screenshot_bytes, prompt, high_quality=True)
                if not edited_bytes:
                    print(f"[WARNING] Gemini returned empty result for {feature}")
                    continue

                timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
                safe_url = url.replace("://", "_").replace("/", "_")
                output_path = os.path.join(args.output_dir, f"{safe_url}_{feature}_{timestamp}.png")

                try:
                    with open(output_path, "wb") as f:
                        f.write(edited_bytes)
                    print(f"[INFO] {feature} saved to: {output_path}")
                    results.append(output_path)
                except OSError as e:
                    print(f"[ERROR] Failed to write file {output_path}: {e}")

            except Exception as fe:
                print(f"[ERROR] Failed to process feature '{feature}' for {url}: {fe}")

    except Exception as e:
        print(f"[ERROR] Failed to capture or edit {url}: {e}")

    return results

def main():
    parser = argparse.ArgumentParser(description="Website Screenshot CLI using Firecrawl + Gemini")
    parser.add_argument("--url", type=str, help="Single website URL to capture")
    parser.add_argument("--batch", type=str, help="Text file containing multiple URLs (one per line)")
    parser.add_argument("--output-dir", type=str, default="outputs", help="Directory to save images")
    parser.add_argument("--feature", type=str, choices=FEATURES.keys(), help="Feature to apply (single)")
    parser.add_argument("--preset", type=str, choices=PRESETS.keys(), help="Run a preset of multiple features")
    parser.add_argument("--device", type=str, default="iPhone", help="Device for mobile mockup")
    parser.add_argument("--language", type=str, default="es", help="Language for localization")
    parser.add_argument("--poster-title", type=str, default="Now Live!", help="Title for poster mode")
    parser.add_argument("--poster-color", type=str, default="#1D9BF0", help="Brand color for poster mode")
    args = parser.parse_args()

    if not args.url and not args.batch:
        parser.error("You must provide either --url or --batch")

    try:
        os.makedirs(args.output_dir, exist_ok=True)
    except OSError as e:
        parser.error(f"Failed to create output directory {args.output_dir}: {e}")

    firecrawl = FirecrawlClient(api_key=FIRECRAWL_API_KEY)
    gemini = GeminiClient(api_key=GEMINI_API_KEY)

    # Determine features to apply
    feature_list = []
    if args.preset:
        feature_list = PRESETS.get(args.preset, [])
        if not feature_list:
            parser.error(f"Preset '{args.preset}' is empty or invalid")
    elif args.feature:
        feature_list = [args.feature]
    else:
        parser.error("You must provide either --feature or --preset")

    # Process single URL
    if args.url:
        process_url(args.url, feature_list, firecrawl, gemini, args)

    # Process batch file
    if args.batch:
        if not os.path.isfile(args.batch):
            print(f"[ERROR] Batch file {args.batch} not found")
            return
        with open(args.batch, "r") as f:
            urls = [line.strip() for line in f if line.strip()]
        if not urls:
            print(f"[ERROR] Batch file {args.batch} contains no valid URLs")
            return
        print(f"[INFO] Processing {len(urls)} URLs from batch file...")
        for url in urls:
            process_url(url, feature_list, firecrawl, gemini, args)

if __name__ == "__main__":
    main()
