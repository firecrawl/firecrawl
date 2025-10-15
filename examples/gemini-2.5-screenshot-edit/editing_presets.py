"""
Creative editing style presets for screenshot editing with Gemini 2.5
Each preset contains a name, description, and the associated editing prompt.
"""

EDITING_PRESETS = {
    "minimalist": {
        "name": "Minimalist Clean",
        "description": "Clean, minimal design with lots of whitespace and simple elements",
        "prompt": "Transform this screenshot into a minimalist design. Remove visual clutter, increase whitespace, use a clean monochromatic or limited color palette (whites, grays, one accent color), simplify UI elements, use clean typography, and create a serene, uncluttered aesthetic. Focus on essential elements only.",
    },
    "retro_80s": {
        "name": "Retro 80s Vibe",
        "description": "Nostalgic 1980s aesthetic with neon colors and vintage elements",
        "prompt": "Give this screenshot a retro 1980s makeover. Add neon pink, cyan, and purple colors, incorporate grid patterns, use retro fonts like those from old computer terminals, add subtle scan lines or VHS effects, create a synthwave aesthetic with geometric shapes, and make it look like it's from a classic 80s computer interface.",
    },
    "cyberpunk": {
        "name": "Cyberpunk Futuristic",
        "description": "Dark, high-tech aesthetic with neon accents and futuristic elements",
        "prompt": "Transform this screenshot into a cyberpunk-themed interface. Use a dark background with electric blue, neon green, and hot pink accents. Add futuristic UI elements, glitch effects, holographic overlays, digital noise, matrix-style elements, and make it look like a high-tech interface from a sci-fi movie. Include subtle scanlines and digital artifacts.",
    },
    "vintage_paper": {
        "name": "Vintage Paper",
        "description": "Warm, aged paper aesthetic with vintage typography and sepia tones",
        "prompt": "Give this screenshot a vintage paper aesthetic. Make it look like it's printed on aged, cream-colored paper with subtle texture and stains. Use warm sepia and brown tones, vintage serif typography, add subtle paper grain, coffee stains, and worn edges. Make it feel like an old newspaper or vintage poster from the 1920s-1940s.",
    },
    "glass_morphism": {
        "name": "Glass Morphism",
        "description": "Modern glass-like translucent elements with blur effects",
        "prompt": "Apply a glassmorphism design to this screenshot. Create translucent, glass-like elements with subtle blur effects, frosted glass textures, soft shadows, and light reflections. Use a clean, modern color palette with gradients, make UI elements appear to float with depth, and add subtle transparency effects that make everything look like it's made of beautiful frosted glass.",
    },
    "neon_dark": {
        "name": "Neon Dark Mode",
        "description": "Dark theme with vibrant neon highlights and glowing effects",
        "prompt": "Transform this screenshot into a striking neon dark mode design. Use a deep black or dark gray background with vibrant neon colors (electric blue, hot pink, lime green, orange) for accents and text. Add glowing effects around buttons and important elements, create neon-like borders, and make the interface feel like a nightclub or arcade game from the future.",
    },
    "watercolor": {
        "name": "Watercolor Artistic",
        "description": "Soft, artistic watercolor painting style with flowing colors",
        "prompt": "Give this screenshot a watercolor painting aesthetic. Replace solid colors with soft, flowing watercolor textures, add paint bleeding effects, use pastel and muted colors that blend into each other, create brush stroke textures, add paper texture underneath, and make the entire interface look like it was painted with watercolors on textured paper.",
    },
    "brutalist": {
        "name": "Brutalist Bold",
        "description": "Raw, bold design with strong contrasts and geometric shapes",
        "prompt": "Apply a brutalist design aesthetic to this screenshot. Use bold, high-contrast colors (black, white, bright red or yellow), create angular geometric shapes, use heavy, condensed typography, remove rounded corners and make everything sharp and angular, add raw concrete-like textures, and create a powerful, unapologetic visual impact with stark, dramatic contrasts.",
    },
    "pastel_kawaii": {
        "name": "Pastel Kawaii",
        "description": "Cute, soft pastel colors with adorable Japanese-inspired elements",
        "prompt": "Transform this screenshot into a kawaii (cute) pastel design. Use soft pastel colors (baby pink, lavender, mint green, peach, sky blue), add cute rounded elements, incorporate small adorable icons or decorative elements, use bubbly fonts, add subtle sparkles or stars, and create an overall sweet, gentle, and charming aesthetic inspired by Japanese kawaii culture.",
    },
    "art_deco": {
        "name": "Art Deco Elegance",
        "description": "Luxurious 1920s Art Deco style with geometric patterns and gold accents",
        "prompt": "Give this screenshot an Art Deco makeover inspired by the 1920s. Use geometric patterns, elegant typography with serifs, incorporate gold and black color schemes, add sunburst or fan patterns, create stepped geometric shapes, use metallic textures, and make it feel luxurious and sophisticated like a grand hotel lobby or theater from the Jazz Age.",
    },
    "sketch_hand_drawn": {
        "name": "Hand-Drawn Sketch",
        "description": "Pencil sketch aesthetic with hand-drawn elements and textures",
        "prompt": "Convert this screenshot into a hand-drawn sketch style. Make elements look like they're drawn with pencil on paper, add sketch lines, cross-hatching for shadows, imperfect hand-drawn shapes, paper texture background, and rough, organic edges. Use grayscale or limited color palette, and make it feel like an architect's or designer's sketch pad.",
    },
    "holographic": {
        "name": "Holographic Future",
        "description": "Iridescent, holographic effects with rainbow gradients and sci-fi elements",
        "prompt": "Apply a holographic, futuristic aesthetic to this screenshot. Add iridescent rainbow gradients that shift between purple, blue, pink, and green, create holographic foil-like textures, add subtle 3D depth effects, use metallic chrome accents, incorporate subtle grid overlays, and make elements appear to float with prismatic light effects like a hologram.",
    },
}


def get_preset_choices():
    """Return a list of preset choices for selection"""
    choices = []
    for key, preset in EDITING_PRESETS.items():
        choices.append(
            {"name": f"{preset['name']} - {preset['description']}", "value": key}
        )
    choices.append(
        {
            "name": "Custom Prompt - Enter your own creative editing instructions",
            "value": "custom",
        }
    )
    return choices


def get_preset_prompt(preset_key):
    """Get the editing prompt for a specific preset"""
    if preset_key in EDITING_PRESETS:
        return EDITING_PRESETS[preset_key]["prompt"]
    return None


def build_system_prompt(editing_prompt):
    """Build a comprehensive system prompt for image editing"""
    system_prompt = f"""You are an expert image editor and designer. Your task is to edit and transform the provided screenshot according to the following creative direction:

{editing_prompt}

Guidelines for editing:
- Maintain the overall structure and readability of the interface
- Ensure text remains legible even after stylistic changes
- Preserve important functional elements while applying the aesthetic transformation
- Be creative but practical - the interface should still be usable
- Apply the style consistently across all elements in the screenshot
- Pay attention to color harmony, contrast, and visual hierarchy

Transform the screenshot while keeping these principles in mind. Be bold and creative in your interpretation of the style direction."""

    return system_prompt
