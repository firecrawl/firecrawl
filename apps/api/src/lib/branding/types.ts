import { BrandingProfile } from "../../types/branding";

export interface ButtonSnapshot {
  index: number;
  text: string;
  html: string;
  classes: string;
  background: string;
  textColor: string;
  borderColor?: string | null;
  borderRadius?: string;
  borderRadiusCorners?: {
    topLeft?: string;
    topRight?: string;
    bottomRight?: string;
    bottomLeft?: string;
  };
  shadow?: string | null;
  // Debug: original color values before conversion to hex
  originalBackgroundColor?: string;
  originalTextColor?: string;
  originalBorderColor?: string;
}

export interface InputSnapshot {
  type: string;
  placeholder: string;
  label: string;
  name: string;
  required: boolean;
  classes: string;
  background: string;
  textColor: string | null;
  borderColor?: string | null;
  borderRadius?: string;
  borderRadiusCorners?: {
    topLeft?: string;
    topRight?: string;
    bottomRight?: string;
    bottomLeft?: string;
  };
  shadow?: string | null;
}

export interface BrandingLLMInput {
  jsAnalysis: BrandingProfile;
  buttons: ButtonSnapshot[];
  logoCandidates?: Array<{
    src: string;
    alt: string;
    ariaLabel?: string;
    title?: string;
    isSvg: boolean;
    isVisible: boolean;
    location: "header" | "body" | "footer";
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
    logoSvgScore?: number;
  }>;
  brandName?: string;
  /** Full page title (e.g. "AI Innovation Workspace | Miro") — LLM infers brand from this. */
  pageTitle?: string;
  /** Final page URL after redirects — prefer over document.url when available. */
  pageUrl?: string;
  backgroundCandidates?: Array<{
    color: string;
    source: string;
    priority: number;
    area?: number;
  }>;
  screenshot?: string;
  url: string;
  /** Optional header/nav HTML chunk for LLM when no logo candidates (fallback context). */
  headerHtmlChunk?: string;
  /** Favicon URL when available (from page meta/link). */
  favicon?: string | null;
  /** OG image URL when available (meta og:image). */
  ogImage?: string | null;
  /** Heuristic's logo pick (index in the filtered candidate list we send). Ask LLM to confirm or override and explain. */
  heuristicLogoPick?: {
    selectedIndexInFilteredList: number;
    confidence: number;
    reasoning: string;
  };
  teamId?: string;
  teamFlags?: { debugBranding?: boolean } | null;
}

/**
 * Data structure returned by the branding script
 */
export interface BrandingScriptReturn {
  cssData: {
    colors: string[];
    spacings: number[];
    radii: number[];
  };
  snapshots: Array<{
    tag: string;
    classes: string;
    text: string;
    rect: { w: number; h: number };
    colors: {
      text: string;
      background: string;
      border: string;
      borderWidth: number | null;
      borderTop?: string;
      borderTopWidth?: number | null;
      borderRight?: string;
      borderRightWidth?: number | null;
      borderBottom?: string;
      borderBottomWidth?: number | null;
      borderLeft?: string;
      borderLeftWidth?: number | null;
    };
    typography: {
      fontStack: string[];
      size: string | null;
      weight: number | null;
    };
    radius: number | null;
    borderRadius: {
      topLeft: number | null;
      topRight: number | null;
      bottomRight: number | null;
      bottomLeft: number | null;
    };
    shadow: string | null;
    isButton: boolean;
    isNavigation?: boolean;
    hasCTAIndicator?: boolean;
    isInput: boolean;
    inputMetadata?: {
      type: string;
      placeholder: string;
      value: string;
      required: boolean;
      disabled: boolean;
      name: string;
      id: string;
      label: string;
    } | null;
    isLink: boolean;
  }>;
  images: Array<{ type: string; src: string }>;
  logoCandidates?: Array<{
    src: string;
    alt: string;
    ariaLabel?: string;
    title?: string;
    isSvg: boolean;
    isVisible: boolean;
    location: "header" | "body" | "footer";
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
    logoSvgScore?: number;
  }>;
  brandName?: string;
  /** Full page title (e.g. "AI Innovation Workspace | Miro") — LLM can infer brand from this. */
  pageTitle?: string;
  /** Final page URL after redirects (from window.location.href in the script). */
  pageUrl?: string;
  typography: {
    stacks: {
      body: string[];
      heading: string[];
      paragraph: string[];
    };
    sizes: {
      h1: string;
      h2: string;
      body: string;
    };
  };
  frameworkHints: string[];
  colorScheme: "light" | "dark";
  pageBackground?: string | null;
  backgroundCandidates?: Array<{
    color: string;
    source: string;
    priority: number;
    area?: number;
  }>;
}

/**
 * Calculate logo area from position dimensions
 */
export function calculateLogoArea(position?: {
  width?: number;
  height?: number;
}): number {
  if (!position) return 0;
  return (position.width || 0) * (position.height || 0);
}
