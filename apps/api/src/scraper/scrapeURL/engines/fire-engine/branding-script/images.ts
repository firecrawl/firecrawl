import { CONSTANTS } from "./constants";
import {
  getClassNameString,
  getComputedStyleCached,
  recordError,
} from "./helpers";
import { resolveSvgStyles } from "./svg-utils";

interface LogoCandidate {
  src: string;
  alt: string;
  ariaLabel?: string;
  title?: string;
  isSvg: boolean;
  isVisible: boolean;
  location: "header" | "body";
  position: { top: number; left: number; width: number; height: number };
  indicators: {
    inHeader: boolean;
    altMatch: boolean;
    srcMatch: boolean;
    classMatch: boolean;
    hrefMatch: boolean;
  };
  href?: string;
  source: string;
  logoSvgScore: number;
}

interface ImageData {
  type: string;
  src: string;
}

export interface FindImagesResult {
  images: ImageData[];
  logoCandidates: LogoCandidate[];
}

export const findImages = (): FindImagesResult => {
  const imgs: ImageData[] = [];
  const logoCandidates: LogoCandidate[] = [];

  const push = (src: string | undefined | null, type: string): void => {
    if (src) imgs.push({ type, src });
  };

  const querySelectorAllIncludingShadowRoots = (
    selector: string,
  ): Element[] => {
    const results: Element[] = [];
    const seenRoots = new Set<Document | ShadowRoot>();
    function walk(root: Document | ShadowRoot): void {
      if (!root || seenRoots.has(root)) return;
      seenRoots.add(root);
      try {
        const list = root.querySelectorAll(selector);
        list.forEach(el => results.push(el));
        root.querySelectorAll("*").forEach(el => {
          if ((el as Element & { shadowRoot?: ShadowRoot }).shadowRoot) {
            walk((el as Element & { shadowRoot: ShadowRoot }).shadowRoot);
          }
        });
      } catch (_) {
        // Ignore errors
      }
    }
    walk(document);
    return results;
  };

  push(
    (document.querySelector('link[rel*="icon" i]') as HTMLLinkElement | null)
      ?.href,
    "favicon",
  );
  push(
    (
      document.querySelector(
        'meta[property="og:image" i]',
      ) as HTMLMetaElement | null
    )?.content,
    "og",
  );
  push(
    (
      document.querySelector(
        'meta[name="twitter:image" i]',
      ) as HTMLMetaElement | null
    )?.content,
    "twitter",
  );

  const ensureSvgEncoded = (
    url: string | null | undefined,
  ): string | null | undefined => {
    if (!url || !url.startsWith("data:image/svg+xml")) return url;

    const isAlreadyEncoded =
      url.includes("charset=utf-8") ||
      (url.includes("data:image/svg+xml,") &&
        url.split("data:image/svg+xml,")[1]?.startsWith("%"));

    if (isAlreadyEncoded) return url;

    let svgContent = "";
    if (url.includes("charset=utf-8,")) {
      svgContent = url.split("charset=utf-8,")[1];
    } else if (url.includes("data:image/svg+xml,")) {
      svgContent = url.split("data:image/svg+xml,")[1];
    }

    if (!svgContent) return url;

    const cleanSvg = svgContent.replace(/\\"/g, '"').replace(/\\'/g, "'");
    try {
      return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(cleanSvg);
    } catch (e) {
      return (
        "data:image/svg+xml;charset=utf-8," +
        cleanSvg.replace(/"/g, "%22").replace(/'/g, "%27")
      );
    }
  };

  const extractBackgroundImageUrl = (bgImage: string | null): string | null => {
    if (!bgImage || bgImage === "none") return null;

    const decodeHtmlEntities = (url: string): string => {
      if (
        url.includes("&quot;") ||
        url.includes("&lt;") ||
        url.includes("&gt;")
      ) {
        return url
          .replace(/&quot;/g, '"')
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">");
      }
      return url;
    };

    const quotedMatch = bgImage.match(/url\((["'])(.*?)\1\)/);
    if (quotedMatch) {
      const url = decodeHtmlEntities(quotedMatch[2]);
      return ensureSvgEncoded(url) || null;
    }

    const unquotedMatch = bgImage.match(/url\((data:[^)]+)\)/);
    if (unquotedMatch) {
      const url = decodeHtmlEntities(unquotedMatch[1]);
      return ensureSvgEncoded(url) || null;
    }

    const simpleMatch = bgImage.match(/url\(([^)]+?)\)/);
    if (simpleMatch) {
      let url = simpleMatch[1].trim().replace(/^["']|["']$/g, "");
      url = ensureSvgEncoded(url) || url;
      return url;
    }

    return null;
  };

  const isSameBrandHost = (
    currentHostname: string,
    linkHostname: string,
  ): boolean => {
    if (currentHostname === linkHostname) return true;
    const currentLabel = currentHostname.split(".")[0] || "";
    const linkLabel = linkHostname.split(".")[0] || "";
    return (
      currentLabel.length > 1 &&
      linkLabel.length > 1 &&
      currentLabel === linkLabel
    );
  };

  const isHomeHref = (href: string | null): boolean => {
    if (!href) return false;

    const normalizedHref = href.trim();

    if (
      normalizedHref === "./" ||
      normalizedHref === "/" ||
      normalizedHref === "/home" ||
      normalizedHref === "/index" ||
      normalizedHref === ""
    ) {
      return true;
    }

    if (normalizedHref.startsWith("#") || normalizedHref.startsWith("?")) {
      return true;
    }

    if (
      normalizedHref.startsWith("http://") ||
      normalizedHref.startsWith("https://") ||
      normalizedHref.startsWith("//")
    ) {
      try {
        const currentHostname = window.location.hostname.toLowerCase();
        const linkUrl = new URL(href, window.location.origin);
        const linkHostname = linkUrl.hostname.toLowerCase();

        if (!isSameBrandHost(currentHostname, linkHostname)) return false;

        const path = linkUrl.pathname.replace(/\/$/, "") || "/";
        if (
          path === "/" ||
          path === "/home" ||
          path === "/index" ||
          path === "/index.html"
        )
          return true;
        const segments = path.split("/").filter(Boolean);
        if (segments.length === 1) return true;

        return false;
      } catch (e) {
        return false;
      }
    }

    const segments = normalizedHref.split("/").filter(Boolean);
    if (segments.length === 1 && !normalizedHref.includes(".")) return true;

    return false;
  };

  const collectLogoCandidate = (el: Element, source: string): void => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyleCached(el);
    const parentLink = el.closest("a");

    const isVisible =
      rect.width > 0 &&
      rect.height > 0 &&
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      style.opacity !== "0";

    const bgImage = style.getPropertyValue("background-image");
    const bgImageUrl = extractBackgroundImageUrl(bgImage);

    const parentAriaLabel = parentLink?.getAttribute("aria-label") || "";
    const hasLogoAriaLabel = /logo|home|brand/i.test(parentAriaLabel);
    const hasLogoDataAttr =
      el.getAttribute("data-framer-name")?.toLowerCase().includes("logo") ||
      el.getAttribute("data-name")?.toLowerCase().includes("logo");
    const inHeaderNav = el.closest('header, nav, [role="banner"]') !== null;
    const hasHomeHref =
      parentLink && isHomeHref(parentLink.getAttribute("href") || "");

    const elClass = (el.getAttribute("class") || "").toLowerCase();
    if (/minimized/.test(elClass) && inHeaderNav) {
      return;
    }

    const hasBackgroundLogo =
      bgImageUrl &&
      (/logo/i.test(bgImageUrl) ||
        el.closest('[class*="logo" i], [id*="logo" i]') !== null ||
        (el.tagName.toLowerCase() === "a" && inHeaderNav) ||
        (parentLink && inHeaderNav && hasHomeHref) ||
        hasLogoAriaLabel ||
        hasLogoDataAttr ||
        (parentLink && inHeaderNav && /home/i.test(parentAriaLabel)));

    const imgSrc = (el as HTMLImageElement).src || "";
    if (imgSrc) {
      const ogImageSrc =
        document
          .querySelector('meta[property="og:image"]')
          ?.getAttribute("content") || "";
      const twitterImageSrc =
        document
          .querySelector('meta[name="twitter:image"]')
          ?.getAttribute("content") || "";

      const matchesOgOrTwitter =
        (ogImageSrc && imgSrc.includes(ogImageSrc)) ||
        (twitterImageSrc && imgSrc.includes(twitterImageSrc)) ||
        (ogImageSrc && ogImageSrc.includes(imgSrc)) ||
        (twitterImageSrc && twitterImageSrc.includes(imgSrc));

      if (matchesOgOrTwitter) {
        // Don't skip header/nav logos that are also og:image (many sites use logo as og:image)
        const headerNavSelector =
          'header, nav, [role="banner"], #navbar, [id*="navbar" i], #taskbar, [id*="taskbar" i], [role="menubar"]';
        const inHeaderOrNav = el.closest(headerNavSelector) !== null;
        const hasStrongLogoContext =
          (inHeaderOrNav && hasHomeHref) ||
          (inHeaderOrNav && /logo/i.test(imgSrc)) ||
          (inHeaderOrNav &&
            el.closest('[class*="logo" i], [id*="logo" i]') !== null) ||
          /logo/i.test(
            (el.getAttribute("class") || "") + (el.getAttribute("alt") || ""),
          );
        if (!hasStrongLogoContext) {
          return;
        }
      }
    }

    const headerNavSelector =
      'header, nav, [role="banner"], #navbar, [id*="navbar" i], #taskbar, [id*="taskbar" i], [role="menubar"]';
    const inHeader = el.closest(headerNavSelector) !== null;
    const parentInHeader =
      parentLink && parentLink.closest(headerNavSelector) !== null;

    let inTopLevelNav = false;
    if (!inHeader && !parentInHeader) {
      const taskbarOrMenubar = el.closest(
        '#taskbar, [id*="taskbar" i], [role="menubar"]',
      );
      if (taskbarOrMenubar) {
        const barRect = taskbarOrMenubar.getBoundingClientRect();
        if (
          barRect.top <= CONSTANTS.TASKBAR_TOP_THRESHOLD &&
          barRect.width > 0 &&
          barRect.height > 0
        ) {
          inTopLevelNav = true;
        }
      }

      const topLevelContainer = el.closest(
        '[class*="sticky" i], [class*="fixed" i], [style*="position: sticky" i], [style*="position:fixed" i]',
      );
      if (!inTopLevelNav && topLevelContainer) {
        const containerRect = topLevelContainer.getBoundingClientRect();
        const containerStyle = getComputedStyleCached(topLevelContainer);
        const isAtTop = containerRect.top <= CONSTANTS.CONTAINER_TOP_THRESHOLD;
        const hasNavLikeContent =
          topLevelContainer.querySelector('nav, a[href="/"], a[href="./"]') !==
          null;
        const hasStickyOrFixed =
          /sticky|fixed/i.test(containerStyle.position) ||
          /top-0|top:0|top:\s*0/i.test(containerStyle.cssText);

        if (isAtTop && (hasNavLikeContent || hasStickyOrFixed)) {
          inTopLevelNav = true;
        }
      }
    }

    const finalInHeader = inHeader || parentInHeader || inTopLevelNav;

    const isSmallFlagImage =
      rect.width <= 20 &&
      rect.height <= 20 &&
      (el as HTMLImageElement).src &&
      /flag|lang|country/i.test((el as HTMLImageElement).src.toLowerCase());

    const langSwitcherParent = el.closest(
      'ul[class*="lang"], li[class*="lang"], div[class*="lang"], nav[class*="lang"], [id*="lang"], [id*="language"]',
    );

    if (isSmallFlagImage) {
      return;
    }

    if (langSwitcherParent) {
      const parentClasses =
        getClassNameString(langSwitcherParent).toLowerCase();
      const parentTagName = langSwitcherParent.tagName;

      const isLanguageList =
        parentTagName === "UL" && /lang|language/i.test(parentClasses);
      const isLanguageItem =
        parentTagName === "LI" && /lang|language/i.test(parentClasses);
      const isLanguageContainer =
        (parentTagName === "DIV" || parentTagName === "NAV") &&
        /header-lang|lang-switch|language-switch|lang-select|language-select|language-list/i.test(
          parentClasses,
        );
      const hasExplicitLangIndicator =
        /lang-item|language-list|lang-switch|language-switch|lang-select|language-select/i.test(
          parentClasses,
        );

      if (
        isLanguageList ||
        isLanguageItem ||
        isLanguageContainer ||
        hasExplicitLangIndicator
      ) {
        return;
      }
    }

    const insideButton = el.closest(
      'button, [role="button"], input[type="button"], input[type="submit"]',
    );
    if (insideButton) {
      const isLogoInNavContext =
        finalInHeader && (hasHomeHref || hasLogoAriaLabel || hasLogoDataAttr);

      const inTaskbarOrMenubar = el.closest(
        '#taskbar, [id*="taskbar" i], [role="menubar"]',
      );
      const isLogoInTopBar =
        inTaskbarOrMenubar &&
        rect.top <= CONSTANTS.TASKBAR_LOGO_MAX_TOP &&
        rect.left <= CONSTANTS.TASKBAR_LOGO_MAX_LEFT &&
        rect.width >= CONSTANTS.TASKBAR_LOGO_MIN_WIDTH &&
        rect.height >= CONSTANTS.TASKBAR_LOGO_MIN_HEIGHT;

      const buttonHasLogoIndicators =
        insideButton &&
        (/logo|brand/i.test(getClassNameString(insideButton)) ||
          /logo|brand/i.test(
            insideButton.getAttribute("data-framer-name") || "",
          ) ||
          /logo|brand/i.test(insideButton.getAttribute("data-name") || "") ||
          /logo|home|brand/i.test(
            insideButton.getAttribute("aria-label") || "",
          ));

      const elementHasLogoIndicators =
        /logo|brand/i.test(el.getAttribute("alt") || "") ||
        /logo|brand/i.test(el.getAttribute("aria-label") || "");

      if (
        !isLogoInNavContext &&
        !isLogoInTopBar &&
        !buttonHasLogoIndicators &&
        !elementHasLogoIndicators
      ) {
        return;
      }
    }

    const elementClasses = getClassNameString(el).toLowerCase();
    const elementId = (el.id || "").toLowerCase();
    const ariaLabel = (el.getAttribute?.("aria-label") || "").toLowerCase();

    const hasSearchClass = /search|magnif/i.test(elementClasses);
    const hasSearchId = /search|magnif/i.test(elementId);
    const hasSearchAriaLabel = /search/i.test(ariaLabel);

    const parent = el.parentElement;
    const isInSearchForm =
      parent &&
      ((parent.tagName === "FORM" &&
        /search/i.test(getClassNameString(parent) + (parent.id || ""))) ||
        (parent.matches &&
          parent.matches(
            'form[class*="search"], form[id*="search"], button[class*="search"], button[id*="search"], [role="search"]',
          )));

    const inSearchButton = el.closest(
      'button[class*="search"], button[id*="search"], a[class*="search"], a[id*="search"]',
    );

    const isSearchIcon =
      hasSearchClass ||
      hasSearchId ||
      hasSearchAriaLabel ||
      isInSearchForm ||
      !!inSearchButton;

    if (isSearchIcon) {
      return;
    }

    const isUIIcon =
      /icon|menu|hamburger|bars|close|times|cart|user|account|profile|settings|notification|bell|chevron|arrow|caret|dropdown/i.test(
        elementClasses,
      ) ||
      /icon|menu|hamburger|cart|user|bell/i.test(elementId) ||
      /menu|close|cart|user|settings/i.test(ariaLabel);

    if (isUIIcon) {
      const parentLinkForLogo = el.closest("a");
      const parentDataNav = parentLinkForLogo?.getAttribute("data-nav") || "";
      const parentDataGaName =
        parentLinkForLogo?.getAttribute("data-ga-name") || "";
      const parentLinkAriaLabel =
        parentLinkForLogo?.getAttribute("aria-label") || "";
      const parentLinkHref = parentLinkForLogo?.getAttribute("href") || "";

      const hasExplicitLogoIndicator =
        /logo|brand|site-name|site-title/i.test(elementClasses) ||
        /logo|brand/i.test(elementId) ||
        /logo|brand/i.test(parentDataNav) ||
        /logo|brand/i.test(parentDataGaName) ||
        /\bhome\b/i.test(parentLinkAriaLabel) ||
        isHomeHref(parentLinkHref);

      if (!hasExplicitLogoIndicator) {
        return;
      }
    }

    const elAlt = (
      el.getAttribute?.("alt") ||
      (el as HTMLImageElement).alt ||
      ""
    ).toLowerCase();
    if (
      /mobile menu|hamburger|toggle navigation|menu open|menu close|close-mobile|hamburger-img/i.test(
        elAlt,
      )
    ) {
      return;
    }

    const anchorParent = el.closest("a");
    const href = anchorParent ? anchorParent.getAttribute("href") || "" : "";
    const anchorAriaLabel = (
      anchorParent?.getAttribute("aria-label") || ""
    ).toLowerCase();
    const ariaLabelHomeMatch =
      /\bhome(page)?\b/.test(ariaLabel) ||
      /\bhome(page)?\b/.test(anchorAriaLabel);
    const candidateAriaLabel = ariaLabel || anchorAriaLabel || "";

    if (href && href.trim()) {
      const hrefLower = href.toLowerCase().trim();

      const isExternalLink =
        hrefLower.startsWith("http://") ||
        hrefLower.startsWith("https://") ||
        hrefLower.startsWith("//");

      if (isExternalLink) {
        const externalServiceDomains = [
          "github.com",
          "twitter.com",
          "x.com",
          "facebook.com",
          "linkedin.com",
          "instagram.com",
          "youtube.com",
          "discord.com",
          "slack.com",
          "npmjs.com",
          "pypi.org",
          "crates.io",
          "packagist.org",
          "badge.fury.io",
          "shields.io",
          "img.shields.io",
          "badgen.net",
          "codecov.io",
          "coveralls.io",
          "circleci.com",
          "travis-ci.org",
          "app.netlify.com",
          "vercel.com",
        ];

        try {
          const currentHostname = window.location.hostname.toLowerCase();
          const linkUrl = new URL(href, window.location.origin);
          const linkHostname = linkUrl.hostname.toLowerCase();
          const isSameSite = isSameBrandHost(currentHostname, linkHostname);
          if (
            !isSameSite &&
            externalServiceDomains.some(domain => hrefLower.includes(domain))
          ) {
            return;
          }

          if (!isSameSite) {
            return;
          }
        } catch (e) {
          return;
        }
      }
    }

    const isSvg = el.tagName.toLowerCase() === "svg";

    let logoSvgScore = 0;
    if (isSvg) {
      const svgWidth =
        rect.width || parseFloat(el.getAttribute("width") || "0") || 0;
      const svgHeight =
        rect.height || parseFloat(el.getAttribute("height") || "0") || 0;

      const hasTextElements = el.querySelector("text") !== null;
      if (hasTextElements) {
        logoSvgScore -= 50;
      }

      const hasAnimations =
        el.querySelector("animate, animateTransform, animateMotion") !== null;
      if (hasAnimations) {
        logoSvgScore += 30;
      }

      const pathCount = el.querySelectorAll("path").length;
      const groupCount = el.querySelectorAll("g").length;
      logoSvgScore += Math.min(pathCount * 2, 40);
      logoSvgScore += Math.min(groupCount, 20);

      const area = svgWidth * svgHeight;
      if (area > 10000) logoSvgScore += 20;
      else if (area > 5000) logoSvgScore += 10;
      else if (area < 1000) logoSvgScore -= 20;

      if (svgWidth > 0 && svgHeight > 0) {
        const aspectRatio =
          Math.max(svgWidth, svgHeight) / Math.min(svgWidth, svgHeight);
        if (aspectRatio < 1.5) logoSvgScore += 10;
        else if (aspectRatio > 5) logoSvgScore -= 15;
      }

      if (
        pathCount > 0 &&
        pathCount < 20 &&
        groupCount === 0 &&
        !hasAnimations
      ) {
        logoSvgScore -= 30;
      }
    }

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
      altMatch =
        /logo/i.test(svgId) ||
        /logo/i.test(svgAriaLabel) ||
        /logo/i.test(svgTitle);
      classMatch = /logo/i.test(svgClass);
      srcMatch = el.closest('[class*="logo" i], [id*="logo" i]') !== null;
    } else {
      const imgId = el.id || "";
      const parentLinkForAlt = el.closest("a");
      alt =
        ((el as HTMLImageElement).alt && (el as HTMLImageElement).alt.trim()) ||
        (parentLinkForAlt?.getAttribute("aria-label") || "").trim() ||
        "";

      const idMatch = /logo/i.test(imgId);
      srcMatch =
        ((el as HTMLImageElement).src
          ? /logo/i.test((el as HTMLImageElement).src)
          : false) || idMatch;
      altMatch = /logo/i.test(alt);

      const imgClass = getClassNameString(el);
      classMatch =
        /logo/i.test(imgClass) ||
        el.closest('[class*="logo" i], [id*="logo" i]') !== null ||
        idMatch;
    }

    let src = "";

    if (isSvg) {
      const imageEl = el.querySelector("image");
      const imageHref =
        imageEl?.getAttribute("href") ||
        imageEl?.getAttribute("xlink:href") ||
        "";
      if (imageHref) {
        try {
          src = new URL(imageHref, window.location.origin).href;
        } catch (e) {
          src = imageHref;
        }
        if (!srcMatch) srcMatch = /logo/i.test(imageHref);
      }

      if (!src) {
        try {
          const resolvedSvg = resolveSvgStyles(el as SVGSVGElement);
          const serializer = new XMLSerializer();
          src =
            "data:image/svg+xml;utf8," +
            encodeURIComponent(serializer.serializeToString(resolvedSvg));
        } catch (e) {
          recordError("resolveSvgStyles", e);
          try {
            const serializer = new XMLSerializer();
            src =
              "data:image/svg+xml;utf8," +
              encodeURIComponent(serializer.serializeToString(el));
          } catch (e2) {
            recordError("XMLSerializer fallback", e2);
            const parentLinkForSvg = el.closest("a");
            const parentAria = (
              parentLinkForSvg?.getAttribute("aria-label") || ""
            ).toLowerCase();
            const inHeaderNavForSvg =
              el.closest(
                'header, nav, [role="banner"], #navbar, [id*="navbar" i], #taskbar, [id*="taskbar" i], [role="menubar"]',
              ) !== null;
            const strongLogoCandidate =
              inHeaderNavForSvg &&
              parentLinkForSvg &&
              /logo|homepage|home\s*page/i.test(parentAria);
            if (strongLogoCandidate) {
              try {
                const raw = el.cloneNode(true);
                const serializer = new XMLSerializer();
                src =
                  "data:image/svg+xml;utf8," +
                  encodeURIComponent(serializer.serializeToString(raw));
              } catch (e3) {
                recordError("svg-strong-candidate-serialize", e3);
                return;
              }
            } else {
              return;
            }
          }
        }
      }
    } else {
      src = (el as HTMLImageElement).src || "";

      if (!src && bgImageUrl) {
        const shouldTreatAsLogo =
          hasBackgroundLogo ||
          hasLogoDataAttr ||
          hasLogoAriaLabel ||
          hasHomeHref ||
          (parentLink && inHeaderNav);

        if (shouldTreatAsLogo) {
          if (bgImageUrl.startsWith("data:")) {
            src = bgImageUrl;
          } else {
            try {
              const url = new URL(bgImageUrl, window.location.origin);
              src = url.href;
            } catch (e) {
              if (bgImageUrl.startsWith("/")) {
                src = window.location.origin + bgImageUrl;
              } else if (
                bgImageUrl.startsWith("http://") ||
                bgImageUrl.startsWith("https://")
              ) {
                src = bgImageUrl;
              } else {
                src = window.location.origin + "/" + bgImageUrl;
              }
            }
          }

          if (!srcMatch)
            srcMatch = /logo/i.test(bgImageUrl) || !!hasLogoDataAttr;
          if (!classMatch)
            classMatch =
              el.closest('[class*="logo" i], [id*="logo" i]') !== null ||
              !!hasLogoDataAttr;
          if (!altMatch && hasLogoAriaLabel) {
            altMatch = true;
            alt = parentAriaLabel;
          }
        }
      }
    }

    if (href) {
      const normalizedHref = href.toLowerCase().trim();

      hrefMatch =
        normalizedHref === "/" ||
        normalizedHref === "/home" ||
        normalizedHref === "/index" ||
        normalizedHref === "" ||
        normalizedHref === "./";

      if (
        !hrefMatch &&
        (normalizedHref.startsWith("http://") ||
          normalizedHref.startsWith("https://") ||
          normalizedHref.startsWith("//"))
      ) {
        try {
          const currentHostname = window.location.hostname.toLowerCase();
          const linkUrl = new URL(href, window.location.origin);
          const linkHostname = linkUrl.hostname.toLowerCase();

          if (
            isSameBrandHost(currentHostname, linkHostname) &&
            (linkUrl.pathname === "/" ||
              linkUrl.pathname === "/home" ||
              linkUrl.pathname === "/index.html")
          ) {
            hrefMatch = true;
          }
        } catch (e) {
          // Ignore
        }
      }
    }
    if (!hrefMatch && ariaLabelHomeMatch) {
      hrefMatch = true;
    }
    if (!hrefMatch && hasHomeHref && (hasLogoDataAttr || hasLogoAriaLabel)) {
      hrefMatch = true;
    }

    if (src) {
      const isSvgDataUri = src.startsWith("data:image/svg+xml");
      const finalIsSvg = isSvg || isSvgDataUri;

      const title = finalIsSvg
        ? el.querySelector?.("title")?.textContent?.trim() || undefined
        : el.getAttribute?.("title") ||
          ((el as HTMLImageElement).title !== undefined &&
          (el as HTMLImageElement).title !== ""
            ? (el as HTMLImageElement).title
            : undefined);

      let posWidth = rect.width;
      let posHeight = rect.height;
      if (posWidth <= 0 || posHeight <= 0) {
        const attrW = el.getAttribute?.("width");
        const attrH = el.getAttribute?.("height");
        const w = attrW != null ? parseFloat(attrW) : NaN;
        const h = attrH != null ? parseFloat(attrH) : NaN;
        if (w > 0) posWidth = w;
        if (h > 0) posHeight = h;
        if (
          (posWidth <= 0 || posHeight <= 0) &&
          finalIsSvg &&
          el.getAttribute?.("viewBox")
        ) {
          const vb = el
            .getAttribute("viewBox")!
            .trim()
            .split(/[\s,]+/);
          if (vb.length >= 4) {
            const vw = parseFloat(vb[2]);
            const vh = parseFloat(vb[3]);
            if (vw > 0 && !Number.isNaN(vw))
              posWidth = posWidth <= 0 ? vw : posWidth;
            if (vh > 0 && !Number.isNaN(vh))
              posHeight = posHeight <= 0 ? vh : posHeight;
          }
        }
      }

      const actuallyVisible = isVisible && rect.width > 0 && rect.height > 0;
      const positionTop = rect.width > 0 && rect.height > 0 ? rect.top : 0;
      const positionLeft = rect.width > 0 && rect.height > 0 ? rect.left : 0;

      const logoCandidate: LogoCandidate = {
        src,
        alt,
        ariaLabel: candidateAriaLabel || undefined,
        title: title || undefined,
        isSvg: finalIsSvg,
        isVisible: actuallyVisible,
        location: finalInHeader ? "header" : "body",
        position: {
          top: positionTop,
          left: positionLeft,
          width: posWidth,
          height: posHeight,
        },
        indicators: {
          inHeader: !!finalInHeader,
          altMatch,
          srcMatch,
          classMatch,
          hrefMatch,
        },
        href: href || undefined,
        source,
        logoSvgScore: finalIsSvg ? (isSvgDataUri ? 80 : logoSvgScore) : 100,
      };

      logoCandidates.push(logoCandidate);
    }
  };

  const allLogoSelectors = [
    "header a img, header a svg, header img, header svg",
    "[class*='theme-site-logo' i] img, [class*='elementor-widget-theme-site-logo' i] img",
    "header a > svg, nav a > svg",
    '[class*="header" i] a img, [class*="header" i] a svg, [class*="header" i] img, [class*="header" i] svg',
    '[id*="header" i] a img, [id*="header" i] a svg, [id*="header" i] img, [id*="header" i] svg',
    "nav a img, nav a svg, nav img, nav svg",
    '[role="banner"] a img, [role="banner"] a svg, [role="banner"] img, [role="banner"] svg',
    'a[aria-label*="logo" i] > svg, a[aria-label*="homepage" i] > svg',
    "#navbar a img, #navbar a svg, #navbar img, #navbar svg",
    '[id*="navbar" i] a img, [id*="navbar" i] a svg, [id*="navbar" i] img, [id*="navbar" i] svg',
    '[id*="navigation" i] a img, [id*="navigation" i] a svg, [id*="navigation" i] img, [id*="navigation" i] svg',
    '[class*="navbar" i] a img, [class*="navbar" i] a svg, [class*="navbar" i] img, [class*="navbar" i] svg',
    '[class*="globalnav" i] a img, [class*="globalnav" i] a svg, [class*="globalnav" i] img, [class*="globalnav" i] svg',
    '[class*="nav-wrapper" i] a img, [class*="nav-wrapper" i] a svg, [class*="nav-wrapper" i] img, [class*="nav-wrapper" i] svg',
    'a[data-nav*="logo" i] img, a[data-nav*="logo" i] svg',
    'a[data-tracking-type*="logo" i] img, a[data-tracking-type*="logo" i] svg',
    'a[data-ga-name*="logo" i] img, a[data-ga-name*="logo" i] svg',
    'a[class*="logo" i] img, a[class*="logo" i] svg',
    'a[data-qa*="logo" i] img, a[data-qa*="logo" i] svg',
    'a[aria-label*="logo" i] img, a[aria-label*="logo" i] svg',
    '[class*="header-logo" i] img, [class*="header-logo" i] svg',
    '[class*="container-logo" i] a img, [class*="container-logo" i] a svg',
    '[class*="logo" i] img, [class*="logo" i] svg',
    '[id*="logo" i] img, [id*="logo" i] svg',
    'img[class*="nav-logo" i], svg[class*="nav-logo" i]',
    'img[class*="logo" i], svg[class*="logo" i]',
    'a[href="/"] svg, a[href="./"] svg',
    'a[href="/"] img, a[href="./"] img',
    "#taskbar svg, #taskbar img",
    '[id*="taskbar" i] svg, [id*="taskbar" i] img',
    '[role="menubar"] svg, [role="menubar"] img',
  ];

  allLogoSelectors.forEach(selector => {
    const matches = querySelectorAllIncludingShadowRoots(selector);
    matches.forEach(el => {
      collectLogoCandidate(el, selector);
    });
  });

  const logoContainerSelectors = [
    '[class*="logo" i] a',
    '[id*="logo" i] a',
    'header a[class*="logo" i]',
    'header [class*="logo" i] a',
    'nav a[class*="logo" i]',
    'nav [class*="logo" i] a',
    "header a > div",
    "header a > span",
    "nav a > div",
    "nav a > span",
    '[role="banner"] a > div',
    '[role="banner"] a > span',
    'a[aria-label*="logo" i] > div',
    'a[aria-label*="logo" i] > span',
    'a[aria-label*="home" i] > div',
    'a[aria-label*="home" i] > span',
    'a[href="./"] > div',
    'a[href="./"] > span',
    'a[href="/"] > div',
    'a[href="/"] > span',
    'a[href="/home"] > div',
    'a[href="/home"] > span',
    'a[aria-label*="home" i] div[data-framer-name*="logo" i]',
    'a[aria-label*="home" i] span[data-framer-name*="logo" i]',
    'a[href="./"] div[data-framer-name*="logo" i]',
    'a[href="./"] span[data-framer-name*="logo" i]',
    'a[href="/"] div[data-framer-name*="logo" i]',
    'a[href="/"] span[data-framer-name*="logo" i]',
    'div[data-framer-name*="logo" i]',
    'span[data-framer-name*="logo" i]',
    'div[data-name*="logo" i]',
    'span[data-name*="logo" i]',
    '[class*="logo" i][class*="shape" i]',
    '[class*="logo" i][class*="icon" i]',
    'nav [class*="logo" i]',
    'header [class*="logo" i]',
    '[role="banner"] [class*="logo" i]',
  ];

  logoContainerSelectors.forEach(selector => {
    const matches = querySelectorAllIncludingShadowRoots(selector);
    matches.forEach(el => {
      const style = getComputedStyleCached(el);
      const bgImage = style.getPropertyValue("background-image");
      const bgImageUrl = extractBackgroundImageUrl(bgImage);

      const elClassName =
        (typeof el.className === "string"
          ? el.className
          : el.getAttribute("class")) || "";
      const elHasLogoClass = /logo/i.test(elClassName);

      if (bgImageUrl) {
        const rect = el.getBoundingClientRect();
        const isVisible =
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          style.opacity !== "0";
        const hasReasonableSize =
          rect.width >= CONSTANTS.MIN_LOGO_SIZE &&
          rect.height >= CONSTANTS.MIN_LOGO_SIZE;
        const inLogoContext =
          el.closest(
            '[class*="logo" i], [id*="logo" i], header, nav, [role="banner"]',
          ) !== null;

        const parentLink = el.closest("a");
        const hasLogoDataAttr =
          el.getAttribute("data-framer-name")?.toLowerCase().includes("logo") ||
          el.getAttribute("data-name")?.toLowerCase().includes("logo");
        const hasLogoAriaLabel =
          parentLink &&
          /logo|home|brand/i.test(parentLink.getAttribute("aria-label") || "");
        const hasHomeHrefCheck =
          parentLink && isHomeHref(parentLink.getAttribute("href") || "");

        const hasStrongLogoIndicators =
          elHasLogoClass ||
          hasLogoDataAttr ||
          hasLogoAriaLabel ||
          hasHomeHrefCheck;
        const sizeRequirement = hasStrongLogoIndicators
          ? rect.width > 0 && rect.height > 0
          : hasReasonableSize;

        if (
          isVisible &&
          sizeRequirement &&
          (inLogoContext || hasStrongLogoIndicators)
        ) {
          collectLogoCandidate(el, "background-image-logo");
        }
      }
    });
  });

  const allElementsWithBg = Array.from(document.querySelectorAll("div, span"));

  const allDivsWithBgImage = allElementsWithBg.filter(el => {
    const style = getComputedStyleCached(el);
    const bgImage = style.getPropertyValue("background-image");
    const bgImageUrl = extractBackgroundImageUrl(bgImage);

    if (!bgImageUrl) return false;

    const className = el.className || "";
    const parentLink = el.closest("a");

    const hasLogoDataAttr =
      el.getAttribute("data-framer-name")?.toLowerCase().includes("logo") ||
      el.getAttribute("data-name")?.toLowerCase().includes("logo");
    const hasLogoClass = (typeof className === "string" ? className : "")
      .toLowerCase()
      .includes("logo");
    const hasLogoAriaLabel =
      parentLink &&
      /logo|home|brand/i.test(parentLink.getAttribute("aria-label") || "");
    const hasHomeHrefCheck =
      parentLink && isHomeHref(parentLink.getAttribute("href") || "");
    const inHeaderNavCheck =
      el.closest('header, nav, [role="banner"]') !== null;

    return (
      hasLogoDataAttr ||
      hasLogoClass ||
      (hasLogoAriaLabel && hasHomeHrefCheck) ||
      (hasLogoAriaLabel && inHeaderNavCheck) ||
      (hasHomeHrefCheck && inHeaderNavCheck)
    );
  });

  allDivsWithBgImage.forEach(el => {
    const rect = el.getBoundingClientRect();
    const alreadyCollected = logoCandidates.some(c => {
      return (
        Math.abs(c.position.top - rect.top) < 1 &&
        Math.abs(c.position.left - rect.left) < 1 &&
        Math.abs(c.position.width - rect.width) < 1 &&
        Math.abs(c.position.height - rect.height) < 1
      );
    });
    if (!alreadyCollected) {
      collectLogoCandidate(el, "background-image-logo-indicators");
    }
  });

  const excludeSelectors =
    '[class*="testimonial"], [class*="client"], [class*="partner"], [class*="customer"], [class*="case-study"], [id*="testimonial"], [id*="client"], [id*="partner"], [id*="customer"], [id*="case-study"], footer, [class*="footer"]';

  const allImages = querySelectorAllIncludingShadowRoots("img");
  allImages.forEach(img => {
    if (
      /logo/i.test((img as HTMLImageElement).alt || "") ||
      /logo/i.test((img as HTMLImageElement).src) ||
      img.closest('[class*="logo" i]')
    ) {
      if (!img.closest(excludeSelectors)) {
        collectLogoCandidate(img, "document.images");
      }
    }
  });

  const allSvgs = querySelectorAllIncludingShadowRoots("svg");
  allSvgs.forEach(svg => {
    const svgRect = svg.getBoundingClientRect();
    const alreadyCollected = logoCandidates.some(c => {
      if (!c.isSvg) return false;
      return (
        Math.abs(c.position.top - svgRect.top) < 1 &&
        Math.abs(c.position.left - svgRect.left) < 1 &&
        Math.abs(c.position.width - svgRect.width) < 1 &&
        Math.abs(c.position.height - svgRect.height) < 1
      );
    });
    if (alreadyCollected) {
      return;
    }

    const insideButton = svg.closest(
      'button, [role="button"], input[type="button"], input[type="submit"]',
    );
    if (insideButton) {
      const inTaskbarOrMenubar = svg.closest(
        '#taskbar, [id*="taskbar" i], [role="menubar"]',
      );
      const isTopBarLogo =
        inTaskbarOrMenubar &&
        svgRect.top <= CONSTANTS.TASKBAR_LOGO_MAX_TOP &&
        svgRect.left <= CONSTANTS.TASKBAR_LOGO_MAX_LEFT &&
        svgRect.width >= CONSTANTS.TASKBAR_LOGO_MIN_WIDTH &&
        svgRect.height >= CONSTANTS.TASKBAR_LOGO_MIN_HEIGHT;
      if (!isTopBarLogo) {
        return;
      }
    }

    const svgId = svg.id || "";
    const svgClass = getClassNameString(svg);
    const svgAriaLabel = svg.getAttribute("aria-label") || "";
    const svgTitle = svg.querySelector("title")?.textContent || "";

    const hasSearchId = /search|magnif/i.test(svgId);
    const hasSearchClass = /search|magnif/i.test(svgClass);
    const hasSearchAriaLabel = /search/i.test(svgAriaLabel);
    const hasSearchTitle = /search/i.test(svgTitle);

    const parent = svg.parentElement;
    const isInSearchForm =
      parent &&
      ((parent.tagName === "FORM" &&
        /search/i.test(getClassNameString(parent) + (parent.id || ""))) ||
        (parent.matches &&
          parent.matches(
            'form[class*="search"], form[id*="search"], button[class*="search"], button[id*="search"], [role="search"]',
          )));

    const inSearchButton = svg.closest(
      'button[class*="search"], button[id*="search"], a[class*="search"], a[id*="search"]',
    );

    const isSearchIcon =
      hasSearchId ||
      hasSearchClass ||
      hasSearchAriaLabel ||
      hasSearchTitle ||
      isInSearchForm ||
      !!inSearchButton;

    if (isSearchIcon) {
      return;
    }

    const isUIIcon =
      /icon|menu|hamburger|bars|close|times|cart|user|account|profile|settings|notification|bell|chevron|arrow|caret|dropdown/i.test(
        svgClass,
      ) ||
      /icon|menu|hamburger|cart|user|bell/i.test(svgId) ||
      /menu|close|cart|user|settings/i.test(svgAriaLabel);

    const hasLogoId = /logo/i.test(svgId);
    const hasLogoClass = /logo/i.test(svgClass);
    const hasLogoAriaLabel = /logo/i.test(svgAriaLabel);
    const hasLogoTitle = /logo/i.test(svgTitle);
    const inHeaderNav = svg.closest(
      'header, nav, [role="banner"], #navbar, [id*="navbar" i], #taskbar, [id*="taskbar" i], [role="menubar"]',
    );
    const inLogoContainer = svg.closest('[class*="logo" i], [id*="logo" i]');
    const inHeaderNavArea = !!inHeaderNav;
    const inAnchorInHeader = svg.closest("a") && inHeaderNav;

    if (isUIIcon) {
      const hasExplicitLogoIndicator =
        hasLogoId ||
        hasLogoClass ||
        hasLogoAriaLabel ||
        hasLogoTitle ||
        inLogoContainer;
      if (!hasExplicitLogoIndicator) {
        return;
      }
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
      if (!svg.closest(excludeSelectors)) {
        collectLogoCandidate(svg, "document.querySelectorAll(svg)");
      }
    }
  });

  const homeLinks = querySelectorAllIncludingShadowRoots("a[href]").filter(a =>
    isHomeHref(a.getAttribute("href") || ""),
  );
  const fallbackCandidates: Array<{ el: Element; top: number; left: number }> =
    [];
  homeLinks.forEach(link => {
    const imgs = link.querySelectorAll("img, svg");
    imgs.forEach(el => {
      const rect = el.getBoundingClientRect();
      const inTop = rect.top >= 0 && rect.top < CONSTANTS.TOP_PAGE_THRESHOLD_PX;
      const hasSize = rect.width > 0 && rect.height > 0;
      if (inTop && hasSize)
        fallbackCandidates.push({ el, top: rect.top, left: rect.left });
    });
  });
  fallbackCandidates.sort((a, b) => a.top - b.top || a.left - b.left);
  fallbackCandidates.forEach(({ el }) =>
    collectLogoCandidate(el, "fallback-top-home-link"),
  );

  const isHomeLinkSource = (c: LogoCandidate): boolean =>
    typeof c.source === "string" &&
    (c.source.indexOf('href="/"') !== -1 ||
      c.source.indexOf('href="./"') !== -1 ||
      c.source === "fallback-top-home-link");

  const bySrc = new Map<string, LogoCandidate>();
  logoCandidates.forEach(candidate => {
    const existing = bySrc.get(candidate.src);
    if (!existing) {
      bySrc.set(candidate.src, candidate);
      return;
    }
    const candidateFromHomeLink = isHomeLinkSource(candidate);
    const existingFromHomeLink = isHomeLinkSource(existing);
    if (candidateFromHomeLink && !existingFromHomeLink) {
      bySrc.set(candidate.src, candidate);
      return;
    }
    if (!candidateFromHomeLink && existingFromHomeLink) {
      return;
    }
    const candidateVisible = !!candidate.isVisible;
    const existingVisible = !!existing.isVisible;
    if (candidateVisible && !existingVisible) {
      bySrc.set(candidate.src, candidate);
      return;
    }
    if (!candidateVisible && existingVisible) {
      return;
    }
    const area =
      (candidate.position.width || 0) * (candidate.position.height || 0);
    const existingArea =
      (existing.position.width || 0) * (existing.position.height || 0);
    if (area > existingArea) {
      bySrc.set(candidate.src, candidate);
    }
  });
  const uniqueCandidates = Array.from(bySrc.values());

  let candidatesToPick = uniqueCandidates.filter(c => c.isVisible);
  if (candidatesToPick.length === 0 && uniqueCandidates.length > 0) {
    candidatesToPick = uniqueCandidates;
  }

  if (candidatesToPick.length > 0) {
    const best = candidatesToPick.reduce<LogoCandidate | null>(
      (best, candidate) => {
        if (!best) return candidate;

        const candidateHomeLinkImg =
          !candidate.isSvg &&
          !!candidate.indicators.hrefMatch &&
          (candidate.indicators.inHeader || isHomeLinkSource(candidate));
        const bestHomeLinkImg =
          !best.isSvg &&
          !!best.indicators.hrefMatch &&
          (best.indicators.inHeader || isHomeLinkSource(best));
        if (candidateHomeLinkImg && !bestHomeLinkImg) return candidate;
        if (!candidateHomeLinkImg && bestHomeLinkImg) return best;

        const candidateArea =
          candidate.position.width * candidate.position.height;
        const bestArea = best.position.width * best.position.height;
        const candidateIsTiny = candidateArea < CONSTANTS.MIN_SIGNIFICANT_AREA;
        const bestIsTiny = bestArea < CONSTANTS.MIN_SIGNIFICANT_AREA;

        if (candidateIsTiny && !bestIsTiny) return best;
        if (!candidateIsTiny && bestIsTiny) return candidate;

        if (!candidate.isSvg && best.isSvg) return candidate;
        if (candidate.isSvg && !best.isSvg) return best;

        if (candidate.isSvg && best.isSvg) {
          const candidateScore = candidate.logoSvgScore || 0;
          const bestScore = best.logoSvgScore || 0;
          if (candidateScore > bestScore) return candidate;
          if (candidateScore < bestScore) return best;
        }

        if (candidate.indicators.inHeader && !best.indicators.inHeader)
          return candidate;
        if (!candidate.indicators.inHeader && best.indicators.inHeader)
          return best;

        if (candidate.indicators.hrefMatch && !best.indicators.hrefMatch)
          return candidate;
        if (!candidate.indicators.hrefMatch && best.indicators.hrefMatch)
          return best;

        if (candidate.indicators.classMatch && !best.indicators.classMatch)
          return candidate;
        if (!candidate.indicators.classMatch && best.indicators.classMatch)
          return best;

        const candidateTooSmall =
          candidate.position.width < CONSTANTS.MIN_LOGO_SIZE ||
          candidate.position.height < CONSTANTS.MIN_LOGO_SIZE;
        const bestTooSmall =
          best.position.width < CONSTANTS.MIN_LOGO_SIZE ||
          best.position.height < CONSTANTS.MIN_LOGO_SIZE;

        if (candidateTooSmall && !bestTooSmall) return best;
        if (!candidateTooSmall && bestTooSmall) return candidate;

        return candidate.position.top < best.position.top ? candidate : best;
      },
      null,
    );

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
