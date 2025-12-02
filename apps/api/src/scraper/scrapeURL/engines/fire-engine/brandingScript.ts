export const getBrandingScript = () => String.raw`
(function __extractBrandDesign() {
  const toPx = v => {
    if (!v || v === "auto") return null;
    if (v.endsWith("px")) return parseFloat(v);
    if (v.endsWith("rem"))
      return (
        parseFloat(v) *
        parseFloat(getComputedStyle(document.documentElement).fontSize || 16)
      );
    if (v.endsWith("em"))
      return (
        parseFloat(v) *
        parseFloat(getComputedStyle(document.body).fontSize || 16)
      );
    if (v.endsWith("%")) return null;
    const num = parseFloat(v);
    return Number.isFinite(num) ? num : null;
  };

  const resolveSvgStyles = svg => {
    const originalElements = [svg, ...svg.querySelectorAll("*")];
    const computedStyles = originalElements.map(el => ({
      el,
      computed: getComputedStyle(el),
    }));

    const clone = svg.cloneNode(true);
    const clonedElements = [clone, ...clone.querySelectorAll("*")];

    const svgDefaults = {
      fill: "rgb(0, 0, 0)",
      stroke: "none",
      "stroke-width": "1px",
      opacity: "1",
      "fill-opacity": "1",
      "stroke-opacity": "1",
    };

    const applyResolvedStyle = (clonedEl, originalEl, computed, prop) => {
      const attrValue = originalEl.getAttribute(prop);
      const value = computed.getPropertyValue(prop);

      if (attrValue && attrValue.includes("var(")) {
        clonedEl.removeAttribute(prop);
        if (value && value.trim() && value !== "none") {
          clonedEl.style.setProperty(prop, value, "important");
        }
      } else if (value && value.trim()) {
        const isExplicit =
          originalEl.hasAttribute(prop) || originalEl.style[prop];
        const isDifferent =
          svgDefaults[prop] !== undefined && value !== svgDefaults[prop];
        if (isExplicit || isDifferent) {
          clonedEl.style.setProperty(prop, value, "important");
        }
      }
    };

    for (let i = 0; i < clonedElements.length; i++) {
      const clonedEl = clonedElements[i];
      const originalEl = originalElements[i];
      const computed = computedStyles[i]?.computed;
      if (!computed) continue;

      const allProps = [
        "fill",
        "stroke",
        "color",
        "stop-color",
        "flood-color",
        "lighting-color",
        "stroke-width",
        "stroke-dasharray",
        "stroke-dashoffset",
        "stroke-linecap",
        "stroke-linejoin",
        "opacity",
        "fill-opacity",
        "stroke-opacity",
      ];

      for (const prop of allProps) {
        applyResolvedStyle(clonedEl, originalEl, computed, prop);
      }
    }

    return clone;
  };

  const collectCSSData = () => {
    const data = {
      colors: [],
      spacings: [],
      radii: [],
    };

    for (const sheet of Array.from(document.styleSheets)) {
      let rules;
      try {
        rules = sheet.cssRules;
      } catch (e) {
        continue;
      }
      if (!rules) continue;

      for (const rule of Array.from(rules)) {
        try {
          if (rule.type === CSSRule.STYLE_RULE) {
            const s = rule.style;

            [
              "color",
              "background-color",
              "border-color",
              "fill",
              "stroke",
            ].forEach(prop => {
              const val = s.getPropertyValue(prop);
              if (val) data.colors.push(val);
            });

            [
              "border-radius",
              "border-top-left-radius",
              "border-top-right-radius",
              "border-bottom-left-radius",
              "border-bottom-right-radius",
            ].forEach(p => {
              const v = toPx(s.getPropertyValue(p));
              if (v) data.radii.push(v);
            });

            [
              "margin",
              "margin-top",
              "margin-right",
              "margin-bottom",
              "margin-left",
              "padding",
              "padding-top",
              "padding-right",
              "padding-bottom",
              "padding-left",
              "gap",
              "row-gap",
              "column-gap",
            ].forEach(p => {
              const v = toPx(s.getPropertyValue(p));
              if (v) data.spacings.push(v);
            });
          }
        } catch {}
      }
    }

    return data;
  };

  // Helper to check if an element looks like a button (has button-like styling)
  const looksLikeButton = (el) => {
    if (!el || typeof el.matches !== 'function') return false;
    
    // Check explicit button indicators
    if (el.matches('button, [role=button], [data-primary-button], [data-secondary-button], [data-cta], a.button, a.btn, [class*="btn"], [class*="button"], a[class*="bg-brand"], a[class*="bg-primary"], a[class*="bg-accent"], a[type="button"]')) {
      return true;
    }
    
    // For links, check if they have button-like styling
    if (el.tagName.toLowerCase() === 'a') {
      try {
        const classes = (el.className || '').toLowerCase();
        const classStr = classes;
        
        // Check for common button class patterns (Tailwind, Bootstrap, etc.)
        const hasButtonClasses = 
          /rounded(-md|-lg|-xl|-full)?/.test(classStr) || // rounded corners
          /px-\d+/.test(classStr) || // horizontal padding (px-2, px-4, etc.)
          /py-\d+/.test(classStr) || // vertical padding (py-2, py-4, etc.)
          /p-\d+/.test(classStr) || // padding (p-2, p-4, etc.)
          (/border/.test(classStr) && /rounded/.test(classStr)) || // border + rounded
          (/inline-flex/.test(classStr) && /items-center/.test(classStr) && /justify-center/.test(classStr)); // flexbox button pattern
        
        if (hasButtonClasses) {
          const cs = getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          
          // Verify it has reasonable button dimensions
          if (rect.width > 50 && rect.height > 25) {
            return true;
          }
        }
        
        // Also check computed styles for button-like appearance
        const cs = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        
        // Check for button-like padding and dimensions
        const paddingTop = parseFloat(cs.paddingTop) || 0;
        const paddingBottom = parseFloat(cs.paddingBottom) || 0;
        const paddingLeft = parseFloat(cs.paddingLeft) || 0;
        const paddingRight = parseFloat(cs.paddingRight) || 0;
        const hasPadding = paddingTop > 3 || paddingBottom > 3 || paddingLeft > 6 || paddingRight > 6;
        const hasMinSize = rect.width > 50 && rect.height > 25;
        const hasRounded = parseFloat(cs.borderRadius) > 0;
        const hasBorder = parseFloat(cs.borderTopWidth) > 0 || parseFloat(cs.borderBottomWidth) > 0 ||
                         parseFloat(cs.borderLeftWidth) > 0 || parseFloat(cs.borderRightWidth) > 0;
        
        // Button-like if has padding + (rounded or border) and reasonable size
        if (hasPadding && hasMinSize && (hasRounded || hasBorder)) {
          return true;
        }
      } catch (e) {
        // If we can't check styles, fall back to class matching
      }
    }
    
    return false;
  };

  const sampleElements = () => {
    const picks = [];
    const pushQ = (q, limit = 10) => {
      for (const el of Array.from(document.querySelectorAll(q)).slice(0, limit))
        picks.push(el);
    };

    pushQ('header img, .site-logo img, img[alt*=logo i], img[src*="logo"]', 5);
    
    // First, get explicit buttons
    pushQ(
      'button, [role=button], [data-primary-button], [data-secondary-button], [data-cta], a.button, a.btn, [class*="btn"], [class*="button"], a[class*="bg-brand"], a[class*="bg-primary"], a[class*="bg-accent"], a[type="button"], a[type="button"][class*="bg-"]',
      100,
    );
    
    // Also check all links for button-like styling
    const allLinks = Array.from(document.querySelectorAll('a'));
    for (const link of allLinks.slice(0, 100)) {
      if (looksLikeButton(link)) {
        picks.push(link);
      }
    }
    
    pushQ('input, select, textarea, [class*="form-control"]', 25);
    pushQ("h1, h2, h3, p, a", 50);

    return Array.from(new Set(picks.filter(Boolean)));
  };

  const getStyleSnapshot = el => {
    const cs = getComputedStyle(el);
    const rect = el.getBoundingClientRect();

    const fontStack =
      cs
        .getPropertyValue("font-family")
        ?.split(",")
        .map(f => f.replace(/["']/g, "").trim())
        .filter(Boolean) || [];

    let classNames = "";
    try {
      if (el.getAttribute) {
        const attrClass = el.getAttribute("class");
        if (attrClass) classNames = attrClass.toLowerCase();
      }
      if (!classNames && el.className) {
        if (typeof el.className === "string") {
          classNames = el.className.toLowerCase();
        } else if (el.className.baseVal) {
          classNames = el.className.baseVal.toLowerCase();
        }
      }
    } catch (e) {
      try {
        if (el.className && typeof el.className === "string") {
          classNames = el.className.toLowerCase();
        }
      } catch (e2) {
        classNames = "";
      }
    }

    // Get colors as-is from computed style
    let bgColor = cs.getPropertyValue("background-color");
    const textColor = cs.getPropertyValue("color");
    
    // For transparent backgrounds, try to get the background from parent container
    const isTransparent = bgColor === "transparent" || bgColor === "rgba(0, 0, 0, 0)";
    const alphaMatch = bgColor.match(/rgba?\([^,]*,[^,]*,[^,]*,\s*([\d.]+)\)/);
    const hasZeroAlpha = alphaMatch && parseFloat(alphaMatch[1]) === 0;
    
    if (isTransparent || hasZeroAlpha) {
      // Walk up the DOM to find a non-transparent background
      let parent = el.parentElement;
      let depth = 0;
      while (parent && depth < 5) {
        const parentBg = getComputedStyle(parent).getPropertyValue("background-color");
        if (parentBg && parentBg !== "transparent" && parentBg !== "rgba(0, 0, 0, 0)") {
          const parentAlphaMatch = parentBg.match(/rgba?\([^,]*,[^,]*,[^,]*,\s*([\d.]+)\)/);
          const parentAlpha = parentAlphaMatch ? parseFloat(parentAlphaMatch[1]) : 1;
          if (parentAlpha > 0.1) {
            bgColor = parentBg;
            break;
          }
        }
        parent = parent.parentElement;
        depth++;
      }
    }

    // Check if element is a button - use same logic as sampleElements
    let isButton = false;
    if (el.matches('button,[role=button],[data-primary-button],[data-secondary-button],[data-cta],a.button,a.btn,[class*="btn"],[class*="button"],a[class*="bg-brand"],a[class*="bg-primary"],a[class*="bg-accent"],a[type="button"],a[type="button"][class*="bg-"]')) {
      isButton = true;
    } else if (el.tagName.toLowerCase() === 'a') {
      // Check if link looks like a button (has button-like styling)
      try {
        const classes = classNames;
        
        // Check for common button class patterns (Tailwind, Bootstrap, etc.)
        const hasButtonClasses = 
          /rounded(-md|-lg|-xl|-full)?/.test(classes) || // rounded corners
          /px-\d+/.test(classes) || // horizontal padding (px-2, px-4, etc.)
          /py-\d+/.test(classes) || // vertical padding (py-2, py-4, etc.)
          /p-\d+/.test(classes) || // padding (p-2, p-4, etc.)
          (/border/.test(classes) && /rounded/.test(classes)) || // border + rounded
          (/inline-flex/.test(classes) && /items-center/.test(classes) && /justify-center/.test(classes)); // flexbox button pattern
        
        if (hasButtonClasses && rect.width > 50 && rect.height > 25) {
          isButton = true;
        } else {
          // Also check computed styles for button-like appearance
          const paddingTop = parseFloat(cs.paddingTop) || 0;
          const paddingBottom = parseFloat(cs.paddingBottom) || 0;
          const paddingLeft = parseFloat(cs.paddingLeft) || 0;
          const paddingRight = parseFloat(cs.paddingRight) || 0;
          const hasPadding = paddingTop > 3 || paddingBottom > 3 || paddingLeft > 6 || paddingRight > 6;
          const hasMinSize = rect.width > 50 && rect.height > 25;
          const hasRounded = parseFloat(cs.borderRadius) > 0;
          const hasBorder = parseFloat(cs.borderTopWidth) > 0 || parseFloat(cs.borderBottomWidth) > 0 ||
                           parseFloat(cs.borderLeftWidth) > 0 || parseFloat(cs.borderRightWidth) > 0;
          
          // Button-like if has padding + (rounded or border) and reasonable size
          if (hasPadding && hasMinSize && (hasRounded || hasBorder)) {
            isButton = true;
          }
        }
      } catch (e) {
        // If we can't check styles, not a button
      }
    }

    let isNavigation = false;
    let hasCTAIndicator = false;

    try {
      hasCTAIndicator =
        el.matches(
          '[data-primary-button],[data-secondary-button],[data-cta],[class*="cta"],[class*="hero"]',
        ) ||
        el.getAttribute("data-primary-button") === "true" ||
        el.getAttribute("data-secondary-button") === "true";

      if (!hasCTAIndicator) {
        // Check for navigation-related classes and attributes
        const hasNavClass = classNames.includes("nav-") ||
          classNames.includes("-nav") ||
          classNames.includes("nav-anchor") ||
          classNames.includes("nav-link") ||
          classNames.includes("sidebar-") ||
          classNames.includes("-sidebar") ||
          classNames.includes("menu-") ||
          classNames.includes("-menu") ||
          classNames.includes("toggle") ||
          classNames.includes("trigger");
        
        // Check for navigation-related roles and attributes
        const hasNavRole = el.matches(
          '[role="tab"],[role="menuitem"],[role="menuitemcheckbox"],[aria-haspopup],[aria-expanded]',
        );
        
        // Check if in navigation contexts (sidebar, nav, menu, etc.)
        const inNavContext = !!el.closest(
          'nav, [role="navigation"], [role="menu"], [role="menubar"], [class*="navigation"], [class*="dropdown"], [class*="sidebar"], [id*="sidebar"], [id*="navigation"], [id*="nav-"], aside[class*="nav"], aside[id*="nav"]',
        );
        
        // Check if it's a link in a list item (common nav pattern)
        let isNavLink = false;
        if (el.tagName.toLowerCase() === "a" && el.parentElement) {
          if (el.parentElement.tagName.toLowerCase() === "li") {
            const listEl = el.closest("ul, ol");
            if (listEl && listEl.closest('[class*="nav"], [id*="nav"], [class*="sidebar"], [id*="sidebar"]')) {
              isNavLink = true;
            }
          }
        }
        
        isNavigation = hasNavClass || hasNavRole || inNavContext || isNavLink;
      }
    } catch (e) {}

    return {
      tag: el.tagName.toLowerCase(),
      classes: classNames,
      text: (el.textContent && el.textContent.trim().substring(0, 100)) || "",
      rect: { w: rect.width, h: rect.height },
      colors: {
        text: textColor,
        background: bgColor,
        border: cs.getPropertyValue("border-top-color"),
        borderWidth: toPx(cs.getPropertyValue("border-top-width")),
      },
      typography: {
        fontStack,
        size: cs.getPropertyValue("font-size") || null,
        weight: parseInt(cs.getPropertyValue("font-weight"), 10) || null,
      },
      radius: toPx(cs.getPropertyValue("border-radius")),
      shadow: cs.getPropertyValue("box-shadow") || null,
      isButton: isButton && !isNavigation,
      isNavigation: isNavigation,
      hasCTAIndicator: hasCTAIndicator,
      isInput: el.matches('input,select,textarea,[class*="form-control"]'),
      isLink: el.matches("a"),
    };
  };

  const findImages = () => {
    const imgs = [];
    const logoCandidates = [];
    const push = (src, type) => {
      if (src) imgs.push({ type, src });
    };

    push(document.querySelector('link[rel*="icon" i]')?.href, "favicon");
    push(document.querySelector('meta[property="og:image" i]')?.content, "og");
    push(
      document.querySelector('meta[name="twitter:image" i]')?.content,
      "twitter",
    );

    // Helper to collect logo candidate metadata
    const collectLogoCandidate = (el, source) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      const isVisible = (
        rect.width > 0 &&
        rect.height > 0 &&
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        style.opacity !== "0"
      );

      const inHeader = el.closest('header, nav, [role="banner"], #navbar, [id*="navbar"], [class*="navbar"], [class*="header"]');
      
      // Check if logo is inside an anchor tag and get its href
      const anchorParent = el.closest('a');
      const href = anchorParent ? (anchorParent.getAttribute('href') || '') : '';
      
      const isSvg = el.tagName.toLowerCase() === "svg";
      
      // For SVGs, check different properties
      let alt = "";
      let srcMatch = false;
      let altMatch = false;
      let classMatch = false;
      let hrefMatch = false;
      
      if (isSvg) {
        // SVGs don't have alt/src, check id, className, aria-label, and title
        const svgId = el.id || "";
        const svgClass = el.className?.baseVal || el.className || "";
        const svgAriaLabel = el.getAttribute("aria-label") || "";
        const svgTitle = el.querySelector("title")?.textContent || "";
        const svgText = el.textContent?.trim() || "";
        
        alt = svgAriaLabel || svgTitle || svgText || svgId || "";
        altMatch = /logo/i.test(svgId) || /logo/i.test(svgAriaLabel) || /logo/i.test(svgTitle);
        classMatch = /logo/i.test(svgClass);
        // For SVGs, we'll check if it's in a logo container
        srcMatch = el.closest('[class*="logo"], [id*="logo"]') !== null;
      } else {
        // For images
        alt = el.alt || "";
        srcMatch = el.src ? /logo/i.test(el.src) : false;
        altMatch = /logo/i.test(alt);
        const imgClass = el.className || "";
        classMatch = /logo/i.test(imgClass);
      }
      
      let src = "";
      
      if (isSvg) {
        try {
          const resolvedSvg = resolveSvgStyles(el);
          const serializer = new XMLSerializer();
          src = "data:image/svg+xml;utf8," + encodeURIComponent(serializer.serializeToString(resolvedSvg));
        } catch (e) {
          // If serialization fails, try to serialize the original SVG
          try {
            const serializer = new XMLSerializer();
            src = "data:image/svg+xml;utf8," + encodeURIComponent(serializer.serializeToString(el));
          } catch (e2) {
            // If that also fails, skip this candidate
            return;
          }
        }
      } else {
        src = el.src || "";
      }

      // Check if href indicates homepage/root (common logo pattern)
      if (href) {
        const normalizedHref = href.toLowerCase().trim();
        // Logos typically link to homepage: "/", "/home", "/index", or just "#" or empty
        hrefMatch = normalizedHref === '/' || 
                   normalizedHref === '/home' || 
                   normalizedHref === '/index' || 
                   normalizedHref === '' ||
                   normalizedHref === '#';
      }

      if (src) {
        logoCandidates.push({
          src,
          alt,
          isSvg,
          isVisible,
          location: inHeader ? "header" : "body",
          position: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
          indicators: {
            inHeader: !!inHeader,
            altMatch,
            srcMatch,
            classMatch,
            hrefMatch,
          },
          href: href || undefined,
          source,
        });
      }
    };

    // Collect all potential logo candidates (including hidden ones for LLM to decide)
    // More comprehensive selectors - include SVGs directly in header/nav, not just in anchors
    // Also check for elements with class="header" (not just <header> tag)
    const allLogoSelectors = [
      'header a img, header a svg, header img, header svg',
      '[class*="header"] a img, [class*="header"] a svg, [class*="header"] img, [class*="header"] svg',
      'nav a img, nav a svg, nav img, nav svg',
      '[role="banner"] a img, [role="banner"] a svg, [role="banner"] img, [role="banner"] svg',
      '#navbar a img, #navbar a svg, #navbar img, #navbar svg',
      '[id*="navbar"] a img, [id*="navbar"] a svg, [id*="navbar"] img, [id*="navbar"] svg',
      '[class*="navbar"] a img, [class*="navbar"] a svg, [class*="navbar"] img, [class*="navbar"] svg',
      'a[class*="logo"] img, a[class*="logo"] svg',
      'img[class*="nav-logo"], svg[class*="nav-logo"]',
      'img[class*="logo"], svg[class*="logo"]',
    ];

    allLogoSelectors.forEach(selector => {
      Array.from(document.querySelectorAll(selector)).forEach(el => {
        collectLogoCandidate(el, selector);
      });
    });

    // Also collect from document.images and SVGs
    const excludeSelectors = '[class*="testimonial"], [class*="client"], [class*="partner"], [class*="customer"], [class*="case-study"], [id*="testimonial"], [id*="client"], [id*="partner"], [id*="customer"], [id*="case-study"], footer, [class*="footer"]';
    
    Array.from(document.images).forEach(img => {
      if (
        /logo/i.test(img.alt || "") ||
        /logo/i.test(img.src) ||
        img.closest('[class*="logo"]')
      ) {
        // Exclude customer/partner logos more aggressively
        if (!img.closest(excludeSelectors)) {
          collectLogoCandidate(img, "document.images");
        }
      }
    });

    // Collect SVGs from various sources - catch any SVGs in header/nav that weren't caught by selectors
    // This is a fallback to ensure we catch all SVGs that the original logic would have found
    Array.from(document.querySelectorAll("svg")).forEach(svg => {
      // Skip if already collected by selectors above (check by position to avoid re-serialization)
      const svgRect = svg.getBoundingClientRect();
      const alreadyCollected = logoCandidates.some(c => {
        if (!c.isSvg) return false;
        // Check if position matches (same SVG element)
        return Math.abs(c.position.top - svgRect.top) < 1 && 
               Math.abs(c.position.left - svgRect.left) < 1 &&
               Math.abs(c.position.width - svgRect.width) < 1 &&
               Math.abs(c.position.height - svgRect.height) < 1;
      });
      if (alreadyCollected) return;
      
      // Check if SVG matches logo criteria - VERY permissive (like old code)
      const hasLogoId = /logo/i.test(svg.id || "");
      const svgClass = svg.className?.baseVal || svg.className || "";
      const hasLogoClass = /logo/i.test(svgClass);
      const hasLogoAriaLabel = /logo/i.test(svg.getAttribute("aria-label") || "");
      const hasLogoTitle = /logo/i.test(svg.querySelector("title")?.textContent || "");
      const inHeaderNav = svg.closest('header, nav, [role="banner"], #navbar, [id*="navbar"], [class*="navbar"], [class*="header"]');
      const inLogoContainer = svg.closest('[class*="logo"], [id*="logo"]');
      const inHeaderNavArea = !!inHeaderNav;
      const inAnchorInHeader = svg.closest('a') && inHeaderNav;
      
      // VERY PERMISSIVE: Collect if:
      // 1. Has logo indicators (id, class, aria-label, title)
      // 2. Is in logo container
      // 3. Is in header/nav (most common case - no size constraint, like old code)
      // 4. Is in anchor in header/nav
      // This matches the original logic which was very permissive
      const shouldCollect = 
        hasLogoId ||
        hasLogoClass ||
        hasLogoAriaLabel ||
        hasLogoTitle ||
        inLogoContainer ||
        inHeaderNavArea ||
        inAnchorInHeader;
      
      if (shouldCollect) {
        // Exclude customer/partner logos more aggressively
        const excludeSelectors = '[class*="testimonial"], [class*="client"], [class*="partner"], [class*="customer"], [class*="case-study"], [id*="testimonial"], [id*="client"], [id*="partner"], [id*="customer"], [id*="case-study"], footer, [class*="footer"]';
        if (!svg.closest(excludeSelectors)) {
          collectLogoCandidate(svg, "document.querySelectorAll(svg)");
        }
      }
    });

    // Remove duplicates (same src)
    const seen = new Set();
    const uniqueCandidates = logoCandidates.filter(candidate => {
      if (seen.has(candidate.src)) return false;
      seen.add(candidate.src);
      return true;
    });

    // For backward compatibility, still pick one logo using the old logic
    // Try visible candidates first, but fall back to any candidate if none visible
    let candidatesToPick = uniqueCandidates.filter(c => c.isVisible);
    if (candidatesToPick.length === 0 && uniqueCandidates.length > 0) {
      // If no visible candidates, use all candidates (maybe hidden for dark/light mode)
      candidatesToPick = uniqueCandidates;
    }
    
    if (candidatesToPick.length > 0) {
      const best = candidatesToPick.reduce((best, candidate) => {
        if (!best) return candidate;
        if (candidate.indicators.inHeader && !best.indicators.inHeader) return candidate;
        if (!candidate.indicators.inHeader && best.indicators.inHeader) return best;
        return candidate.position.top < best.position.top ? candidate : best;
      }, null);

      if (best) {
        if (best.isSvg) {
          push(best.src, "logo-svg");
        } else {
          push(best.src, "logo");
        }
      }
    }

    return { images: imgs, logoCandidates: uniqueCandidates };
  };

  const getTypography = () => {
    const pickFontStack = el => {
      return (
        getComputedStyle(el)
          .fontFamily?.split(",")
          .map(f => f.replace(/["']/g, "").trim())
          .filter(Boolean) || []
      );
    };

    const h1 = document.querySelector("h1") || document.body;
    const h2 = document.querySelector("h2") || h1;
    const p = document.querySelector("p") || document.body;
    const body = document.body;

    return {
      stacks: {
        body: pickFontStack(body),
        heading: pickFontStack(h1),
        paragraph: pickFontStack(p),
      },
      sizes: {
        h1: getComputedStyle(h1).fontSize || "32px",
        h2: getComputedStyle(h2).fontSize || "24px",
        body: getComputedStyle(p).fontSize || "16px",
      },
    };
  };

  const detectFrameworkHints = () => {
    const hints = [];

    const generator = document.querySelector('meta[name="generator"]');
    if (generator) hints.push(generator.getAttribute("content") || "");

    const scripts = Array.from(document.querySelectorAll("script[src]"))
      .map(s => s.getAttribute("src") || "")
      .filter(Boolean);

    if (
      scripts.some(s => s.includes("tailwind") || s.includes("cdn.tailwindcss"))
    ) {
      hints.push("tailwind");
    }
    if (scripts.some(s => s.includes("bootstrap"))) {
      hints.push("bootstrap");
    }
    if (scripts.some(s => s.includes("mui") || s.includes("material-ui"))) {
      hints.push("material-ui");
    }

    return hints.filter(Boolean);
  };

  const detectColorScheme = () => {
    const body = document.body;
    const html = document.documentElement;

    // Check for explicit dark mode indicators
    const hasDarkIndicator =
      html.classList.contains("dark") ||
      body.classList.contains("dark") ||
      html.classList.contains("dark-mode") ||
      body.classList.contains("dark-mode") ||
      html.getAttribute("data-theme") === "dark" ||
      body.getAttribute("data-theme") === "dark" ||
      html.getAttribute("data-bs-theme") === "dark";

    // Check for explicit light mode indicators
    const hasLightIndicator =
      html.classList.contains("light") ||
      body.classList.contains("light") ||
      html.classList.contains("light-mode") ||
      body.classList.contains("light-mode") ||
      html.getAttribute("data-theme") === "light" ||
      body.getAttribute("data-theme") === "light" ||
      html.getAttribute("data-bs-theme") === "light";

    // Check prefers-color-scheme media query
    let prefersDark = false;
    try {
      prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    } catch (e) {}

    // If explicit indicators exist, use them (explicit overrides media query)
    if (hasDarkIndicator) return "dark";
    if (hasLightIndicator) return "light";

    // Analyze background colors from body/html and walk up the DOM if transparent
    const getEffectiveBackground = (el) => {
      let current = el;
      let depth = 0;
      while (current && depth < 10) {
        const bg = getComputedStyle(current).backgroundColor;
        const match = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
        if (match) {
          const r = parseInt(match[1], 10);
          const g = parseInt(match[2], 10);
          const b = parseInt(match[3], 10);
          const alpha = match[4] ? parseFloat(match[4]) : 1;
          
          // Only consider if not fully transparent
          if (alpha > 0.1) {
            return { r, g, b, alpha };
          }
        }
        current = current.parentElement;
        depth++;
      }
      return null;
    };

    const bodyBg = getEffectiveBackground(body);
    const htmlBg = getEffectiveBackground(html);
    const effectiveBg = bodyBg || htmlBg;

    if (effectiveBg) {
      const { r, g, b } = effectiveBg;
      const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      
      // Use luminance threshold: < 0.4 = dark, > 0.6 = light, 0.4-0.6 = use media query
      if (luminance < 0.4) return "dark";
      if (luminance > 0.6) return "light";
      
      // Ambiguous luminance: fall back to prefers-color-scheme
      return prefersDark ? "dark" : "light";
    }

    // No background color found: use prefers-color-scheme, default to light
    return prefersDark ? "dark" : "light";
  };

  const extractBrandName = () => {
    // Try multiple sources for brand name
    const ogSiteName = document.querySelector('meta[property="og:site_name"]')?.getAttribute("content");
    const title = document.title;
    const h1 = document.querySelector("h1")?.textContent?.trim();
    
    // Extract domain name as fallback
    let domainName = "";
    try {
      const hostname = window.location.hostname;
      domainName = hostname.replace(/^www\./, "").split(".")[0];
      // Capitalize first letter
      domainName = domainName.charAt(0).toUpperCase() + domainName.slice(1);
    } catch (e) {}

    // Try to extract brand from title (e.g., "Firecrawl - Documentation" -> "Firecrawl")
    let titleBrand = "";
    if (title) {
      // Remove common suffixes
      titleBrand = title
        .replace(/\s*[-|–|—]\s*.*$/, "") // Remove after dash
        .replace(/\s*:\s*.*$/, "") // Remove after colon
        .replace(/\s*\|.*$/, "") // Remove after pipe
        .trim();
    }

    return ogSiteName || titleBrand || h1 || domainName || "";
  };

  // Helper to check if a color is valid (not transparent)
  const isValidBackgroundColor = (color) => {
    if (!color || typeof color !== "string") return false;
    const normalized = color.toLowerCase().trim();
    // Explicitly transparent
    if (normalized === "transparent" || normalized === "rgba(0, 0, 0, 0)") {
      return false;
    }
    // Check for rgba with alpha exactly 0 (not just starting with 0)
    const rgbaMatch = normalized.match(/rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*([\d.]+)\s*\)/);
    if (rgbaMatch) {
      const alpha = parseFloat(rgbaMatch[1]);
      // Only filter if alpha is exactly 0 (or very close to 0 due to floating point)
      if (alpha < 0.01) {
        return false;
      }
      // rgba(0, 0, 0, 0.8) and similar opaque black backgrounds are valid
      return true;
    }
    // rgb(0, 0, 0) is a valid black background, not transparent
    // Check for color() format with alpha 0
    const colorMatch = normalized.match(/color\([^)]+\)/);
    if (colorMatch) {
      // If it's a color() format, include it (let the processor handle it)
      // Modern formats like color(display-p3 0 0 0 / 0.039216) are valid
      return true;
    }
    // Any other non-empty string is valid
    return normalized.length > 0;
  };

  const getBackgroundCandidates = () => {
    const candidates = [];
    
    // First, sample actual visible background colors from elements to find the most common
    const colorFrequency = new Map();
    const sampleElements = document.querySelectorAll("body, html, main, article, [role='main'], div, section");
    
    sampleElements.forEach((el, idx) => {
      if (idx < 100) { // Limit to first 100 elements
        try {
          const bg = getComputedStyle(el).backgroundColor;
          if (isValidBackgroundColor(bg)) {
            const rect = el.getBoundingClientRect();
            const area = rect.width * rect.height;
            // Only count if element has significant area
            if (area > 1000) {
              const normalized = bg.toLowerCase().trim();
              const currentCount = colorFrequency.get(normalized) || 0;
              colorFrequency.set(normalized, currentCount + area);
            }
          }
        } catch (e) {
          // Skip errors
        }
      }
    });
    
    // Find the most common background color by total area
    let mostCommonColor = null;
    let maxArea = 0;
    for (const [color, area] of colorFrequency.entries()) {
      if (area > maxArea) {
        maxArea = area;
        mostCommonColor = color;
      }
    }
    
    // Sample body and html background colors directly
    const bodyBg = getComputedStyle(document.body).backgroundColor;
    const htmlBg = getComputedStyle(document.documentElement).backgroundColor;
    
    // Prefer body/html if they're valid, but give extra boost if they match the most common color
    if (isValidBackgroundColor(bodyBg)) {
      const normalized = bodyBg.toLowerCase().trim();
      const priority = normalized === mostCommonColor ? 15 : 10;
      candidates.push({
        color: bodyBg,
        source: "body",
        priority: priority,
      });
    }
    
    if (isValidBackgroundColor(htmlBg)) {
      const normalized = htmlBg.toLowerCase().trim();
      const priority = normalized === mostCommonColor ? 14 : 9;
      candidates.push({
        color: htmlBg,
        source: "html",
        priority: priority,
      });
    }
    
    // Add the most common color as a candidate if it's different from body/html
    if (mostCommonColor && mostCommonColor !== bodyBg?.toLowerCase().trim() && mostCommonColor !== htmlBg?.toLowerCase().trim()) {
      candidates.push({
        color: mostCommonColor,
        source: "most-common-visible",
        priority: 12, // High priority but below body/html
        area: maxArea,
      });
    }
    
    // Try to get CSS custom properties (common in Tailwind/modern frameworks)
    // Create a temporary element to resolve CSS variables
    let tempEl = null;
    try {
      tempEl = document.createElement("div");
      tempEl.style.setProperty("background-color", "var(--background)");
      document.body.appendChild(tempEl);
      const tempStyle = getComputedStyle(tempEl);
      
      const cssVars = [
        "--background",
        "--background-light",
        "--background-dark",
        "--bg-background",
        "--bg-background-light",
        "--bg-background-dark",
        "--color-background",
        "--color-background-light",
        "--color-background-dark",
      ];
      
      cssVars.forEach(varName => {
        try {
          // Try to resolve the CSS variable
          tempEl.style.setProperty("background-color", "var(" + varName + ")");
          const resolved = tempStyle.backgroundColor;
          
          if (isValidBackgroundColor(resolved)) {
            candidates.push({
              color: resolved,
              source: "css-var:" + varName,
              priority: 8,
            });
          }
        } catch (e) {
          // Skip this variable if there's an error
        }
      });
      
      if (tempEl && tempEl.parentElement) {
        document.body.removeChild(tempEl);
      }
    } catch (e) {
      // If temp element creation fails, continue without CSS variables
      if (tempEl && tempEl.parentElement) {
        try {
          document.body.removeChild(tempEl);
        } catch (e2) {
          // Ignore cleanup errors
        }
      }
    }
    
    // Sample from main containers (header, main, article, etc.)
    try {
      const mainContainers = document.querySelectorAll("main, article, [role='main'], header, .main, .container");
      mainContainers.forEach((el, idx) => {
        if (idx < 5) { // Limit to first 5
          try {
            const bg = getComputedStyle(el).backgroundColor;
            if (isValidBackgroundColor(bg)) {
              const rect = el.getBoundingClientRect();
              const area = rect.width * rect.height;
              // Only include if it's a significant area
              if (area > 10000) {
                candidates.push({
                  color: bg,
                  source: el.tagName.toLowerCase() + "-container",
                  priority: 5,
                  area: area,
                });
              }
            }
          } catch (e) {
            // Skip this element if there's an error
          }
        }
      });
    } catch (e) {
      // If container selection fails, continue
    }
    
    // Helper to normalize white color variants
    const normalizeWhite = (color) => {
      if (!color) return null;
      const normalized = color.toLowerCase().trim();
      // Check for various white formats
      if (normalized === "#ffffff" || normalized === "#fff" || 
          normalized === "rgb(255, 255, 255)" || normalized === "rgba(255, 255, 255, 1)" ||
          normalized === "rgba(255, 255, 255, 1.0)" || normalized.startsWith("rgba(255, 255, 255")) {
        return "rgb(255, 255, 255)";
      }
      return normalized;
    };
    
    // Normalize white variants and boost priority for white backgrounds
    const normalizedCandidates = candidates.map(c => {
      const normalized = normalizeWhite(c.color);
      if (normalized === "rgb(255, 255, 255)") {
        // Boost white backgrounds slightly
        return {
          ...c,
          color: normalized,
          priority: (c.priority || 0) + 1,
        };
      }
      return {
        ...c,
        color: normalized || c.color,
      };
    });
    
    // Remove duplicates (same color value)
    const seen = new Set();
    const unique = normalizedCandidates.filter(c => {
      if (!c || !c.color) return false;
      const key = c.color.toLowerCase().trim();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    
    // Sort by priority (highest first)
    unique.sort((a, b) => (b.priority || 0) - (a.priority || 0));
    
    return unique;
  };

  const cssData = collectCSSData();
  const elements = sampleElements();
  const snapshots = elements.map(getStyleSnapshot);
  const imageData = findImages();
  const typography = getTypography();
  const frameworkHints = detectFrameworkHints();
  const colorScheme = detectColorScheme();
  const brandName = extractBrandName();
  const backgroundCandidates = getBackgroundCandidates();
  
  // Keep pageBackground for backward compatibility (first candidate)
  const pageBackground = backgroundCandidates.length > 0 ? backgroundCandidates[0].color : null;

  return {
    branding: {
      cssData,
      snapshots,
      images: imageData.images,
      logoCandidates: imageData.logoCandidates,
      brandName,
      typography,
      frameworkHints,
      colorScheme,
      pageBackground,
      backgroundCandidates,
    },
  };
})();`;
