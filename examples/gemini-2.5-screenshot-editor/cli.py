#!/usr/bin/env python3
"""
Firecrawl + Gemini 3.1 Flash-Lite Image CLI Editor
=============================================

A professional CLI tool that captures website screenshots using Firecrawl
and applies AI-powered image editing using Google's Gemini 3.1 Flash-Lite Image model.

Features:
- Website screenshot capture with Firecrawl API
- Text-to-image generation
- Advanced style transfer (Van Gogh, Monet, etc.)
- Multi-image composition
- Iterative refinement
- Batch processing
- Custom editing prompts

Author: Rishi Mondal
"""

import argparse
import base64
import json
import os
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import List, Optional, Tuple, Union
from urllib.parse import urlparse

try:
    from dotenv import load_dotenv
    load_dotenv()

    from google import genai
    from google.genai import types
    from PIL import Image
    from io import BytesIO
    from firecrawl import Firecrawl
    import requests
except ImportError as e:
    print(f"Error: Missing dependency: {e}")
    print("Install with: pip install -r requirements.txt")
    sys.exit(1)


class FirecrawlGeminiEditor:
    """Main class for screenshot capture and AI editing with advanced features."""

    # Advanced style prompts for artistic transformations
    ARTISTIC_STYLES = {
        'van_gogh': "Transform into Vincent van Gogh's 'Starry Night' style with swirling, impasto brushstrokes and a dramatic palette of deep blues and bright yellows",
        'monet': "Apply Claude Monet's impressionist style with soft, blended colors and dreamy water lily-like effects",
        'picasso': "Convert to Pablo Picasso's cubist style with geometric shapes and fragmented perspectives",
        'warhol': "Create Andy Warhol pop art style with bold, contrasting colors and repeated patterns",
        'dali': "Apply Salvador Dali's surrealist style with melting, dreamlike distortions",
        'ukiyo_e': "Transform into Japanese ukiyo-e woodblock print style with flat colors and bold outlines",
        'watercolor': "Render as a delicate watercolor painting with soft edges and translucent colors",
        'oil_painting': "Convert to realistic oil painting with rich textures and classical composition",
        'pencil_sketch': "Transform into detailed pencil sketch with shading and cross-hatching",
        'comic_book': "Apply comic book style with bold outlines, Ben Day dots, and vibrant colors"
    }

    def __init__(self, firecrawl_key: str, gemini_key: str, firecrawl_url: str = None, verbose: bool = False):
        """Initialize with API keys and configuration."""
        self.verbose = verbose
        self.firecrawl = Firecrawl(
            api_key=firecrawl_key,
            api_url=firecrawl_url or "https://api.firecrawl.dev"
        )

        # Initialize Gemini client
        self.client = genai.Client(api_key=gemini_key)
        self.model_name = "gemini-3.1-flash-lite-image"

        if self.verbose:
            print(f"Initialized Gemini client with model: {self.model_name}")

    def capture_screenshot(self, url: str, full_page: bool = True, mobile: bool = False,
                         wait_time: int = 3) -> str:
        """Capture screenshot using Firecrawl with enhanced options."""
        try:
            if self.verbose:
                print(f"Capturing screenshot: {url}")
                print(f"Options: full_page={full_page}, mobile={mobile}, wait={wait_time}s")

            # Configure screenshot options
            formats = []
            if full_page:
                formats = [{"type": "screenshot", "fullPage": True}]
            else:
                formats = ["screenshot"]

            options = {
                "formats": formats
            }

            if mobile:
                options["mobile"] = True

            # Capture screenshot
            result = self.firecrawl.scrape(url, **options)

            # Extract screenshot data
            if hasattr(result, 'screenshot'):
                screenshot = result.screenshot
            elif isinstance(result, dict) and 'screenshot' in result:
                screenshot = result['screenshot']
            else:
                raise Exception("No screenshot in response")

            # Handle different formats
            if screenshot.startswith('http'):
                if self.verbose:
                    print("Downloading screenshot from URL...")
                resp = requests.get(screenshot, timeout=30)
                resp.raise_for_status()
                return base64.b64encode(resp.content).decode()
            elif screenshot.startswith('data:'):
                return screenshot.split(',')[1]
            else:
                return screenshot

        except Exception as e:
            raise Exception(f"Screenshot capture failed: {e}")

    def generate_image_from_text(self, prompt: str, style: Optional[str] = None, high_quality: bool = True) -> bytes:
        """Generate image from text prompt with optional artistic style and quality enhancement."""
        try:
            # Add quality enhancement to prompt
            quality_suffix = ""
            if high_quality:
                quality_suffix = """
                QUALITY REQUIREMENTS:
                - Ultra high resolution 4K quality
                - Sharp, crisp details throughout
                - Professional photography/artistic quality
                - Rich color depth and dynamic range
                - Photorealistic textures where applicable
                - Maximum image clarity and definition"""

            # Enhance prompt with style if specified
            if style and style in self.ARTISTIC_STYLES:
                enhanced_prompt = f"{prompt}. {self.ARTISTIC_STYLES[style]}{quality_suffix}"
            else:
                enhanced_prompt = f"{prompt}{quality_suffix}"

            if self.verbose:
                print(f"Generating HIGH QUALITY image with prompt: {enhanced_prompt[:100]}...")

            response = self.client.models.generate_content(
                model=self.model_name,
                contents=enhanced_prompt,
                config=types.GenerateContentConfig(response_modalities=["TEXT", "IMAGE"]),
            )

            # Extract image data
            image_parts = [
                part.inline_data.data
                for part in response.candidates[0].content.parts
                if part.inline_data and not part.thought
            ]

            if image_parts:
                if self.verbose:
                    print(f"Generated image: {len(image_parts[0])} bytes")
                return image_parts[0]
            else:
                raise Exception("No image generated from prompt")

        except Exception as e:
            raise Exception(f"Text-to-image generation failed: {e}")

    def apply_style_transfer(self, image_data: str, style: str,
                           preserve_content: bool = True) -> bytes:
        """Apply artistic style transfer to an image."""
        try:
            # Decode base64 image
            image_bytes = base64.b64decode(image_data)
            image = Image.open(BytesIO(image_bytes))

            # Build style transfer prompt
            style_prompt = self.ARTISTIC_STYLES.get(style, style)

            if preserve_content:
                prompt = f"""Transform this high-resolution image into {style_prompt}.
                CRITICAL REQUIREMENTS:
                - Preserve the original composition, objects, and structure exactly
                - Render all elements in the new artistic style with exceptional detail
                - Maintain sharp focus and high quality throughout
                - Use rich, vibrant colors and intricate textures
                - Create a museum-quality artistic transformation
                - Ensure the final image is ultra high-definition with maximum detail"""
            else:
                prompt = f"""Reimagine this image completely in {style_prompt}.
                Create an extraordinary, high-quality artistic interpretation with:
                - Ultra-high resolution and exceptional detail
                - Rich, vibrant colors and dramatic effects
                - Professional artistic execution
                - Gallery-worthy quality and composition"""

            if self.verbose:
                print(f"Applying style transfer: {style}")
                print(f"Prompt: {prompt[:150]}...")

            response = self.client.models.generate_content(
                model=self.model_name,
                contents=[prompt, image],
                config=types.GenerateContentConfig(response_modalities=["TEXT", "IMAGE"]),
            )

            # Extract styled image
            image_parts = [
                part.inline_data.data
                for part in response.candidates[0].content.parts
                if part.inline_data and not part.thought
            ]

            if image_parts:
                return image_parts[0]
            else:
                return image_bytes

        except Exception as e:
            print(f"Style transfer failed: {e}")
            return base64.b64decode(image_data)

    def composite_images(self, images: List[Union[str, bytes]],
                        composition_prompt: str) -> bytes:
        """Combine multiple images into a single composition."""
        try:
            if self.verbose:
                print(f"Compositing {len(images)} images...")

            # Prepare images for API
            pil_images = []
            for img_data in images:
                if isinstance(img_data, str):
                    img_bytes = base64.b64decode(img_data)
                else:
                    img_bytes = img_data
                pil_images.append(Image.open(BytesIO(img_bytes)))

            # Build contents list with prompt and images
            contents = [composition_prompt] + pil_images

            response = self.client.models.generate_content(
                model=self.model_name,
                contents=contents,
                config=types.GenerateContentConfig(response_modalities=["TEXT", "IMAGE"]),
            )

            # Extract composite image
            image_parts = [
                part.inline_data.data
                for part in response.candidates[0].content.parts
                if part.inline_data and not part.thought
            ]

            if image_parts:
                return image_parts[0]
            else:
                raise Exception("No composite image generated")

        except Exception as e:
            raise Exception(f"Image composition failed: {e}")

    def iterative_refinement(self, image_data: Union[str, bytes],
                           refinements: List[str],
                           save_intermediates: bool = False,
                           output_dir: str = None) -> bytes:
        """Apply iterative refinements to an image."""
        try:
            if isinstance(image_data, str):
                current_image_bytes = base64.b64decode(image_data)
            else:
                current_image_bytes = image_data

            if save_intermediates:
                # Use provided output_dir or default to current directory
                save_dir = Path(output_dir) if output_dir else Path.cwd()
                save_dir.mkdir(parents=True, exist_ok=True)

            for i, refinement in enumerate(refinements, 1):
                if self.verbose:
                    print(f"Applying refinement {i}/{len(refinements)}: {refinement[:50]}...")

                current_image = Image.open(BytesIO(current_image_bytes))

                response = self.client.models.generate_content(
                    model=self.model_name,
                    contents=[refinement, current_image],
                    config=types.GenerateContentConfig(response_modalities=["TEXT", "IMAGE"]),
                )

                # Extract refined image
                image_parts = [
                    part.inline_data.data
                    for part in response.candidates[0].content.parts
                    if part.inline_data and not part.thought
                ]

                if image_parts:
                    current_image_bytes = image_parts[0]

                    if save_intermediates:
                        intermediate_path = save_dir / f"refinement_{i}.png"
                        with open(intermediate_path, 'wb') as f:
                            f.write(current_image_bytes)
                        if self.verbose:
                            print(f"Saved intermediate: {intermediate_path}")

            return current_image_bytes

        except Exception as e:
            raise Exception(f"Iterative refinement failed: {e}")

    def batch_process_urls(self, urls: List[str], edit_prompt: str,
                          output_dir: str = "batch_output") -> List[str]:
        """Process multiple URLs with the same edit prompt."""
        Path(output_dir).mkdir(exist_ok=True)
        results = []

        for i, url in enumerate(urls, 1):
            try:
                if self.verbose:
                    print(f"\nProcessing {i}/{len(urls)}: {url}")

                # Capture screenshot
                screenshot_data = self.capture_screenshot(url)

                # Apply edit
                edited_image = self.edit_image_with_prompt(screenshot_data, edit_prompt)

                # Save result
                domain = urlparse(url).netloc.replace('www.', '')
                timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
                output_path = Path(output_dir) / f"{domain}_{timestamp}.png"

                output_path = self.save_image(edited_image, str(output_path))
                results.append(str(output_path))

                if self.verbose:
                    print(f"Saved: {output_path}")

            except Exception as e:
                print(f"Failed to process {url}: {e}")
                results.append(None)

        return results

    def edit_image_with_prompt(self, image_data: str, edit_prompt: str, enhance_quality: bool = True) -> bytes:
        """Edit existing image using Gemini with quality enhancement and error handling."""
        try:
            # Add quality enhancement to edit prompt
            if enhance_quality:
                quality_enhanced_prompt = f"""{edit_prompt}

                QUALITY SPECIFICATIONS:
                - Generate at maximum possible resolution
                - Ensure ultra-sharp details and clarity
                - Use professional-grade image quality
                - Maintain high color fidelity and depth
                - Apply sophisticated artistic techniques
                - Create publication-ready output"""
            else:
                quality_enhanced_prompt = edit_prompt

            if self.verbose:
                print(f"Editing image with HIGH QUALITY prompt: {quality_enhanced_prompt[:100]}...")

            # Convert base64 to PIL Image
            image_bytes = base64.b64decode(image_data)
            image = Image.open(BytesIO(image_bytes))

            # Add size information to verbose output
            if self.verbose:
                print(f"Input image size: {image.size}, mode: {image.mode}")

            response = self.client.models.generate_content(
                model=self.model_name,
                contents=[quality_enhanced_prompt, image],
                config=types.GenerateContentConfig(response_modalities=["TEXT", "IMAGE"]),
            )

            # Extract edited image data
            image_parts = [
                part.inline_data.data
                for part in response.candidates[0].content.parts
                if part.inline_data and not part.thought
            ]

            if image_parts:
                if self.verbose:
                    print(f"Edited image generated: {len(image_parts[0])} bytes")
                return image_parts[0]
            else:
                if self.verbose:
                    print("No edited image returned, using original")
                return image_bytes

        except Exception as e:
            print(f"Image editing failed: {e}")
            return base64.b64decode(image_data)

    def save_image(self, image_data: bytes, output_path: str, optimize_quality: bool = True) -> str:
        """Save image bytes to file with quality optimization."""
        try:
            output_file = Path(output_path).resolve()
            output_file.parent.mkdir(parents=True, exist_ok=True)

            # Open and verify image
            image = Image.open(BytesIO(image_data))

            if self.verbose:
                print(f"Saving HIGH QUALITY image: {image.format} {image.size} to {output_file}")

            # Save with quality optimization
            if optimize_quality and output_path.lower().endswith(('.jpg', '.jpeg')):
                # For JPEG, use maximum quality
                image.save(output_file, quality=100, optimize=False, subsampling=0)
                if self.verbose:
                    print("Saved as JPEG with maximum quality (100)")
            elif optimize_quality and output_path.lower().endswith('.png'):
                # For PNG, save with best compression
                image.save(output_file, compress_level=1)  # Lower compression = better quality
                if self.verbose:
                    print("Saved as PNG with minimal compression for best quality")
            else:
                # Save original bytes directly for best fidelity
                with open(output_file, 'wb') as f:
                    f.write(image_data)
                if self.verbose:
                    print("Saved original image data without recompression")

            return str(output_file)
        except Exception as e:
            raise Exception(f"Save failed: {e}")


