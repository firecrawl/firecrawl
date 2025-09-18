import os
import argparse
import uuid
from datetime import datetime
from urllib.parse import urlparse
from dotenv import load_dotenv
from PIL import Image
from io import BytesIO

# Local client wrappers (custom API wrappers for Firecrawl + Gemini)
from clients.firecrawl_client import FirecrawlClient
from clients.gemini_client import GeminiClient
from utils.prompts import FEATURES

# Load API keys from .env file
load_dotenv()

FIRECRAWL_API_KEY = os.getenv("FIRECRAWL_API_KEY")
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")

# Fail early if keys are missing
if not FIRECRAWL_API_KEY or not GEMINI_API_KEY:
    raise ValueError("API keys not found in environment. Check your .env file.")

# Predefined sets of features for quick execution
PRESETS = {
    "ux_review": ["dark_mode", "wireframe", "highlight_cta"],
    "marketing": ["social_preview", "mobile_mockup", "redesign_minimal"],
    "accessibility": ["accessibility", "highlight_cta"],
}

# Check if a given string is a valid http/https URL
def is_valid_url(url: str) -> bool:
    try:
        result = urlparse(url)
        return all([result.scheme in ["http", "https"], result.netloc])
    except Exception:
        return False

# Generate filenames for outputs based on naming strategy
def generate_filename(base_url, feature, args):
    ext = args.format.lower()

    if args.name_strategy == "url":
        safe_url = base_url.replace("://", "_").replace("/", "_")
        name = f"{safe_url}_{feature}"
    elif args.name_strategy == "timestamp":
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        name = f"{feature}_{ts}"
    elif args.name_strategy == "uuid":
        name = f"{feature}_{uuid.uuid4().hex[:8]}"
    else:
        name = f"{feature}_{datetime.now().strftime('%Y%m%d_%H%M%S')}"
    return os.path.join(args.output_dir, f"{name}.{ext}")

# Save raw image bytes to disk in the requested format
def save_image_bytes(image_bytes, path, format="png"):
    if format.lower() == "pdf":
        img = Image.open(BytesIO(image_bytes))
        img.convert("RGB").save(path, "PDF")
    else:
        img = Image.open(BytesIO(image_bytes))
        img.save(path, format.upper())

# Main pipeline for capturing a website screenshot and applying edits
def process_url(url, feature_list, firecrawl, gemini, args):
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

        if args.save_original:
            original_path = generate_filename(url, "original", args)
            save_image_bytes(screenshot_bytes, original_path, args.format)
            print(f"[INFO] Original screenshot saved to: {original_path}")

        for feature in feature_list:
            try:
                if feature == "mobile_mockup":
                    prompt = FEATURES[feature](args.device)
                elif feature == "localization":
                    prompt = FEATURES[feature](args.language)
                elif feature == "social_preview":
                    prompt = FEATURES[feature]("Twitter", args.poster_title)
                elif feature == "brand_color_swap":
                    prompt = FEATURES[feature](args.poster_color)
                else:
                    prompt = FEATURES[feature]()

                print(f"[INFO] Applying {feature} edits via Gemini...")
                edited_bytes = gemini.edit_image(screenshot_bytes, prompt, high_quality=True)

                if not edited_bytes:
                    print(f"[WARNING] Gemini returned empty result for {feature}")
                    continue

                output_path = generate_filename(url, feature, args)
                save_image_bytes(edited_bytes, output_path, args.format)
                print(f"[INFO] {feature} saved to: {output_path}")
                results.append(output_path)

            except Exception as fe:
                print(f"[ERROR] Failed to process feature '{feature}' for {url}: {fe}")

    except Exception as e:
        print(f"[ERROR] Failed to capture or edit {url}: {e}")
    return results

