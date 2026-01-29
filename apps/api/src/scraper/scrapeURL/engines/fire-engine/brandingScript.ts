export const getBrandingScript = () => String.raw`
(function __extractBrandDesign() {
  const errors = [];
  const recordError = (context, error) => {
    errors.push({
      context: context,
      message: error && error.message ? error.message : String(error),
      timestamp: Date.now(),
    });
  };

  const CONSTANTS = {
    BUTTON_MIN_WIDTH: 50,
    BUTTON_MIN_HEIGHT: 25,
    BUTTON_MIN_PADDING_VERTICAL: 3,
    BUTTON_MIN_PADDING_HORIZONTAL: 6,
    MAX_PARENT_TRAVERSAL: 5,
    MAX_BACKGROUND_SAMPLES: 100,
    MIN_SIGNIFICANT_AREA: 1000,
    MIN_LARGE_CONTAINER_AREA: 10000,
    DUPLICATE_POSITION_THRESHOLD: 1,
    MIN_LOGO_SIZE: 25,
    MIN_ALPHA_THRESHOLD: 0.1,
    MAX_TRANSPARENT_ALPHA: 0.01,
    BUTTON_SELECTOR: 'button,input[type="submit"],input[type="button"],[role=button],[data-primary-button],[data-secondary-button],[data-cta],a.button,a.btn,[class*="btn"],[class*="button"],a[class*="bg-brand"],a[class*="bg-primary"],a[class*="bg-accent"]',
  };

  const styleCache = new WeakMap();
  const getComputedStyleCached = (el) => {
    if (styleCache.has(el)) {
      return styleCache.get(el);
    }
    const style = getComputedStyle(el);
    styleCache.set(el, style);
    return style;
  };

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

  const getClassNameString = (el) => {
    if (!el || !el.className) return '';
    try {
      if (el.className.baseVal !== undefined) {
        return String(el.className.baseVal || '');
      }
      if (typeof el.className.toString === 'function') {
        return String(el.className);
      }
      if (typeof el.className === 'string') {
        return el.className;
      }
      return String(el.className || '');
    } catch (e) {
      return '';
    }
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
        recordError('collectCSSData - CORS stylesheet', e);
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

  const checkButtonLikeElement = (el, cs, rect, classNames) => {
    const hasButtonClasses = 
      /rounded(-md|-lg|-xl|-full)?/.test(classNames) ||
      /px-\d+/.test(classNames) ||
      /py-\d+/.test(classNames) ||
      /p-\d+/.test(classNames) ||
      (/border/.test(classNames) && /rounded/.test(classNames)) ||
      (/inline-flex/.test(classNames) && /items-center/.test(classNames) && /justify-center/.test(classNames));
    
    if (hasButtonClasses && rect.width > CONSTANTS.BUTTON_MIN_WIDTH && rect.height > CONSTANTS.BUTTON_MIN_HEIGHT) {
      return true;
    }
    
    const paddingTop = parseFloat(cs.paddingTop) || 0;
    const paddingBottom = parseFloat(cs.paddingBottom) || 0;
    const paddingLeft = parseFloat(cs.paddingLeft) || 0;
    const paddingRight = parseFloat(cs.paddingRight) || 0;
    const hasPadding = paddingTop > CONSTANTS.BUTTON_MIN_PADDING_VERTICAL || 
                      paddingBottom > CONSTANTS.BUTTON_MIN_PADDING_VERTICAL || 
                      paddingLeft > CONSTANTS.BUTTON_MIN_PADDING_HORIZONTAL || 
                      paddingRight > CONSTANTS.BUTTON_MIN_PADDING_HORIZONTAL;
    const hasMinSize = rect.width > CONSTANTS.BUTTON_MIN_WIDTH && rect.height > CONSTANTS.BUTTON_MIN_HEIGHT;
    const hasRounded = parseFloat(cs.borderRadius) > 0;
    const hasBorder = parseFloat(cs.borderTopWidth) > 0 || parseFloat(cs.borderBottomWidth) > 0 ||
                     parseFloat(cs.borderLeftWidth) > 0 || parseFloat(cs.borderRightWidth) > 0;
    
    return hasPadding && hasMinSize && (hasRounded || hasBorder);
  };

  const isButtonElement = (el) => {
    if (!el || typeof el.matches !== 'function') return false;
    
    if (el.matches(CONSTANTS.BUTTON_SELECTOR)) {
      return true;
    }
    
    if (el.tagName.toLowerCase() === 'a') {
      try {
        const classNames = getClassNameString(el).toLowerCase();
        const cs = getComputedStyleCached(el);
        const rect = el.getBoundingClientRect();
        return checkButtonLikeElement(el, cs, rect, classNames);
      } catch (e) {
        recordError('isButtonElement', e);
        return false;
      }
    }
    
    return false;
  };

  const looksLikeButton = (el) => {
    return isButtonElement(el);
  };

  const sampleElements = () => {
    const picksSet = new Set();
    
    const pushQ = (q, limit = 10) => {
      const elements = document.querySelectorAll(q);
      let count = 0;
      for (const el of elements) {
        if (count >= limit) break;
        picksSet.add(el);
        count++;
      }
    };

    pushQ('header img, .site-logo img, img[alt*=logo i], img[src*="logo"]', 5);
    
    pushQ(
      'button, input[type="submit"], input[type="button"], [role=button], [data-primary-button], [data-secondary-button], [data-cta], a.button, a.btn, [class*="btn"], [class*="button"], a[class*="bg-brand"], a[class*="bg-primary"], a[class*="bg-accent"]',
      100,
    );
    
    const allLinks = Array.from(document.querySelectorAll('a')).slice(0, 100);
    for (const link of allLinks) {
      if (!picksSet.has(link) && looksLikeButton(link)) {
        picksSet.add(link);
      }
    }
    
    pushQ('input, select, textarea, [class*="form-control"]', 25);
    pushQ("h1, h2, h3, p, a", 50);

    const result = [...picksSet];
    
    return result.filter(Boolean);
  };

  const getStyleSnapshot = el => {
    const cs = getComputedStyleCached(el);
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
      if (!classNames) {
        classNames = getClassNameString(el).toLowerCase();
      }
    } catch (e) {
      try {
        classNames = getClassNameString(el).toLowerCase();
      } catch (e2) {
        classNames = "";
      }
    }

    let bgColor = cs.getPropertyValue("background-color");
    const textColor = cs.getPropertyValue("color");
    
    const isTransparent = bgColor === "transparent" || bgColor === "rgba(0, 0, 0, 0)";
    const alphaMatch = bgColor.match(/rgba?\([^,]*,[^,]*,[^,]*,\s*([\d.]+)\)/);
    const hasZeroAlpha = alphaMatch && parseFloat(alphaMatch[1]) === 0;
    
    const isInputElement = el.tagName.toLowerCase() === 'input' || 
                          el.tagName.toLowerCase() === 'select' || 
                          el.tagName.toLowerCase() === 'textarea';
    
    if ((isTransparent || hasZeroAlpha) && !isInputElement) {
      let parent = el.parentElement;
      let depth = 0;
      while (parent && depth < CONSTANTS.MAX_PARENT_TRAVERSAL) {
        const parentBg = getComputedStyleCached(parent).getPropertyValue("background-color");
        if (parentBg && parentBg !== "transparent" && parentBg !== "rgba(0, 0, 0, 0)") {
          const parentAlphaMatch = parentBg.match(/rgba?\([^,]*,[^,]*,[^,]*,\s*([\d.]+)\)/);
          const parentAlpha = parentAlphaMatch ? parseFloat(parentAlphaMatch[1]) : 1;
          if (parentAlpha > CONSTANTS.MIN_ALPHA_THRESHOLD) {
            bgColor = parentBg;
            break;
          }
        }
        parent = parent.parentElement;
        depth++;
      }
    }

    const isButton = isButtonElement(el);

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
        
        const hasNavRole = el.matches(
          '[role="tab"],[role="menuitem"],[role="menuitemcheckbox"],[aria-haspopup],[aria-expanded]',
        );
        
        const inNavContext = !!el.closest(
          'nav, [role="navigation"], [role="menu"], [role="menubar"], [class*="navigation"], [class*="dropdown"], [class*="sidebar"], [id*="sidebar"], [id*="navigation"], [id*="nav-"], aside[class*="nav"], aside[id*="nav"]',
        );
        
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

    let text = "";
    if (el.tagName.toLowerCase() === 'input' && (el.type === 'submit' || el.type === 'button')) {
      text = (el.value && el.value.trim().substring(0, 100)) || "";
    } else {
      text = (el.textContent && el.textContent.trim().substring(0, 100)) || "";
    }

    const isInputField = el.matches('input:not([type="submit"]):not([type="button"]),select,textarea,[class*="form-control"]');
    let inputMetadata = null;
    if (isInputField) {
      const tagName = el.tagName.toLowerCase();
      inputMetadata = {
        type: tagName === 'input' ? (el.type || 'text') : tagName,
        placeholder: el.placeholder || "",
        value: tagName === 'input' ? (el.value || "") : "",
        required: el.required || false,
        disabled: el.disabled || false,
        name: el.name || "",
        id: el.id || "",
        label: (() => {
          if (el.id) {
            const label = document.querySelector('label[for="' + el.id + '"]');
            if (label) return (label.textContent || "").trim().substring(0, 100);
          }
          const parentLabel = el.closest('label');
          if (parentLabel) {
            const clone = parentLabel.cloneNode(true);
            const inputInClone = clone.querySelector('input,select,textarea');
            if (inputInClone) inputInClone.remove();
            return (clone.textContent || "").trim().substring(0, 100);
          }
          return "";
        })(),
      };
    }

    return {
      tag: el.tagName.toLowerCase(),
      classes: classNames,
      text: text,
      rect: { w: rect.width, h: rect.height },
      colors: {
        text: textColor,
        background: bgColor,
        border: (() => {
          const top = cs.getPropertyValue("border-top-color");
          const right = cs.getPropertyValue("border-right-color");
          const bottom = cs.getPropertyValue("border-bottom-color");
          const left = cs.getPropertyValue("border-left-color");
          if (top === right && top === bottom && top === left) return top;
          return top;
        })(),
        borderWidth: (() => {
          const top = toPx(cs.getPropertyValue("border-top-width"));
          const right = toPx(cs.getPropertyValue("border-right-width"));
          const bottom = toPx(cs.getPropertyValue("border-bottom-width"));
          const left = toPx(cs.getPropertyValue("border-left-width"));
          if (top === right && top === bottom && top === left) return top;
          return top;
        })(),
        borderTop: cs.getPropertyValue("border-top-color"),
        borderTopWidth: toPx(cs.getPropertyValue("border-top-width")),
        borderRight: cs.getPropertyValue("border-right-color"),
        borderRightWidth: toPx(cs.getPropertyValue("border-right-width")),
        borderBottom: cs.getPropertyValue("border-bottom-color"),
        borderBottomWidth: toPx(cs.getPropertyValue("border-bottom-width")),
        borderLeft: cs.getPropertyValue("border-left-color"),
        borderLeftWidth: toPx(cs.getPropertyValue("border-left-width")),
      },
      typography: {
        fontStack,
        size: cs.getPropertyValue("font-size") || null,
        weight: parseInt(cs.getPropertyValue("font-weight"), 10) || null,
      },
      radius: toPx(cs.getPropertyValue("border-radius")),
      borderRadius: {
        topLeft: toPx(cs.getPropertyValue("border-top-left-radius")),
        topRight: toPx(cs.getPropertyValue("border-top-right-radius")),
        bottomRight: toPx(cs.getPropertyValue("border-bottom-right-radius")),
        bottomLeft: toPx(cs.getPropertyValue("border-bottom-left-radius")),
      },
      shadow: cs.getPropertyValue("box-shadow") || null,
      isButton: isButton && !isNavigation,
      isNavigation: isNavigation,
      hasCTAIndicator: hasCTAIndicator,
      isInput: isInputField,
      inputMetadata: inputMetadata,
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

    const collectLogoCandidate = (el, source) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyleCached(el);
      const isVisible = (
        rect.width > 0 &&
        rect.height > 0 &&
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        style.opacity !== "0"
      );

      const imgSrc = el.src || '';
      if (imgSrc) {
        const ogImageSrc = document.querySelector('meta[property="og:image"]')?.getAttribute('content') || '';
        const twitterImageSrc = document.querySelector('meta[name="twitter:image"]')?.getAttribute('content') || '';
        
        if ((ogImageSrc && imgSrc.includes(ogImageSrc)) || 
            (twitterImageSrc && imgSrc.includes(twitterImageSrc)) ||
            (ogImageSrc && ogImageSrc.includes(imgSrc)) ||
            (twitterImageSrc && twitterImageSrc.includes(imgSrc))) {
          return;
        }
      }

      const inHeader = el.closest('header, nav, [role="banner"], #navbar, [id*="navbar"], [class*="navbar"], [class*="header"]');
      
      const langSwitcherParent = el.closest('[class*="lang"], [class*="language"], [class*="locale"], [class*="i18n"], [class*="translation"], [class*="switcher"], [id*="lang"], [id*="language"], [id*="locale"]');
      if (langSwitcherParent) {
        const parentClasses = getClassNameString(langSwitcherParent).toLowerCase();
        if (/lang|language|locale|i18n|translation|switcher|selector|dropdown/i.test(parentClasses)) {
          return;
        }
      }
      
      const insideButton = el.closest('button, [role="button"], input[type="button"], input[type="submit"]');
      if (insideButton) {
        return;
      }
      

      const elementClasses = getClassNameString(el).toLowerCase();
      const elementId = (el.id || '').toLowerCase();
      const ariaLabel = (el.getAttribute?.('aria-label') || '').toLowerCase();
      
      const isSearchIcon = 
        /search|magnif/i.test(elementClasses) ||
        /search|magnif/i.test(elementId) ||
        /search/i.test(ariaLabel) ||
        el.closest('[class*="search"], [id*="search"], [role="search"]');
      
      if (isSearchIcon) return;
      
      const isUIIcon = 
        /icon|menu|hamburger|bars|close|times|cart|user|account|profile|settings|notification|bell|chevron|arrow|caret|dropdown/i.test(elementClasses) ||
        /icon|menu|hamburger|cart|user|bell/i.test(elementId) ||
        /menu|close|cart|user|settings/i.test(ariaLabel);
      
      if (isUIIcon) {
        const hasExplicitLogoIndicator = 
          /logo|brand|site-name|site-title/i.test(elementClasses) ||
          /logo|brand/i.test(elementId);
        
        if (!hasExplicitLogoIndicator) return;
      }
      
      const anchorParent = el.closest('a');
      const href = anchorParent ? (anchorParent.getAttribute('href') || '') : '';
      
      if (href && href.trim()) {
        const hrefLower = href.toLowerCase().trim();
        
        const isExternalLink = 
          hrefLower.startsWith('http://') || 
          hrefLower.startsWith('https://') || 
          hrefLower.startsWith('//');
        
        if (isExternalLink) {
          const externalServiceDomains = [
            'github.com', 'twitter.com', 'x.com', 'facebook.com', 'linkedin.com',
            'instagram.com', 'youtube.com', 'discord.com', 'slack.com',
            'npmjs.com', 'pypi.org', 'crates.io', 'packagist.org',
            'badge.fury.io', 'shields.io', 'img.shields.io', 'badgen.net',
            'codecov.io', 'coveralls.io', 'circleci.com', 'travis-ci.org',
            'app.netlify.com', 'vercel.com'
          ];
          
          if (externalServiceDomains.some(domain => hrefLower.includes(domain))) {
            return;
          }
          
          try {
            const currentHostname = window.location.hostname.toLowerCase();
            const linkUrl = new URL(href, window.location.origin);
            const linkHostname = linkUrl.hostname.toLowerCase();
            
            if (linkHostname !== currentHostname) {
              return;
            }
          } catch (e) {
            return;
          }
        }
      }
      
      const isSvg = el.tagName.toLowerCase() === "svg";
      
      let alt = "";
      let srcMatch = false;
      let altMatch = false;
      let classMatch = false;
      let hrefMatch = false;
      
      if (isSvg) {
        const svgId = el.id || "";
        const svgClass = getClassNameString(el);
        const svgAriaLabel = el.getAttribute("aria-label") || "";
        const svgTitle = el.querySelector("title")?.textContent || "";
        const svgText = el.textContent?.trim() || "";
        
        alt = svgAriaLabel || svgTitle || svgText || svgId || "";
        altMatch = /logo/i.test(svgId) || /logo/i.test(svgAriaLabel) || /logo/i.test(svgTitle);
        classMatch = /logo/i.test(svgClass);
        srcMatch = el.closest('[class*="logo"], [id*="logo"]') !== null;
      } else {
        const imgId = el.id || "";
        alt = el.alt || "";
        
        const idMatch = /logo/i.test(imgId);
        srcMatch = (el.src ? /logo/i.test(el.src) : false) || idMatch;
        altMatch = /logo/i.test(alt);
        
        const imgClass = getClassNameString(el);
        classMatch = /logo/i.test(imgClass) || el.closest('[class*="logo"], [id*="logo"]') !== null || idMatch;
      }
      
      let src = "";
      
      if (isSvg) {
        try {
          const resolvedSvg = resolveSvgStyles(el);
          const serializer = new XMLSerializer();
          src = "data:image/svg+xml;utf8," + encodeURIComponent(serializer.serializeToString(resolvedSvg));
        } catch (e) {
          recordError('resolveSvgStyles', e);
          try {
            const serializer = new XMLSerializer();
            src = "data:image/svg+xml;utf8," + encodeURIComponent(serializer.serializeToString(el));
          } catch (e2) {
            recordError('XMLSerializer fallback', e2);
            return;
          }
        }
      } else {
        src = el.src || "";
      }

      if (href) {
        const normalizedHref = href.toLowerCase().trim();
        
        hrefMatch = normalizedHref === '/' || 
                   normalizedHref === '/home' || 
                   normalizedHref === '/index' || 
                   normalizedHref === '';
        
        if (!hrefMatch && (normalizedHref.startsWith('http://') || normalizedHref.startsWith('https://') || normalizedHref.startsWith('//'))) {
          try {
            const currentHostname = window.location.hostname.toLowerCase();
            const linkUrl = new URL(href, window.location.origin);
            const linkHostname = linkUrl.hostname.toLowerCase();
            
            if (linkHostname === currentHostname && (linkUrl.pathname === '/' || linkUrl.pathname === '/home' || linkUrl.pathname === '/index.html')) {
              hrefMatch = true;
            }
          } catch (e) {}
        }
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

    const allLogoSelectors = [
      'header a img, header a svg, header img, header svg',
      '[class*="header"] a img, [class*="header"] a svg, [class*="header"] img, [class*="header"] svg',
      'nav a img, nav a svg, nav img, nav svg',
      '[role="banner"] a img, [role="banner"] a svg, [role="banner"] img, [role="banner"] svg',
      '#navbar a img, #navbar a svg, #navbar img, #navbar svg',
      '[id*="navbar"] a img, [id*="navbar"] a svg, [id*="navbar"] img, [id*="navbar"] svg',
      '[class*="navbar"] a img, [class*="navbar"] a svg, [class*="navbar"] img, [class*="navbar"] svg',
      'a[class*="logo"] img, a[class*="logo"] svg',
      '[class*="logo"] img, [class*="logo"] svg',
      '[id*="logo"] img, [id*="logo"] svg',
      'img[class*="nav-logo"], svg[class*="nav-logo"]',
      'img[class*="logo"], svg[class*="logo"]',
    ];

    allLogoSelectors.forEach(selector => {
      Array.from(document.querySelectorAll(selector)).forEach(el => {
        collectLogoCandidate(el, selector);
      });
    });

    const excludeSelectors = '[class*="testimonial"], [class*="client"], [class*="partner"], [class*="customer"], [class*="case-study"], [id*="testimonial"], [id*="client"], [id*="partner"], [id*="customer"], [id*="case-study"], footer, [class*="footer"]';
    
    Array.from(document.images).forEach(img => {
      if (
        /logo/i.test(img.alt || "") ||
        /logo/i.test(img.src) ||
        img.closest('[class*="logo"]')
      ) {
        if (!img.closest(excludeSelectors)) {
          collectLogoCandidate(img, "document.images");
        }
      }
    });

    Array.from(document.querySelectorAll("svg")).forEach(svg => {
      const svgRect = svg.getBoundingClientRect();
      const alreadyCollected = logoCandidates.some(c => {
        if (!c.isSvg) return false;
        return Math.abs(c.position.top - svgRect.top) < 1 && 
               Math.abs(c.position.left - svgRect.left) < 1 &&
               Math.abs(c.position.width - svgRect.width) < 1 &&
               Math.abs(c.position.height - svgRect.height) < 1;
      });
      if (alreadyCollected) return;
      
      const insideButton = svg.closest('button, [role="button"], input[type="button"], input[type="submit"]');
      if (insideButton) return;
      
      // Check for UI icon indicators
      const svgId = svg.id || "";
      const svgClass = getClassNameString(svg);
      const svgAriaLabel = svg.getAttribute("aria-label") || "";
      const svgTitle = svg.querySelector("title")?.textContent || "";
      
      // Skip search icons
      const isSearchIcon = 
        /search|magnif/i.test(svgId) ||
        /search|magnif/i.test(svgClass) ||
        /search/i.test(svgAriaLabel) ||
        /search/i.test(svgTitle) ||
        svg.closest('[class*="search"], [id*="search"], [role="search"]');
      
      if (isSearchIcon) return;
      
      // Skip other UI icons
      const isUIIcon = 
        /icon|menu|hamburger|bars|close|times|cart|user|account|profile|settings|notification|bell|chevron|arrow|caret|dropdown/i.test(svgClass) ||
        /icon|menu|hamburger|cart|user|bell/i.test(svgId) ||
        /menu|close|cart|user|settings/i.test(svgAriaLabel);
      
      const hasLogoId = /logo/i.test(svgId);
      const hasLogoClass = /logo/i.test(svgClass);
      const hasLogoAriaLabel = /logo/i.test(svgAriaLabel);
      const hasLogoTitle = /logo/i.test(svgTitle);
      const inHeaderNav = svg.closest('header, nav, [role="banner"], #navbar, [id*="navbar"], [class*="navbar"], [class*="header"]');
      const inLogoContainer = svg.closest('[class*="logo"], [id*="logo"]');
      const inHeaderNavArea = !!inHeaderNav;
      const inAnchorInHeader = svg.closest('a') && inHeaderNav;
      
      // If it looks like a UI icon, only collect if it has explicit logo indicators
      if (isUIIcon) {
        const hasExplicitLogoIndicator = hasLogoId || hasLogoClass || hasLogoAriaLabel || hasLogoTitle || inLogoContainer;
        if (!hasExplicitLogoIndicator) return;
      }
      
      const shouldCollect = 
        hasLogoId ||
        hasLogoClass ||
        hasLogoAriaLabel ||
        hasLogoTitle ||
        inLogoContainer ||
        inHeaderNavArea ||
        inAnchorInHeader;
      
      if (shouldCollect) {
        const excludeSelectors = '[class*="testimonial"], [class*="client"], [class*="partner"], [class*="customer"], [class*="case-study"], [id*="testimonial"], [id*="client"], [id*="partner"], [id*="customer"], [id*="case-study"], footer, [class*="footer"]';
        if (!svg.closest(excludeSelectors)) {
          collectLogoCandidate(svg, "document.querySelectorAll(svg)");
        }
      }
    });

    const seen = new Set();
    const uniqueCandidates = logoCandidates.filter(candidate => {
      if (seen.has(candidate.src)) return false;
      seen.add(candidate.src);
      return true;
    });

    let candidatesToPick = uniqueCandidates.filter(c => c.isVisible);
    if (candidatesToPick.length === 0 && uniqueCandidates.length > 0) {
      candidatesToPick = uniqueCandidates;
    }
    
    if (candidatesToPick.length > 0) {
      const best = candidatesToPick.reduce((best, candidate) => {
        if (!best) return candidate;
        
        if (candidate.indicators.inHeader && !best.indicators.inHeader) return candidate;
        if (!candidate.indicators.inHeader && best.indicators.inHeader) return best;
        
        if (candidate.indicators.hrefMatch && !best.indicators.hrefMatch) return candidate;
        if (!candidate.indicators.hrefMatch && best.indicators.hrefMatch) return best;
        
        if (candidate.indicators.classMatch && !best.indicators.classMatch) return candidate;
        if (!candidate.indicators.classMatch && best.indicators.classMatch) return best;
        
        const candidateArea = candidate.position.width * candidate.position.height;
        const bestArea = best.position.width * best.position.height;
        const candidateTooSmall = candidate.position.width < CONSTANTS.MIN_LOGO_SIZE || candidate.position.height < CONSTANTS.MIN_LOGO_SIZE;
        const bestTooSmall = best.position.width < CONSTANTS.MIN_LOGO_SIZE || best.position.height < CONSTANTS.MIN_LOGO_SIZE;
        
        if (candidateTooSmall && !bestTooSmall) return best;
        if (!candidateTooSmall && bestTooSmall) return candidate;
        
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
        getComputedStyleCached(el)
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
        h1: getComputedStyleCached(h1).fontSize || "32px",
        h2: getComputedStyleCached(h2).fontSize || "24px",
        body: getComputedStyleCached(p).fontSize || "16px",
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

    const hasDarkIndicator =
      html.classList.contains("dark") ||
      body.classList.contains("dark") ||
      html.classList.contains("dark-mode") ||
      body.classList.contains("dark-mode") ||
      html.getAttribute("data-theme") === "dark" ||
      body.getAttribute("data-theme") === "dark" ||
      html.getAttribute("data-bs-theme") === "dark";

    const hasLightIndicator =
      html.classList.contains("light") ||
      body.classList.contains("light") ||
      html.classList.contains("light-mode") ||
      body.classList.contains("light-mode") ||
      html.getAttribute("data-theme") === "light" ||
      body.getAttribute("data-theme") === "light" ||
      html.getAttribute("data-bs-theme") === "light";

    let prefersDark = false;
    try {
      prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    } catch (e) {}

    if (hasDarkIndicator) return "dark";
    if (hasLightIndicator) return "light";

    const getEffectiveBackground = (el) => {
      let current = el;
      let depth = 0;
      while (current && depth < 10) {
        const bg = getComputedStyleCached(current).backgroundColor;
        const match = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
        if (match) {
          const r = parseInt(match[1], 10);
          const g = parseInt(match[2], 10);
          const b = parseInt(match[3], 10);
          const alpha = match[4] ? parseFloat(match[4]) : 1;
          
          if (alpha > CONSTANTS.MIN_ALPHA_THRESHOLD) {
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
      
      if (luminance < 0.4) return "dark";
      if (luminance > 0.6) return "light";
      
      return prefersDark ? "dark" : "light";
    }

    return prefersDark ? "dark" : "light";
  };

  const extractBrandName = () => {
    const ogSiteName = document.querySelector('meta[property="og:site_name"]')?.getAttribute("content");
    const title = document.title;
    const h1 = document.querySelector("h1")?.textContent?.trim();
    
    let domainName = "";
    try {
      const hostname = window.location.hostname;
      domainName = hostname.replace(/^www\./, "").split(".")[0];
      domainName = domainName.charAt(0).toUpperCase() + domainName.slice(1);
    } catch (e) {}

    let titleBrand = "";
    if (title) {
      titleBrand = title
        .replace(/\s*[-|–|—]\s*.*$/, "")
        .replace(/\s*:\s*.*$/, "")
        .replace(/\s*\|.*$/, "")
        .trim();
    }

    return ogSiteName || titleBrand || h1 || domainName || "";
  };

  const normalizeColor = (color) => {
    if (!color || typeof color !== "string") return null;
    const normalized = color.toLowerCase().trim();
    
    if (normalized === "transparent" || normalized === "rgba(0, 0, 0, 0)") {
      return null;
    }
    
    if (normalized === "#ffffff" || normalized === "#fff" || 
        normalized === "white" || normalized === "rgb(255, 255, 255)" || 
        /^rgba\(255,\s*255,\s*255(,\s*1(\.0)?)?\)$/.test(normalized)) {
      return "rgb(255, 255, 255)";
    }
    
    if (normalized === "#000000" || normalized === "#000" || 
        normalized === "black" || normalized === "rgb(0, 0, 0)" ||
        /^rgba\(0,\s*0,\s*0(,\s*1(\.0)?)?\)$/.test(normalized)) {
      return "rgb(0, 0, 0)";
    }
    
    if (normalized.startsWith("#")) {
      return normalized;
    }
    
    if (normalized.startsWith("rgb")) {
      return normalized.replace(/\s+/g, "");
    }
    
    return normalized;
  };

  const isValidBackgroundColor = (color) => {
    if (!color || typeof color !== "string") return false;
    const normalized = color.toLowerCase().trim();
    if (normalized === "transparent" || normalized === "rgba(0, 0, 0, 0)") {
      return false;
    }
    const rgbaMatch = normalized.match(/rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*([\d.]+)\s*\)/);
    if (rgbaMatch) {
      const alpha = parseFloat(rgbaMatch[1]);
      if (alpha < CONSTANTS.MAX_TRANSPARENT_ALPHA) {
        return false;
      }
      return true;
    }
    const colorMatch = normalized.match(/color\([^)]+\)/);
    if (colorMatch) {
      return true;
    }
    return normalized.length > 0;
  };

  const getBackgroundCandidates = () => {
    const candidates = [];
    
    const colorFrequency = new Map();
    const allSampleElements = document.querySelectorAll("body, html, main, article, [role='main'], div, section");
    const sampleElements = Array.from(allSampleElements).slice(0, CONSTANTS.MAX_BACKGROUND_SAMPLES);
    
    sampleElements.forEach(el => {
      try {
        const bg = getComputedStyleCached(el).backgroundColor;
        if (isValidBackgroundColor(bg)) {
          const rect = el.getBoundingClientRect();
          const area = rect.width * rect.height;
          if (area > CONSTANTS.MIN_SIGNIFICANT_AREA) {
            const normalized = normalizeColor(bg);
            if (normalized) {
              const currentCount = colorFrequency.get(normalized) || 0;
              colorFrequency.set(normalized, currentCount + area);
            }
          }
        }
      } catch (e) {}
    });
    
    let mostCommonColor = null;
    let maxArea = 0;
    for (const [color, area] of colorFrequency.entries()) {
      if (area > maxArea) {
        maxArea = area;
        mostCommonColor = color;
      }
    }
    
    const bodyBg = getComputedStyleCached(document.body).backgroundColor;
    const htmlBg = getComputedStyleCached(document.documentElement).backgroundColor;
    
    if (isValidBackgroundColor(bodyBg)) {
      const normalized = normalizeColor(bodyBg);
      const priority = normalized === mostCommonColor ? 15 : 10;
      if (normalized) {
        candidates.push({
          color: normalized,
          source: "body",
          priority: priority,
        });
      }
    }
    
    if (isValidBackgroundColor(htmlBg)) {
      const normalized = normalizeColor(htmlBg);
      const priority = normalized === mostCommonColor ? 14 : 9;
      if (normalized) {
        candidates.push({
          color: normalized,
          source: "html",
          priority: priority,
        });
      }
    }
    
    const normalizedBodyBg = normalizeColor(bodyBg);
    const normalizedHtmlBg = normalizeColor(htmlBg);
    if (mostCommonColor && mostCommonColor !== normalizedBodyBg && mostCommonColor !== normalizedHtmlBg) {
      candidates.push({
        color: mostCommonColor,
        source: "most-common-visible",
        priority: 12,
        area: maxArea,
      });
    }
    
    try {
      const rootStyle = getComputedStyleCached(document.documentElement);
      
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
          const rawValue = rootStyle.getPropertyValue(varName).trim();
          
          if (rawValue && isValidBackgroundColor(rawValue)) {
            candidates.push({
              color: rawValue,
              source: "css-var:" + varName,
              priority: 8,
            });
          }
        } catch (e) {}
      });
    } catch (e) {}
    
    try {
      const allContainers = document.querySelectorAll("main, article, [role='main'], header, .main, .container");
      const mainContainers = Array.from(allContainers).slice(0, 5);
      mainContainers.forEach(el => {
        try {
          const bg = getComputedStyleCached(el).backgroundColor;
          if (isValidBackgroundColor(bg)) {
            const rect = el.getBoundingClientRect();
            const area = rect.width * rect.height;
            if (area > CONSTANTS.MIN_LARGE_CONTAINER_AREA) {
              const normalized = normalizeColor(bg);
              if (normalized) {
                candidates.push({
                  color: normalized,
                  source: el.tagName.toLowerCase() + "-container",
                  priority: 5,
                  area: area,
                });
              }
            }
          }
        } catch (e) {}
      });
    } catch (e) {}
    
    const seen = new Set();
    const unique = candidates.filter(c => {
      if (!c || !c.color) return false;
      const key = normalizeColor(c.color);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    
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
      errors: errors.length > 0 ? errors : undefined,
    },
  };
})();`;