def validate_environment():
    """Check for required environment variables."""
    firecrawl_key = os.getenv('FIRECRAWL_API_KEY')
    gemini_key = os.getenv('GEMINI_API_KEY')

    missing = []
    if not firecrawl_key:
        missing.append('FIRECRAWL_API_KEY')
    if not gemini_key:
        missing.append('GEMINI_API_KEY')

    if missing:
        print("Error: Missing environment variables:")
        for var in missing:
            print(f"  - {var}")
        print("\nSet them in .env file or export them:")
        print("  export FIRECRAWL_API_KEY='your-key-here'")
        print("  export GEMINI_API_KEY='your-key-here'")
        sys.exit(1)

    return firecrawl_key, gemini_key


def main():
    """Enhanced CLI with all features."""
    parser = argparse.ArgumentParser(
        prog='cli.py',
        usage='%(prog)s [URL] [MODE] [OPTIONS]',
        description="Firecrawl + Gemini 3.1 Flash-Lite Image CLI - Transform website screenshots with AI",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
EXAMPLES:

  Basic Operations:
    %(prog)s https://example.com --style cyberpunk
    %(prog)s https://site.com --edit "Make it look vintage"
    %(prog)s --generate "A futuristic website design"

  Artistic Style Transfer:
    %(prog)s https://example.com --artistic van_gogh
    %(prog)s https://site.com --artistic monet --preserve-content

  Multi-Image Composition:
    %(prog)s --compose image1.png image2.png --prompt "Blend these images"
    %(prog)s https://site1.com https://site2.com --composite "Merge these designs"

  Iterative Refinement:
    %(prog)s https://example.com --refine "Add neon" "Increase contrast" "Add rain"

  Batch Processing:
    %(prog)s --batch urls.txt --edit "Apply cyberpunk style"

ARTISTIC STYLES:
  van_gogh      - Starry Night swirling brushstrokes
  monet         - Impressionist soft colors
  picasso       - Cubist geometric shapes
  warhol        - Pop art bold colors
  dali          - Surrealist dreamlike
  ukiyo_e       - Japanese woodblock print
  watercolor    - Delicate translucent painting
  oil_painting  - Classical realistic textures
  pencil_sketch - Detailed pencil drawing
  comic_book    - Bold outlines and vibrant colors

PRESET STYLES:
  cyberpunk     - Neon colors and futuristic
  vintage       - Sepia tones and aged
  artistic      - Oil painting style
  dramatic      - High contrast cinematic
  minimal       - Clean simplified design
        """
    )

    # Main input arguments
    parser.add_argument('urls', nargs='*', help='Website URLs or image files')

    # Operation modes (mutually exclusive)
    mode_group = parser.add_mutually_exclusive_group()
    mode_group.add_argument('--generate', metavar='PROMPT',
                           help='Generate image from text prompt')
    mode_group.add_argument('--style',
                           choices=['cyberpunk', 'vintage', 'artistic', 'dramatic', 'minimal'],
                           help='Apply preset style')
    mode_group.add_argument('--artistic',
                           choices=['van_gogh', 'monet', 'picasso', 'warhol', 'dali',
                                   'ukiyo_e', 'watercolor', 'oil_painting', 'pencil_sketch', 'comic_book'],
                           help='Apply artistic style')
    mode_group.add_argument('--edit', metavar='PROMPT',
                           help='Custom editing instruction')
    mode_group.add_argument('--composite', metavar='PROMPT',
                           help='Combine multiple images')
    mode_group.add_argument('--refine', nargs='+', metavar='STEP',
                           help='Apply step-by-step refinements')

    # Input/Output options
    io_group = parser.add_argument_group('Input/Output')
    io_group.add_argument('--output', '-o', help='Output filename')
    io_group.add_argument('--output-dir', default='output', help='Output directory')
    io_group.add_argument('--batch', metavar='FILE', help='Process URLs from file')
    io_group.add_argument('--compose', nargs='+', metavar='IMAGE', help='Additional images')

    # Screenshot options
    screenshot_group = parser.add_argument_group('Screenshot Options')
    screenshot_group.add_argument('--mobile', action='store_true', help='Mobile viewport')
    screenshot_group.add_argument('--viewport-only', action='store_true', help='Viewport only')
    screenshot_group.add_argument('--wait', type=int, default=3, help='Wait seconds before capture')

    # Processing options
    process_group = parser.add_argument_group('Processing Options')
    process_group.add_argument('--preserve-content', action='store_true',
                              help='Preserve original layout')
    process_group.add_argument('--save-intermediates', action='store_true',
                              help='Save refinement steps')
    process_group.add_argument('--high-quality', action='store_true', default=True,
                              help='Maximum quality (default: on)')
    process_group.add_argument('--verbose', '-v', action='store_true', help='Show details')

    # API configuration
    api_group = parser.add_argument_group('API Configuration')
    api_group.add_argument('--firecrawl-url', help='Custom Firecrawl endpoint')

    args = parser.parse_args()

    # Validate environment
    firecrawl_key, gemini_key = validate_environment()

    # Initialize editor
    editor = FirecrawlGeminiEditor(
        firecrawl_key, gemini_key,
        firecrawl_url=args.firecrawl_url,
        verbose=args.verbose
    )

    try:
        # Process based on mode
        if args.generate:
            # Text-to-image generation
            print("Generating image from text...")
            image_data = editor.generate_image_from_text(
                args.generate,
                style=args.artistic
            )
            output_path = args.output or f"generated_{datetime.now().strftime('%Y%m%d_%H%M%S')}.png"
            result = editor.save_image(image_data, output_path)

        elif args.batch:
            # Batch processing
            print(f"Batch processing from {args.batch}...")
            with open(args.batch, 'r') as f:
                urls = [line.strip() for line in f if line.strip()]

            edit_prompt = args.edit or "Enhance this image"
            results = editor.batch_process_urls(urls, edit_prompt, args.output_dir)
            print(f"\nProcessed {len(results)} URLs")
            result = args.output_dir

        elif args.composite or len(args.urls) > 1:
            # Multi-image composition
            print("Creating composite image...")
            images = []

            # Capture screenshots from URLs
            for url in args.urls:
                if url.startswith('http'):
                    print(f"Capturing: {url}")
                    screenshot = editor.capture_screenshot(
                        url,
                        full_page=not args.viewport_only,
                        mobile=args.mobile,
                        wait_time=args.wait
                    )
                    images.append(screenshot)
                else:
                    # Load local image
                    with open(url, 'rb') as f:
                        images.append(base64.b64encode(f.read()).decode())

            # Add compose images if specified
            if args.compose:
                for img_path in args.compose:
                    with open(img_path, 'rb') as f:
                        images.append(base64.b64encode(f.read()).decode())

            prompt = args.composite or "Creatively combine these images into a cohesive design"
            composite = editor.composite_images(images, prompt)

            output_path = args.output or f"composite_{datetime.now().strftime('%Y%m%d_%H%M%S')}.png"
            result = editor.save_image(composite, output_path)

        elif args.refine:
            # Iterative refinement
            if not args.urls:
                print("Error: URL required for refinement")
                sys.exit(1)

            print(f"Capturing screenshot: {args.urls[0]}")
            screenshot = editor.capture_screenshot(
                args.urls[0],
                full_page=not args.viewport_only,
                mobile=args.mobile,
                wait_time=args.wait
            )

            print(f"Applying {len(args.refine)} refinements...")
            # Use output_dir if provided, otherwise save in current directory
            refinement_dir = args.output_dir if args.save_intermediates else None
            if args.save_intermediates and refinement_dir:
                print(f"Saving intermediates to: {refinement_dir}")
            elif args.save_intermediates:
                print("Saving intermediates to current directory")

            refined = editor.iterative_refinement(
                screenshot,
                args.refine,
                save_intermediates=args.save_intermediates,
                output_dir=refinement_dir
            )

            output_path = args.output or f"refined_{datetime.now().strftime('%Y%m%d_%H%M%S')}.png"
            result = editor.save_image(refined, output_path)

        elif args.artistic:
            # Artistic style transfer
            if not args.urls:
                print("Error: URL required for style transfer")
                sys.exit(1)

            print(f"Capturing screenshot: {args.urls[0]}")
            screenshot = editor.capture_screenshot(
                args.urls[0],
                full_page=not args.viewport_only,
                mobile=args.mobile,
                wait_time=args.wait
            )

            print(f"Applying artistic style: {args.artistic}")
            styled = editor.apply_style_transfer(
                screenshot,
                args.artistic,
                preserve_content=args.preserve_content
            )

            output_path = args.output or f"{args.artistic}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.png"
            result = editor.save_image(styled, output_path)

        else:
            # Standard screenshot editing
            if not args.urls:
                print("Error: URL required")
                sys.exit(1)

            print(f"Capturing screenshot: {args.urls[0]}")
            screenshot = editor.capture_screenshot(
                args.urls[0],
                full_page=not args.viewport_only,
                mobile=args.mobile,
                wait_time=args.wait
            )

            # Determine edit prompt
            if args.style:
                style_prompts = {
                    'cyberpunk': 'Transform into cyberpunk style with neon colors',
                    'vintage': 'Apply vintage effect with sepia tones',
                    'artistic': 'Convert to oil painting style',
                    'dramatic': 'Create dramatic cinematic look',
                    'minimal': 'Simplify to minimal design'
                }
                edit_prompt = style_prompts[args.style]
            elif args.edit:
                edit_prompt = args.edit
            else:
                edit_prompt = "Enhance this image with better colors and modern styling"

            edited = editor.edit_image_with_prompt(screenshot, edit_prompt)

            domain = urlparse(args.urls[0]).netloc.replace('www.', '')
            output_path = args.output or f"{domain}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.png"
            result = editor.save_image(edited, output_path)

        print("\n" + "="*50)
        print("✅ SUCCESS!")
        print(f"📁 Output: {result}")
        print("="*50)

    except KeyboardInterrupt:
        print("\n❌ Cancelled by user")
        sys.exit(1)
    except Exception as e:
        print(f"\n❌ Error: {e}")
        if args.verbose:
            import traceback
            traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    main()