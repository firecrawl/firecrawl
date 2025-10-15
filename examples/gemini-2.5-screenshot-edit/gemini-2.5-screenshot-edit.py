from google import genai
from dotenv import load_dotenv
import os
from firecrawl import Firecrawl
import validators
import requests
from io import BytesIO
from PIL import Image
import questionary
from datetime import datetime
from editing_presets import get_preset_choices, get_preset_prompt, build_system_prompt

load_dotenv()

gemini_api_key = os.getenv("GEMINI_API_KEY")
firecrawl_api_key = os.getenv("FIRECRAWL_API_KEY")

if not gemini_api_key:
    raise ValueError("GEMINI_API_KEY must be set in environment variables")
if not firecrawl_api_key:
    raise ValueError("FIRECRAWL_API_KEY must be set in environment variables")

client = genai.Client(api_key=gemini_api_key)
firecrawl = Firecrawl(api_key=firecrawl_api_key)


def is_valid_url(url: str):
    """Validate if the input string is a valid URL and return normalized URL"""
    try:
        # Add https:// if no scheme is provided
        if not url.startswith(("http://", "https://")):
            url = "https://" + url

        if validators.url(url):
            return url
        return False
    except Exception:
        return False


def get_image_from_url(url: str):
    """Get the image from the given URL"""
    response = requests.get(url)
    response.raise_for_status()
    return Image.open(BytesIO(response.content))


def generate_filename(prefix: str) -> str:
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    return f"{prefix}_{stamp}.png"


def scrape_website_screenshot(url: str):
    """Capture screenshot of the given URL using Firecrawl and return the screenshot URL"""
    try:
        result = firecrawl.scrape(url=url, formats=["screenshot"])

        if result and hasattr(result, "screenshot") and result.screenshot:
            return result.screenshot
        else:
            return None

    except Exception as e:
        print(f"Error scraping website: {str(e)}")
        return None


def edit_screenshot(
    image: Image.Image, system_prompt: str, version: int, filename_suffix: str = ""
):
    """Edit the screenshot using Gemini 2.5 Flash with system prompt"""
    try:
        print("Editing screenshot...")
        response = client.models.generate_content(
            model="gemini-2.5-flash-image-preview", contents=[system_prompt, image]
        )

        if response.candidates[0].content.parts is None:
            print("No response from Gemini")
            return None

        for part in response.candidates[0].content.parts:
            if part.inline_data is not None:
                image = Image.open(BytesIO(part.inline_data.data))
                filename = generate_filename(
                    f"edited_screenshot_v{version}{filename_suffix}"
                )
                image.save(filename)
                print(f"Image saved to {filename}")
                return image
    except Exception as e:
        print(f"Error editing screenshot: {str(e)}")
        return None


