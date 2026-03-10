export interface BrandingProfile {
  colorScheme?: "light" | "dark";
  logo?: string | null;
  fonts?: Array<{
    family: string;
    [key: string]: unknown;
  }>;
  colors?: {
    primary?: string;
    secondary?: string;
    accent?: string;
    background?: string;
    textPrimary?: string;
    textSecondary?: string;
    link?: string;
    success?: string;
    warning?: string;
    error?: string;
    [key: string]: string | undefined;
  };
  typography?: {
    fontFamilies?: {
      primary?: string;
      heading?: string;
      code?: string;
      [key: string]: string | undefined;
    };
    fontStacks?: {
      primary?: string[];
      heading?: string[];
      body?: string[];
      paragraph?: string[];
      [key: string]: string[] | undefined;
    };
    fontSizes?: {
      h1?: string;
      h2?: string;
      h3?: string;
      body?: string;
      small?: string;
      [key: string]: string | undefined;
    };
    lineHeights?: {
      heading?: number;
      body?: number;
      [key: string]: number | undefined;
    };
    fontWeights?: {
      light?: number;
      regular?: number;
      medium?: number;
      bold?: number;
      [key: string]: number | undefined;
    };
  };
  spacing?: {
    baseUnit?: number;
    padding?: Record<string, number>;
    margins?: Record<string, number>;
    gridGutter?: number;
    borderRadius?: string;
    [key: string]: number | string | Record<string, number> | undefined;
  };
  components?: {
    buttonPrimary?: {
      background?: string;
      textColor?: string;
      borderColor?: string;
      borderRadius?: string;
      borderRadiusCorners?: {
        topLeft?: string;
        topRight?: string;
        bottomRight?: string;
        bottomLeft?: string;
      };
      shadow?: string;
      [key: string]: string | object | undefined;
    };
    buttonSecondary?: {
      background?: string;
      textColor?: string;
      borderColor?: string;
      borderRadius?: string;
      borderRadiusCorners?: {
        topLeft?: string;
        topRight?: string;
        bottomRight?: string;
        bottomLeft?: string;
      };
      shadow?: string;
      [key: string]: string | object | undefined;
    };
    input?: {
      background?: string;
      textColor?: string;
      borderColor?: string;
      focusBorderColor?: string;
      borderRadius?: string;
      borderRadiusCorners?: {
        topLeft?: string;
        topRight?: string;
        bottomRight?: string;
        bottomLeft?: string;
      };
      shadow?: string;
      [key: string]: string | object | undefined;
    };
    [key: string]: unknown;
  };
  icons?: {
    style?: string;
    primaryColor?: string;
    [key: string]: string | undefined;
  };
  images?: {
    logo?: string | null;
    /** Logo link URL (parent <a href>) when logo is inside a link, e.g. homepage. */
    logoHref?: string | null;
    /** Logo alt text from <img alt> or parent <a aria-label>. */
    logoAlt?: string | null;
    favicon?: string | null;
    ogImage?: string | null;
    [key: string]: string | null | undefined;
  };
  animations?: {
    transitionDuration?: string;
    easing?: string;
    [key: string]: string | undefined;
  };
  layout?: {
    grid?: {
      columns?: number;
      maxWidth?: string;
      [key: string]: number | string | undefined;
    };
    headerHeight?: string;
    footerHeight?: string;
    [key: string]:
      | number
      | string
      | Record<string, number | string | undefined>
      | undefined;
  };
  tone?: {
    voice?: string;
    emojiUsage?: string;
    [key: string]: string | undefined;
  };
  personality?: {
    tone:
      | "professional"
      | "playful"
      | "modern"
      | "traditional"
      | "minimalist"
      | "bold";
    energy: "low" | "medium" | "high";
    targetAudience: string;
  };
  // Debug information (kept for troubleshooting button selection)
  __llm_button_reasoning?: {
    primary: {
      index: number;
      text: string;
      reasoning: string;
    };
    secondary: {
      index: number;
      text: string;
      reasoning: string;
    };
    confidence: number;
  };
  __llm_logo_reasoning?: {
    selectedIndex: number;
    reasoning: string;
    confidence: number;
    rejected?: boolean;
  };
  __llm_metadata?: {
    logoSelection: {
      llmCalled: boolean;
      llmSucceeded: boolean;
      finalSource: "llm" | "heuristic" | "fallback" | "none";
      error?: string;
      /** Exact AI response for logoSelection (before index mapping/heuristic), for debugging */
      rawLogoSelection?: {
        selectedLogoIndex: number;
        selectedLogoReasoning?: string;
        confidence: number;
      };
    };
    buttonClassification: {
      llmCalled: boolean;
      llmSucceeded: boolean;
      error?: string;
    };
  };
  __logo_candidates?: Array<{
    src: string;
    alt: string;
    ariaLabel?: string;
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
  [key: string]: unknown;
}
