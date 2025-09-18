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

def poster_mode_prompt(title="Now Live!", brand_color="#1D9BF0"):
    return f"""
    Place this website screenshot in the center of a tech poster with
    gradient background {brand_color} and title '{title}'.
    """

def redesign_prompt(style="modern minimalistic"):
    return f"""
    Redesign this website screenshot in a {style} style.
    Use flat design, clean typography, and modern UI principles.
    """

# Feature mapping
FEATURES = {
    "dark_mode": dark_mode_prompt,
    "mobile_mockup": mobile_mockup_prompt,
    "wireframe": wireframe_prompt,
    "accessibility": accessibility_prompt,
    "highlight_cta": highlight_cta_prompt,
    "localization": localization_prompt,
    "privacy_blur": privacy_blur_prompt,
    "poster": poster_mode_prompt,
    "redesign": redesign_prompt,
}