def main():
    try:
        current_image = None
        reference_stack = []
        version = 0

        while True:
            url = input("Enter a website URL: ").strip()
            if not url:
                print("Please enter a valid URL.")
                continue

            normalized_url = is_valid_url(url)
            if not normalized_url:
                print("Invalid URL format. Try e.g. https://google.com or google.com")
                continue

            print(f"Capturing screenshot of {normalized_url}...")
            screenshot_url = scrape_website_screenshot(normalized_url)
            if not screenshot_url:
                print("Failed to capture screenshot.")
                retry = (
                    input("Would you like to try another URL? (y/n): ").strip().lower()
                )
                if retry != "y":
                    break
                continue

            try:
                current_image = get_image_from_url(screenshot_url)
                print("Screenshot captured successfully!")
            except Exception as e:
                print(f"Failed to download screenshot: {e}")
                continue

            # Reset versioning for a fresh URL
            version = 0
            reference_stack = [current_image]  # v1 will be produced from this reference

            while True:
                if version == 0:  # First edit - show preset styles
                    print("Choose an editing style for your screenshot:")
                    preset_choices = get_preset_choices()
                    selected_preset = questionary.select(
                        "Select an editing style:", choices=preset_choices
                    ).ask()

                    if selected_preset is None:
                        break

                    if selected_preset == "custom":
                        custom_prompt = input(
                            "\nEnter your custom editing prompt: "
                        ).strip()
                        if not custom_prompt:
                            continue
                        system_prompt = build_system_prompt(custom_prompt)
                        edit_description = "Custom Style"
                    else:
                        preset_prompt = get_preset_prompt(selected_preset)
                        system_prompt = build_system_prompt(preset_prompt)
                        edit_description = preset_choices[
                            next(
                                i
                                for i, choice in enumerate(preset_choices)
                                if choice["value"] == selected_preset
                            )
                        ]["name"].split(" - ")[0]

                    version += 1
                    reference_image = reference_stack[-1]  # last reference used
                    print(f"\nApplying {edit_description} style...")
                    edited_image = edit_screenshot(
                        reference_image, system_prompt, version
                    )
                    if not edited_image:
                        print("Failed to edit screenshot.")
                        again = input("Try a different style? (y/n): ").strip().lower()
                        if again == "y":
                            version -= 1  # don't consume a version number on failure
                            continue
                        else:
                            break

                    current_image = edited_image
                    # For "edit further", the new reference becomes the current result
                    reference_stack.append(current_image)

                else:  # Subsequent edits - show different menu
                    choices = [
                        "Edit the screenshot further (custom prompt only)",
                        "Redo last edit with same reference",
                        "Redo with another style (back to original)",
                        "Start over with a new URL",
                        "Exit",
                    ]
                    choice = questionary.select(
                        "What would you like to do next?", choices=choices
                    ).ask()

                    if choice is None:
                        break

                    if choice == "Edit the screenshot further (custom prompt only)":
                        custom_prompt = input(
                            "\nEnter your custom editing prompt: "
                        ).strip()
                        if not custom_prompt:
                            continue
                        system_prompt = build_system_prompt(custom_prompt)
                        edit_description = "Custom Style"

                        version += 1
                        reference_image = reference_stack[-1]  # last reference used
                        print(f"\nApplying {edit_description}...")
                        edited_image = edit_screenshot(
                            reference_image, system_prompt, version
                        )
                        if not edited_image:
                            print("Failed to edit screenshot.")
                            continue

                        current_image = edited_image
                        reference_stack.append(current_image)

                    elif choice == "Redo last edit with same reference":
                        # Use the same reference as the current version
                        if len(reference_stack) >= 2:
                            redo_reference = reference_stack[-2]
                        else:
                            redo_reference = reference_stack[-1]

                        redo_custom_prompt = input(
                            "\nEnter your custom editing prompt for redo: "
                        ).strip()
                        if not redo_custom_prompt:
                            continue
                        redo_system_prompt = build_system_prompt(redo_custom_prompt)
                        redo_description = "Custom Style"

                        print(f"\nRe-applying {redo_description}...")
                        redo_image = edit_screenshot(
                            redo_reference,
                            redo_system_prompt,
                            version,
                            filename_suffix="-redo",
                        )
                        if not redo_image:
                            print("Failed to generate redo image.")
                        else:
                            print("Redo image generated.")

                    elif choice == "Redo with another style (back to original)":
                        print("\n" + "=" * 50)
                        print("Choose a style to apply to the original screenshot:")
                        print("=" * 50)

                        redo_preset_choices = get_preset_choices()
                        redo_selected_preset = questionary.select(
                            "Select an editing style:",
                            choices=redo_preset_choices,
                        ).ask()

                        if redo_selected_preset is None:
                            continue

                        if redo_selected_preset == "custom":
                            redo_custom_prompt = input(
                                "\nEnter your custom editing prompt: "
                            ).strip()
                            if not redo_custom_prompt:
                                continue
                            redo_system_prompt = build_system_prompt(redo_custom_prompt)
                            redo_description = "Custom Style"
                        else:
                            redo_preset_prompt = get_preset_prompt(redo_selected_preset)
                            redo_system_prompt = build_system_prompt(redo_preset_prompt)
                            redo_description = redo_preset_choices[
                                next(
                                    i
                                    for i, choice in enumerate(redo_preset_choices)
                                    if choice["value"] == redo_selected_preset
                                )
                            ]["name"].split(" - ")[0]

                        # Use the original screenshot (first in reference stack)
                        original_reference = reference_stack[0]
                        print(
                            f"\nApplying {redo_description} to original screenshot..."
                        )
                        redo_image = edit_screenshot(
                            original_reference,
                            redo_system_prompt,
                            1,  # Reset to version 1 since we're starting over from original
                            filename_suffix="-original-redo",
                        )
                        if not redo_image:
                            print("Failed to generate redo image.")
                        else:
                            print("Redo from original generated.")
                            # Reset the stack to just original + new result, and start fresh
                            current_image = redo_image
                            reference_stack = [reference_stack[0], redo_image]
                            version = (
                                1  # Reset version since we're essentially starting over
                            )

                    elif choice == "Start over with a new URL":
                        break  # break editing loop -> ask for url again

                    elif choice == "Exit":
                        return

    except KeyboardInterrupt:
        print("\nExiting...")
        return


if __name__ == "__main__":
    main()
