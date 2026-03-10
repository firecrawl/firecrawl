import { BrandingProfile } from "../../types/branding";
import { ButtonSnapshot, BrandingLLMInput } from "./types";
import { parse, rgb } from "culori";

/** Sanitize untrusted text for safe prompt interpolation. */
function sanitize(str: string | undefined | null, maxLen: number): string {
  if (!str) return "";
  return str
    .replace(/[\r\n]+/g, " ")
    .replace(/[\x00-\x1f\x7f]/g, "")
    .replace(/`/g, "")
    .replace(/"/g, '\\"')
    .trim()
    .substring(0, maxLen);
}

export function buildBrandingPrompt(input: BrandingLLMInput): string {
  const {
    jsAnalysis,
    buttons,
    logoCandidates,
    brandName,
    pageTitle,
    pageUrl,
    backgroundCandidates,
    url,
    headerHtmlChunk,
    favicon,
    ogImage,
    heuristicLogoPick,
  } = input;
  const safeBrandName = sanitize(brandName, 80);
  const safePageTitle = sanitize(pageTitle, 200);
  const normalizedBrandName = safeBrandName.toLowerCase().replace(/\s+/g, "");
  const displayUrl = pageUrl || url;
  const hasPageContext = !!(safePageTitle || displayUrl);

  let prompt = `Analyze the branding of this website`;
  if (displayUrl) prompt += `: ${displayUrl}`;
  prompt += `\n\n`;
  if (hasPageContext) {
    prompt += `## Page context (use to infer the site's brand)\n`;
    if (displayUrl)
      prompt += `- **URL** (final after redirects): ${displayUrl}\n`;
    if (safePageTitle) prompt += `- **Page title**: "${safePageTitle}"\n`;
    prompt += `Use the full page title and URL to infer the site's brand. Many sites use "Page Name | Brand" or "Brand - Page Name" — the brand is often the **second part** (e.g. "AI Innovation Workspace | Miro" → brand is Miro) or the **domain** from the URL. Pick the logo that matches the **actual brand** (from title/URL), not necessarily the first phrase in the title. Our heuristic brand name below is a hint; prefer your inference from title/URL when it makes more sense.\n\n`;
  }

  const hasLogoCandidates = !!(logoCandidates && logoCandidates.length > 0);
  if (!hasLogoCandidates) {
    prompt += `## Logo candidates: None\n`;
    prompt += `No logo candidates were extracted from this page. Do not return or attempt to select a logo. The response schema does not include logoSelection when there are no candidates.\n\n`;

    if (headerHtmlChunk && headerHtmlChunk.length > 0) {
      prompt += `## Page HTML (header/nav snippet)\n`;
      prompt += `Below is a simplified snippet of the page header/nav area. Use it only for context:\n`;
      prompt += `- **Brand name**: Infer from link text, aria-labels, or title attributes (e.g. \`<a aria-label="X logo">\`, \`<title>X</title>\`).\n`;
      prompt += `- **Logo note**: If you see a logo-like element (e.g. \`<a aria-label*="logo">\`, \`<img>\` in header, inline \`<svg>\`) that wasn't captured as a candidate, you may note it in reasoning—but do NOT return a logo URL or index from this HTML. Only logo candidates (none here) can be selected.\n`;
      const safeHeaderChunk = sanitize(headerHtmlChunk, 3000);
      prompt += `\n\`\`\`html\n${safeHeaderChunk}\n\`\`\`\n\n`;
    }
  }

  // Add JS analysis context
  prompt += `## JavaScript Analysis (Baseline):\n`;
  prompt += `Color Scheme: ${jsAnalysis.colorScheme || "unknown"}\n`;

  if (jsAnalysis.colors) {
    prompt += `Detected Colors:\n`;
    Object.entries(jsAnalysis.colors).forEach(([key, value]) => {
      if (value) prompt += `- ${key}: ${value}\n`;
    });
  }

  if (jsAnalysis.fonts && jsAnalysis.fonts.length > 0) {
    prompt += `\nRaw Fonts (need cleaning):\n`;
    jsAnalysis.fonts.forEach((font: any) => {
      const family = typeof font === "string" ? font : font.family;
      const count = typeof font === "object" && font.count ? font.count : "";
      prompt += `- ${family}${count ? ` (used ${count}x)` : ""}\n`;
    });
    prompt += `\n**FONT CLEANING INSTRUCTIONS:**\n`;
    prompt += `- Remove obfuscated names (e.g., "__suisse_6d5c28" → "Suisse", "__Roboto_Mono_c8ca7d" → "Roboto Mono")\n`;
    prompt += `- Skip fallback fonts (e.g., "__suisse_Fallback_6d5c28" → ignore)\n`;
    prompt += `- Skip CSS variables (e.g., "var(--font-sans)" → ignore)\n`;
    prompt += `- Skip generic fonts (e.g., "system-ui", "sans-serif", "ui-sans-serif" → ignore)\n`;
    prompt += `- Keep only real, meaningful brand fonts (max 5)\n`;
    prompt += `- Assign roles based on usage: heading, body, monospace, display\n\n`;
  }

  // Helper to analyze color vibrancy
  const getColorInfo = (colorStr: string) => {
    if (!colorStr || colorStr === "transparent")
      return { isVibrant: false, description: "transparent" };

    let r = 0,
      g = 0,
      b = 0;
    try {
      const color = parse(colorStr);
      if (color) {
        const rgbColor = rgb(color);
        if (rgbColor && rgbColor.mode === "rgb") {
          r = Math.round((rgbColor.r ?? 0) * 255);
          g = Math.round((rgbColor.g ?? 0) * 255);
          b = Math.round((rgbColor.b ?? 0) * 255);
        }
      }
    } catch (e) {
      return {
        isVibrant: false,
        description: "unknown",
        saturation: "0.00",
        brightness: "0.00",
      };
    }

    // Calculate saturation and brightness
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const saturation = max === 0 ? 0 : (max - min) / max;
    const brightness = max / 255;

    // Vibrant = high saturation (>0.3) and decent brightness (>0.2)
    const isVibrant = saturation > 0.3 && brightness > 0.2;

    // Describe the color
    let description = "";
    if (g > r && g > b && g > 100) description = "green";
    else if (b > r && b > g && b > 100) description = "blue";
    else if (r > g && r > b && r > 100) description = "red/orange";
    else if (max < 50) description = "dark";
    else if (min > 200) description = "light/white";
    else description = "neutral";

    return {
      isVibrant,
      description,
      saturation: saturation.toFixed(2),
      brightness: brightness.toFixed(2),
    };
  };

  const baseHostname = (() => {
    try {
      return new URL(displayUrl).hostname.toLowerCase();
    } catch {
      return "";
    }
  })();

  const extractFilename = (src: string) => {
    if (!src) return "";
    const withoutQuery = src.split("?")[0].split("#")[0];
    const parts = withoutQuery.split("/");
    return parts.pop() || "";
  };

  const classifyHref = (href?: string, hrefMatch?: boolean) => {
    if (!href || !href.trim()) return "none";
    if (hrefMatch) return "home";
    try {
      const resolved = new URL(href, displayUrl);
      if (!resolved.hostname || !baseHostname) return "internal";
      return resolved.hostname.toLowerCase() === baseHostname
        ? "internal"
        : "external";
    } catch {
      return "unknown";
    }
  };

  const getLogoCandidateMeta = (
    candidate: NonNullable<BrandingLLMInput["logoCandidates"]>[number],
  ) => {
    const width = Math.max(0, Math.round(candidate.position?.width || 0));
    const height = Math.max(0, Math.round(candidate.position?.height || 0));
    const top = Math.max(0, Math.round(candidate.position?.top || 0));
    const left = Math.max(0, Math.round(candidate.position?.left || 0));
    const area = Math.max(0, Math.round(width * height));
    const aspectRatio =
      width && height ? Math.max(width / height, height / width) : 0;
    const maxSide = Math.max(width, height);

    let sizeLabel = "unknown";
    if (maxSide <= 24 || area <= 400) sizeLabel = "tiny";
    else if (maxSide <= 48 || area <= 1800) sizeLabel = "small";
    else if (maxSide <= 140 || area <= 12000) sizeLabel = "medium";
    else if (maxSide <= 320 || area <= 50000) sizeLabel = "large";
    else sizeLabel = "hero";

    const hrefType = classifyHref(
      candidate.href,
      candidate.indicators?.hrefMatch,
    );
    const srcFilename = extractFilename(candidate.src);
    const filenameHasLogo = /logo|brand/i.test(srcFilename || "");
    const srcHasLogo = /logo|brand/i.test(candidate.src);

    const hints: string[] = [];
    if (filenameHasLogo || srcHasLogo) hints.push("filename=logo");
    if (sizeLabel === "tiny" || sizeLabel === "small") hints.push("icon-sized");
    if (sizeLabel === "hero") hints.push("hero-sized");
    if (aspectRatio >= 3 && width >= 80) hints.push("wordmark-shaped");
    if (hrefType === "external") hints.push("external-link");
    if (
      normalizedBrandName &&
      candidate.alt &&
      candidate.alt
        .toLowerCase()
        .replace(/\s+/g, "")
        .includes(normalizedBrandName)
    ) {
      hints.push("alt~=brand");
    }
    if (candidate.isSvg && candidate.logoSvgScore !== undefined) {
      hints.push(`svgScore:${Math.round(candidate.logoSvgScore)}`);
    }

    return {
      width,
      height,
      top,
      left,
      area,
      aspectRatio,
      sizeLabel,
      hrefType,
      hints,
    };
  };

  // Collect class patterns for framework detection
  const allClasses = new Set<string>();
  if (buttons && buttons.length > 0) {
    buttons.forEach(btn => {
      if (btn.classes) {
        btn.classes.split(/\s+/).forEach(cls => {
          if (cls.length > 0 && cls.length < 50) {
            allClasses.add(cls);
          }
        });
      }
    });
  }

  // Add framework detection hints
  if (allClasses.size > 0) {
    const classSample = Array.from(allClasses).slice(0, 50).join(", ");
    prompt += `\n## CSS Class Patterns (for framework detection):\n`;
    prompt += `Sample classes: ${classSample}\n`;

    // Add framework hints from meta/scripts
    if (
      (jsAnalysis as any).__framework_hints &&
      (jsAnalysis as any).__framework_hints.length > 0
    ) {
      const safeHints = ((jsAnalysis as any).__framework_hints as string[])
        .map((h: string) => sanitize(h, 60))
        .join(", ");
      prompt += `Framework hints from page: ${safeHints}\n`;
    }

    prompt += `\n**Framework Detection Patterns:**\n`;
    prompt += `- Tailwind: Look for utility classes like \`flex\`, \`items-center\`, \`px-*\`, \`py-*\`, \`bg-*-500\`, \`rounded-*\`, \`text-*\`, \`space-x-*\`, \`gap-*\`\n`;
    prompt += `- Bootstrap: Look for \`btn\`, \`btn-primary\`, \`container\`, \`row\`, \`col-*\`, \`d-flex\`, \`justify-*\`, \`mb-*\`, \`mt-*\`\n`;
    prompt += `- Material UI: Look for \`MuiButton\`, \`Mui*\`, \`makeStyles\`, or modern Material classes\n`;
    prompt += `- Chakra UI: Look for \`chakra-*\`, minimal utility-style classes, or data attributes\n`;
    prompt += `- Custom: Mixed or unique class patterns that don't match standard frameworks\n\n`;
  }

  // Add button context with detailed info
  if (buttons && buttons.length > 0) {
    prompt += `## Detected Buttons (${buttons.length} total):\n`;

    // First, show a color summary to help LLM see distinct options
    const colorSummary = new Map<string, number[]>();
    buttons.forEach((btn, idx) => {
      const bg = btn.background || "transparent";
      if (!colorSummary.has(bg)) {
        colorSummary.set(bg, []);
      }
      colorSummary.get(bg)!.push(idx);
    });

    prompt += `\n**COLOR GROUPS** (buttons sharing the same background color):\n`;
    colorSummary.forEach((indices, color) => {
      const count = indices.length;
      const colorInfo = getColorInfo(color);
      prompt += `- ${color} (${colorInfo.description}${colorInfo.isVibrant ? " - VIBRANT" : ""}) → Buttons ${indices.join(", ")} (${count} button${count > 1 ? "s" : ""})\n`;
    });
    prompt += `\n⚠️ **CRITICAL**: Primary and secondary MUST be from DIFFERENT color groups!\n\n`;

    prompt += `Analyze these buttons and identify which is the PRIMARY CTA and which is SECONDARY:\n\n`;

    buttons.forEach((btn, idx) => {
      const bgInfo = getColorInfo(btn.background);

      prompt += `**Button #${idx}:**\n`;
      prompt += `- Text: "${sanitize(btn.text, 80)}"\n`;
      prompt += `- Background Color: ${btn.background} (${bgInfo.description}${bgInfo.isVibrant ? " - VIBRANT/BRAND COLOR" : ""})\n`;
      prompt += `- Text Color: ${btn.textColor}\n`;
      if (btn.borderColor) prompt += `- Border Color: ${btn.borderColor}\n`;
      if (btn.borderRadius) prompt += `- Border Radius: ${btn.borderRadius}\n`;
      prompt += `- Classes: ${sanitize(btn.classes, 150)}\n`;
      prompt += `\n`;
    });
  }

  // Add logo candidates section (optimized - compact format)
  if (logoCandidates && logoCandidates.length > 0) {
    prompt += `\n## Logo Candidates (${logoCandidates.length}):\n`;
    if (
      heuristicLogoPick != null &&
      heuristicLogoPick.selectedIndexInFilteredList >= 0 &&
      heuristicLogoPick.selectedIndexInFilteredList < logoCandidates.length
    ) {
      prompt += `**Heuristic suggestion**: Our heuristic selected **Candidate #${heuristicLogoPick.selectedIndexInFilteredList}** (confidence: ${(heuristicLogoPick.confidence * 100).toFixed(0)}%). Reason: ${heuristicLogoPick.reasoning}\n\n`;
      prompt += `**Your task**: Confirm this choice OR pick a different index. If you pick a different logo, you MUST explain why the heuristic was wrong and why your choice is better.\n\n`;
    }
    if (input.screenshot) {
      prompt += `**IMPORTANT**: Look at the screenshot provided. The brand logo is almost always in the TOP/HEADER area of the page.\n`;
      prompt += `Find the logo in the header area of the screenshot, then match it to one of the candidates below.\n\n`;
    } else {
      prompt += `**IMPORTANT**: The brand logo is almost always in the TOP/HEADER area of the page.\n`;
      prompt += `Find the logo in the header area (usually the top of the page), then match it to one of the candidates below.\n\n`;
    }
    if (favicon) {
      const faviconPreview = sanitize(favicon, 100);
      prompt += `**Favicon**: The site's favicon is: ${faviconPreview}\n`;
      prompt += `The main logo is often the favicon image or favicon + wordmark. Prefer a candidate whose src matches or resembles the favicon (same domain/filename, or "Logo.svg"/wordmark in header with href=home). Do NOT pick a random header SVG that does not link to home and does not match the favicon/brand.\n\n`;
    }

    if (safeBrandName || hasPageContext) {
      if (hasPageContext) {
        prompt += `**Brand**: Infer from page title/URL above (e.g. "X | Miro" → brand Miro). The logo should match that brand.\n`;
      }
      if (safeBrandName) {
        prompt += `Heuristic brand hint: "${safeBrandName}" (from page meta/title — use only if it aligns with your inference from title/URL).\n\n`;
      } else if (hasPageContext) {
        prompt += `\n`;
      }
    }

    // Pass everything we get from the browser so the LLM can use all metadata (alt, aria-label, title, position, indicators, etc.)
    logoCandidates.forEach((candidate, idx) => {
      const indicators: string[] = [];
      if (candidate.indicators.inHeader) indicators.push("header");
      if (candidate.indicators.altMatch) indicators.push("alt=logo");
      if (candidate.indicators.srcMatch) indicators.push("url=logo");
      if (candidate.indicators.classMatch) indicators.push("class=logo");
      if (candidate.indicators.hrefMatch) indicators.push("href=home");

      const meta = getLogoCandidateMeta(candidate);
      const urlPreview =
        candidate.src.length > 80
          ? candidate.src.substring(0, 80) + "..."
          : candidate.src;

      const typeLabel = candidate.isSvg ? "SVG" : "IMG";
      const aspectLabel = meta.aspectRatio
        ? meta.aspectRatio.toFixed(1)
        : "n/a";
      const hintLabel = meta.hints.length > 0 ? meta.hints.join(", ") : "none";
      const sourceLabel = candidate.source ? `source:${candidate.source}` : "";
      const svgScoreLabel =
        candidate.logoSvgScore !== undefined
          ? `logoSvgScore:${Math.round(candidate.logoSvgScore)}`
          : "";

      const pos = candidate.position;
      const positionLabel =
        pos != null
          ? `top:${Math.round(pos.top ?? 0)} left:${Math.round(pos.left ?? 0)} width:${Math.round(pos.width ?? 0)} height:${Math.round(pos.height ?? 0)}`
          : "n/a";

      prompt += `\n**Logo Candidate #${idx}**\n`;
      prompt += `  Metadata: alt:"${sanitize(candidate.alt, 100)}" | ariaLabel:"${sanitize(candidate.ariaLabel, 100)}" | title:"${sanitize(candidate.title, 100)}" | source:${candidate.source ?? "n/a"} | location:${candidate.location} | isVisible:${candidate.isVisible} | position:${positionLabel} | indicators:${JSON.stringify(candidate.indicators)}${svgScoreLabel ? ` | ${svgScoreLabel}` : ""}\n`;
      prompt += `  Size: ${meta.width}x${meta.height} (${meta.sizeLabel}, area:${meta.area}, aspect:${aspectLabel}) | href:${meta.hrefType}${candidate.href ? ` | hrefUrl:${candidate.href.length > 60 ? candidate.href.substring(0, 60) + "..." : candidate.href}` : ""} | hints:[${hintLabel}]\n`;
      prompt += `  Source URL: ${urlPreview}\n`;
    });

    prompt += `\n**Candidate Hints (how to use them):**\n`;
    prompt += `- alt, ariaLabel, title = text from the image/link (often the brand or "X logo"); use these to match the brand name\n`;
    prompt += `- size labels: tiny/small are usually UI icons; hero-sized are usually hero images/banners\n`;
    prompt += `- wordmark-shaped is OK if it is in header and links to homepage\n`;
    prompt += `- **href=home (or "/" or "#") in header is a strong brand signal** — the main logo almost always links to home; avoid picking header candidates that link to product/docs/other pages unless they clearly match the favicon or "Logo" in src\n`;
    prompt += `- href:external is usually NOT the brand logo\n`;
    prompt += `- source: document.images = main page images (often the primary brand logo)\n`;
    prompt += `- If a favicon was provided above, prefer candidates whose src matches or resembles it (same domain, or Logo.svg/wordmark)\n`;
    prompt += `- logoSvgScore/svgScore: higher = more logo-like (SVG or image)\n\n`;

    prompt += `\n**LOGO SELECTION - CRITICAL RULES (follow in order):**\n`;
    prompt += `1. **NEVER pick invisible or tiny UI icons:** If a candidate has isVisible:false, do NOT pick it unless it is the ONLY header candidate. Prefer isVisible:true.\n`;
    prompt += `2. **Prefer href=home in header:** The main brand logo almost always links to home ("/", "#", or homepage URL). Do NOT pick a header candidate that links to a product/docs/other page if another candidate has href=home or matches the favicon/Logo.svg.\n`;
    prompt += `3. **NEVER pick "tiny" or "small" when a proper logo exists:** If any candidate has size "medium" or "large" and is in header with href=home (or matches favicon), do NOT pick a "tiny" or "small" candidate (those are usually menu/hamburger/icons).\n`;
    prompt += `4. **REJECT by alt text:** Do NOT pick candidates whose alt/ariaLabel contains: "menu", "hamburger", "toggle", "mobile menu", "menu open", "menu close", "close-mobile". Those are UI icons, not the brand logo.\n`;
    prompt += `5. **Prefer the main visible logo:** When multiple candidates share the same href (e.g. homepage), pick the one with LARGER width×height and isVisible:true — that is the primary logo; the smaller/hidden one is often a collapsed-nav variant.\n`;
    prompt += `6. **Prefer favicon match or clear Logo:** If favicon was provided, prefer a candidate whose src matches or resembles it, or a clear "Logo.svg"/wordmark in header with href=home. Prefer alt matching brand (e.g. "X Home") over generic or empty alt.\n\n`;
    prompt += `**LOGO SELECTION - SIMPLE APPROACH:**\n`;
    if (input.screenshot) {
      prompt += `Look at the screenshot and select the MOST PROMINENT primary brand logo (the one users actually see in the header).\n\n`;
    } else {
      prompt += `Select the MOST PROMINENT primary brand logo (largest visible header logo that represents the brand).\n\n`;
    }
    prompt += `**Simple Rules:**\n`;
    prompt += `1. **Look at the TOP of the page** - The main logo is almost always in the header/navbar at the very top\n`;
    prompt += `2. **Primary logo** - Choose the largest, most visible logo that represents "${safeBrandName || "the website's brand"}" (prefer medium/large size, isVisible:true)\n`;
    prompt += `3. **Prefer header logos** - Logos in the header/navbar area are the brand logo (highest priority)\n`;
    prompt += `4. **Ignore partner/client logos** - Skip smaller logos in "customers", "partners", or footer sections\n`;
    if (input.screenshot) {
      prompt += `5. **Use the screenshot** - Visually identify which logo is THE main brand logo users see first (not a tiny icon or hidden variant)\n\n`;
    } else {
      prompt += `5. **Use position + size + isVisible** - Prefer header, larger dimensions, and isVisible:true; reject tiny or invisible candidates\n\n`;
    }
    prompt += `**What to avoid:**\n`;
    prompt += `- Tiny or small icons (menu, hamburger, close, toggle) — check alt text and size\n`;
    prompt += `- Candidates with isVisible:false when a visible header logo exists\n`;
    prompt += `- Customer/client logos (usually smaller, in groups, different brand names)\n`;
    prompt += `- Social media icons\n`;
    prompt += `- Footer logos (unless no header logo exists)\n\n`;
    prompt += `Just pick the obvious main brand logo at the top of the page that users see first (visible, medium/large, alt like brand name or "X Home").\n\n`;
  }

  // Add background color candidates section
  if (backgroundCandidates && backgroundCandidates.length > 0) {
    prompt += `\n## Background Color Candidates (${backgroundCandidates.length}):\n`;
    if (input.screenshot) {
      prompt += `Multiple background colors were detected. Use the screenshot to identify which is the actual page background:\n\n`;
    } else {
      prompt += `Multiple background colors were detected. Identify which is the actual page background:\n\n`;
    }

    backgroundCandidates.forEach((candidate, idx) => {
      const areaInfo = candidate.area
        ? ` | area: ${Math.round(candidate.area)}px²`
        : "";
      prompt += `#${idx}: ${candidate.color} | source: ${candidate.source} | priority: ${candidate.priority}${areaInfo}\n`;
    });

    prompt += `\n**Selection Rules:** `;
    if (input.screenshot) {
      prompt += `Use the screenshot to visually identify the main page background. Consider:\n`;
      prompt += `- Color scheme (dark mode should have dark background, light mode should have light background)\n`;
      prompt += `- Most visible/largest area in the screenshot\n`;
    } else {
      prompt += `Identify the main page background based on priority and source. Consider:\n`;
      prompt += `- Color scheme (dark mode should have dark background, light mode should have light background)\n`;
      prompt += `- Highest priority sources (body/html > CSS vars > containers)\n`;
      prompt += `- Largest area coverage\n`;
    }
    prompt += `- Higher priority sources (body/html > CSS vars > containers)\n`;
    prompt += `- Return the hex color in the colorRoles.backgroundColor field\n\n`;
  }

  // Add specific questions
  prompt += `\n## Your Task:\n`;

  if (buttons && buttons.length > 0) {
    prompt += `1. **PRIMARY Button**: Identify which button (by index 0-${buttons.length - 1}) is the main call-to-action.\n`;
    prompt += `   - **CRITICAL**: Buttons with VIBRANT/BRAND COLOR backgrounds (like green, blue, orange) are ALMOST ALWAYS the primary CTA\n`;
    prompt += `   - **STRONG INDICATORS**: Look for these class patterns (very high priority):\n`;
    prompt += `     * \`bg-brand-400\`, \`bg-brand-500\`, or similar brand utility classes\n`;
    prompt += `     * \`bg-green-*\`, \`bg-blue-*\`, \`bg-purple-*\` with high numbers (400+)\n`;
    prompt += `     * Any class containing "brand", "primary", or "cta"\n`;
    prompt += `   - Look for: Bright, saturated colors (green, blue, purple, orange) + action-oriented text\n`;
    prompt += `   - Action-oriented text examples: "Get Started", "Sign Up", "Start Free", "Start your Project", "Try Now", "Get Started Free"\n`;
    prompt += `   - If a button has BOTH vibrant color AND strong CTA text, it's DEFINITELY the primary\n`;
    prompt += `   - Avoid buttons with transparent, white, or muted gray backgrounds UNLESS no vibrant buttons exist\n`;
    prompt += `   - Return the button INDEX (not text) and explain your reasoning\n\n`;

    prompt += `2. **SECONDARY Button**: Identify which button is secondary (outline, ghost, or less prominent).\n`;
    prompt += `   - **CRITICAL**: MUST have a DIFFERENT background color than the primary button you selected\n`;
    prompt += `   - **EXAMPLES OF VALID COMBINATIONS**:\n`;
    prompt += `     * Primary: #00C853 (green, vibrant) → Secondary: transparent (outline style) ✓\n`;
    prompt += `     * Primary: #1976D2 (blue, vibrant) → Secondary: #FFFFFF (white/light) ✓\n`;
    prompt += `     * Primary: #FF6B35 (orange, vibrant) → Secondary: #F5F5F5 (gray/subtle) ✓\n`;
    prompt += `   - **INVALID COMBINATION**:\n`;
    prompt += `     * Primary: #00C853 → Secondary: #00C853 ✗ SAME COLOR - NOT ALLOWED!\n`;
    prompt += `   - Usually has transparent/subtle background, border, or muted colors\n`;
    prompt += `   - Common for actions like "Login", "Learn More", "Contact", "Documentation"\n`;
    prompt += `   - Often has an outline/border instead of filled background\n`;
    prompt += `   - Look at the COLOR GROUPS above - pick from a DIFFERENT group than primary\n`;
    prompt += `   - If all remaining buttons have the same color as primary, set secondaryButtonIndex to -1\n`;
    prompt += `   - Return the button INDEX and reasoning\n\n`;
  }

  prompt += `${buttons && buttons.length > 0 ? "3" : "1"}. **Color Roles**: Based on ${buttons && buttons.length > 0 ? "button colors and " : ""}page context:\n`;
  prompt += `   - PRIMARY brand color (usually logo/heading color)\n`;
  prompt += `   - ACCENT color (${buttons && buttons.length > 0 ? "usually the vibrant CTA button background - green, blue, etc." : "vibrant accent color from the page"})\n`;
  prompt += `   - Background and text colors\n`;
  prompt += `   - If unsure about any color, return an empty string "" for that field (NOT null)\n\n`;

  prompt += `${buttons && buttons.length > 0 ? "4" : "2"}. **Brand Personality**: Overall tone, energy, and target audience\n`;
  prompt += `   - If unsure about target audience, return "unknown"\n\n`;

  prompt += `${buttons && buttons.length > 0 ? "5" : "3"}. **Design System**: Based on the class patterns shown above:\n`;
  prompt += `   - **Framework**: Identify the CSS framework (tailwind/bootstrap/material/chakra/custom/unknown)\n`;
  prompt += `   - **Component Library**: Look for prefixes like \`radix-\`, \`shadcn-\`, \`headlessui-\`, or \`react-aria-\` in classes\n`;
  prompt += `   - If using Tailwind + a component library, identify both (e.g., framework: tailwind, componentLibrary: "radix-ui")\n`;
  prompt += `   - If no component library is detected, return an empty string ""\n\n`;

  prompt += `${buttons && buttons.length > 0 ? "6" : "4"}. **Clean Fonts**: Return up to 5 cleaned, human-readable font names\n`;
  prompt += `   - Remove framework obfuscation (Next.js hashes, etc.)\n`;
  prompt += `   - Filter out generics and CSS variables\n`;
  prompt += `   - Prioritize by frequency (shown in usage count)\n`;
  prompt += `   - Assign appropriate roles (heading, body, monospace, display) or "unknown"\n\n`;

  if (logoCandidates && logoCandidates.length > 0) {
    const logoTaskNumber = buttons && buttons.length > 0 ? "7" : "5";
    prompt += `${logoTaskNumber}. **Logo Selection**: Identify the best brand logo from the ${logoCandidates.length} candidates provided above.\n`;
    if (
      heuristicLogoPick != null &&
      heuristicLogoPick.selectedIndexInFilteredList >= 0
    ) {
      prompt += `   - **Heuristic suggested #${heuristicLogoPick.selectedIndexInFilteredList}.** Confirm it (return the same index with reasoning) OR pick a different index; if you pick differently, explain why the heuristic was wrong and why your choice is better.\n`;
    }
    prompt += `   - **YOU MUST RETURN**: selectedLogoIndex (number), selectedLogoReasoning (string), and confidence (0-1)\n`;
    prompt += `   - **CRITICAL**: NEVER pick a tiny/invisible/UI icon. Prefer the MAIN visible header logo (medium/large size, isVisible:true, alt like "${safeBrandName || "Brand"} Home").\n`;
    prompt += `   - **IT'S OK TO RETURN -1**: If no candidate is a good brand logo, return -1 with low confidence\n`;
    prompt += `   - **DECISION PROCESS**:\n`;
    if (input.screenshot) {
      prompt += `     1. Look at the screenshot - find the MAIN logo in the HEADER (the one users see, not a tiny icon)\n`;
      prompt += `     2. Match that visual to a candidate; prefer isVisible:true and larger size\n`;
    } else {
      prompt += `     1. Filter by isVisible:true and size (prefer medium/large over tiny/small)\n`;
      prompt += `     2. Prefer candidates with alt matching brand (e.g. "${safeBrandName || "Brand"} Home"), href=home, in header\n`;
    }
    prompt += `     3. Reject any candidate with alt containing "menu", "hamburger", "toggle", "mobile menu", "close"\n`;
    prompt += `     4. If multiple candidates share the same href, pick the LARGER one (primary logo), not the smaller/hidden variant\n`;
    prompt += `     5. If you're unsure or only tiny/invisible candidates remain, return -1\n`;
    prompt += `   - **STRONG INDICATORS** (prioritize candidates with these):\n`;
    prompt += `     * isVisible:true AND size medium/large (not tiny) → The main logo users see\n`;
    prompt += `     * "href:/" or "hrefMatch" → Logo links to homepage (VERY STRONG)\n`;
    prompt += `     * "header" + alt like "${safeBrandName || "brand name"} Home" → Primary brand logo\n`;
    prompt += `     * Larger width×height when same href as other candidates → Primary; smaller = collapsed/mini variant\n`;
    prompt += `   - **AVOID** (do NOT pick these; return -1 if only these remain):\n`;
    prompt += `     * isVisible:false when another candidate has isVisible:true\n`;
    prompt += `     * Size "tiny" or "small" when a "medium"/"large" header logo exists\n`;
    prompt += `     * Alt/ariaLabel containing: menu, hamburger, toggle, "mobile menu", "menu open", "menu close"\n`;
    prompt += `     * Very large images (og:image, hero, banners)\n`;
    prompt += `     * UI icons (search, hamburger, cart, user, settings)\n`;
    prompt += `     * Customer/client/footer logos\n`;
    prompt += `   - **RETURN FORMAT**:\n`;
    prompt += `     * selectedLogoIndex: The INDEX (0-${logoCandidates.length - 1}) of the best logo, or -1 if none are good\n`;
    prompt += `     * selectedLogoReasoning: "Selected #X because [isVisible, medium/large, header, href=home, alt=brand]." OR "No valid brand logo - only tiny/invisible/UI icons."\n`;
    prompt += `     * confidence: 0.8-1.0 if sure, 0.5-0.7 if uncertain, 0.0-0.4 if no good match or returning -1\n`;
    prompt += `   - **PREFER -1 OVER BAD LOGOS**: Better to return no logo than a menu/hamburger icon or tiny hidden variant.\n\n`;
  }

  if (buttons && buttons.length > 0) {
    prompt += `## VALIDATION CHECKLIST - VERIFY BEFORE RESPONDING:\n`;
    prompt += `Before finalizing your answer, check:\n`;
    prompt += `1. ✓ Are primaryButtonIndex and secondaryButtonIndex DIFFERENT numbers?\n`;
    prompt += `2. ✓ Do they have DIFFERENT background colors? (Compare the actual hex/color values)\n`;
    prompt += `3. ✓ If you selected buttons from the same COLOR GROUP, go back and pick a different secondary\n`;
    prompt += `4. ✓ If no valid secondary exists (all buttons same color as primary), set secondaryButtonIndex to -1\n\n`;

    prompt += `## FINAL RULES:\n`;
    prompt += `- Primary and secondary buttons MUST have different background colors (not just different shades - completely different colors)\n`;
    prompt += `- Primary and secondary buttons MUST be different buttons (different indices)\n`;
    prompt += `- Refer to the COLOR GROUPS section above to ensure you're picking from different groups\n`;
    prompt += `- Be decisive and confident. Prioritize vibrant, saturated colors over neutral ones for primary buttons\n`;
    prompt += `- If no clear primary/secondary exists with different colors, return -1 for that index\n`;
  }

  // CRITICAL: Ensure LLM returns all required fields
  prompt += `\n## ⚠️ CRITICAL: YOU MUST RETURN ALL REQUIRED FIELDS\n`;
  prompt += `The response schema REQUIRES these fields. DO NOT return empty objects {}.\n`;
  prompt += `\n**REQUIRED FIELDS:**\n`;
  let fieldNumber = 1;
  if (buttons && buttons.length > 0) {
    prompt += `${fieldNumber}. buttonClassification: { primaryButtonIndex, primaryButtonReasoning, secondaryButtonIndex, secondaryButtonReasoning, confidence }\n`;
    fieldNumber++;
  }
  prompt += `${fieldNumber}. colorRoles: { primaryColor, accentColor, backgroundColor, textPrimary, confidence }\n`;
  fieldNumber++;
  prompt += `${fieldNumber}. cleanedFonts: [] (array, can be empty but must be present)\n`;
  if (hasLogoCandidates) {
    fieldNumber++;
    prompt += `${fieldNumber}. logoSelection: { selectedLogoIndex, selectedLogoReasoning, confidence }\n`;
  } else {
    prompt += `(No logoSelection required — there are no logo candidates.)\n`;
  }
  prompt += `\n**DO NOT** return empty objects {}. Fill in ALL fields with actual values or -1/null as appropriate.\n`;

  return prompt;
}