# Reprocess an already existing image with Gemini features
def process_existing_image(image_path, feature_list, gemini, args):
    results = []
    if not os.path.isfile(image_path):
        print(f"[ERROR] Input image not found: {image_path}")
        return results
    try:
        with open(image_path, "rb") as f:
            image_bytes = f.read()

        for feature in feature_list:
            try:
                if feature == "mobile_mockup":
                    prompt = FEATURES[feature](args.device)
                elif feature == "localization":
                    prompt = FEATURES[feature](args.language)
                elif feature == "social_preview":
                    prompt = FEATURES[feature]("Twitter", args.poster_title)
                elif feature == "brand_color_swap":
                    prompt = FEATURES[feature](args.poster_color)
                else:
                    prompt = FEATURES[feature]()

                print(f"[INFO] Re-applying {feature} edits on {image_path}...")
                edited_bytes = gemini.edit_image(image_bytes, prompt, high_quality=True)

                if not edited_bytes:
                    print(f"[WARNING] Gemini returned empty result for {feature}")
                    continue

                output_path = generate_filename("reedit", feature, args)
                save_image_bytes(edited_bytes, output_path, args.format)
                print(f"[INFO] Re-edited {feature} saved to: {output_path}")
                results.append(output_path)

            except Exception as fe:
                print(f"[ERROR] Failed to reprocess feature '{feature}' on {image_path}: {fe}")

    except Exception as e:
        print(f"[ERROR] Failed to open or edit {image_path}: {e}")
    return results

# CLI entry point
def main():
    parser = argparse.ArgumentParser(description="Website Screenshot CLI using Firecrawl + Gemini")

    parser.add_argument("--url", type=str, help="Single website URL to capture")
    parser.add_argument("--batch", type=str, help="Text file containing multiple URLs (one per line)")
    parser.add_argument("--input-image", type=str, help="Path to an existing screenshot or processed image")
    parser.add_argument("--re-edit", action="store_true", help="Reapply features on an existing image instead of capturing a new screenshot")

    parser.add_argument("--output-dir", type=str, default="outputs", help="Directory to save images")
    parser.add_argument("--format", type=str, default="png", choices=["png", "jpg", "webp", "pdf"], help="Output format")
    parser.add_argument("--name-strategy", type=str, default="url", choices=["url", "timestamp", "uuid"], help="Naming strategy for output files")
    parser.add_argument("--save-original", action="store_true", help="Save original screenshot before edits")

    parser.add_argument("--feature", type=str, choices=FEATURES.keys(), help="Feature to apply (single)")
    parser.add_argument("--preset", type=str, choices=PRESETS.keys(), help="Run a preset of multiple features")

    parser.add_argument("--device", type=str, default="iPhone", help="Device for mobile mockup")
    parser.add_argument("--language", type=str, default="es", help="Language for localization")
    parser.add_argument("--poster-title", type=str, default="Now Live!", help="Title for poster/social preview mode")
    parser.add_argument("--poster-color", type=str, default="#1D9BF0", help="Brand color for poster/social preview mode")

    args = parser.parse_args()

    if not args.url and not args.batch and not args.input_image:
        parser.error("You must provide either --url, --batch, or --input-image")

    try:
        os.makedirs(args.output_dir, exist_ok=True)
    except OSError as e:
        parser.error(f"Failed to create output directory {args.output_dir}: {e}")

    firecrawl = FirecrawlClient(api_key=FIRECRAWL_API_KEY)
    gemini = GeminiClient(api_key=GEMINI_API_KEY)

    if args.preset:
        feature_list = PRESETS.get(args.preset, [])
        if not feature_list:
            parser.error(f"Preset '{args.preset}' is empty or invalid")
    elif args.feature:
        feature_list = [args.feature]
    else:
        parser.error("You must provide either --feature or --preset")

    if args.re_edit and args.input_image:
        process_existing_image(args.input_image, feature_list, gemini, args)
        return

    if args.url:
        process_url(args.url, feature_list, firecrawl, gemini, args)

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
