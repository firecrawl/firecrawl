def dark_mode_prompt():
    return """
    Convert this website screenshot into a sleek dark mode design.
    Emphasize readability, contrast, buttons, menus, and text clarity.
    """


def mobile_mockup_prompt(device="iPhone"):
    return f"""
    Place this screenshot inside a realistic {device} mobile phone mockup
    with a neutral or black background.
    """


def wireframe_prompt():
    return """
    Convert this website screenshot into a wireframe mockup.
    Show only layout blocks in black-and-white, hide colors and branding.
    """


def accessibility_prompt(simulation="protanopia"):
    return f"""
    Simulate {simulation} color blindness on this screenshot.
    Highlight potential readability issues.
    """


def highlight_cta_prompt():
    return """
    Highlight all main CTAs, navigation menus, hero sections, and footers
    using arrows and labels on the screenshot.
    """


def localization_prompt(language="es"):
    return f"""
    Translate all visible text in this screenshot into {language}.
    Maintain layout and style.
    """


def privacy_blur_prompt():
    return """
    Detect and blur sensitive personal information like emails, phone numbers,
    usernames, and payment details.
    """


def device_mockup_prompt(device="MacBook"):
    return f"""
    Place this screenshot inside a realistic {device} mockup with
    subtle shadows and neutral background for presentation purposes.
    """


def light_mode_prompt():
    return """
    Convert this screenshot into a clean light mode version.
    Use bright backgrounds, high contrast, and clear text readability.
    """


def hero_section_prompt():
    return """
    Extract and enhance the hero section of this website screenshot.
    Center it and make it presentation-ready.
    """


def brand_color_swap_prompt(color="#FF5733"):
    return f"""
    Recolor this website screenshot to use the brand color {color}
    for buttons, highlights, and primary accents.
    """


def focus_mode_prompt():
    return """
    Blur sidebars, ads, and footers. Keep only the main content
    in sharp focus to simulate a distraction-free reader mode.
    """


def social_preview_prompt(platform="Twitter", title="Now Live!"):
    return f"""
    Place this website screenshot into a {platform} social media post preview
    with proper aspect ratio, realistic framing, and title '{title}'.
    """


def redesign_material_prompt():
    return """
    Redesign this website screenshot using Google's Material UI guidelines.
    Use flat design, card layouts, and MD3 color system.
    """


def redesign_bootstrap_prompt():
    return """
    Redesign this website screenshot using Bootstrap 5 principles.
    Use grid layout, primary/secondary button styles, and clean spacing.
    """


def redesign_modern_minimal_prompt():
    return """
    Redesign this website screenshot in a modern minimalistic style.
    Use flat design, clean typography, and generous white space.
    """


FEATURES = {
    "dark_mode": dark_mode_prompt,
    "light_mode": light_mode_prompt,
    "mobile_mockup": mobile_mockup_prompt,
    "tablet_mockup": device_mockup_prompt,
    "wireframe": wireframe_prompt,
    "hero_section": hero_section_prompt,
    "highlight_cta": highlight_cta_prompt,
    "focus_mode": focus_mode_prompt,
    "accessibility": accessibility_prompt,
    "localization": localization_prompt,
    "privacy_blur": privacy_blur_prompt,
    "brand_color_swap": brand_color_swap_prompt,
    "social_preview": social_preview_prompt,
    "redesign_material": redesign_material_prompt,
    "redesign_bootstrap": redesign_bootstrap_prompt,
    "redesign_minimal": redesign_modern_minimal_prompt,
}
