import type {
  ChoiceResponse,
  JsonValue,
  NoulResponse,
  Question,
  SystemOneResult,
} from "@typesafe-ai/sdk";
import { formatHex, hsl, parse } from "culori";

import { config } from "../../config";
import { setSpanAttributes, SpanKind, withSpan } from "../otel-tracer";
import { sampled } from "../rollout";
import { getTypeSafeClient } from "../typesafe";
import { BrandingEnhancement } from "./schema";
import { BrandingLLMInput } from "./types";

// TypeSafe's System One API: https://docs.typesafe.ai/api
// Jev answers typed questions (choice / noul) about a `state` in one call and
// returns calibrated probabilities. It cannot generate text, so every branding
// decision is posed as a pick from options built here, and the answers are
// mapped back onto the same BrandingEnhancement the gpt-4o call returns.
const JEV_MODEL = "jev-latest";
// https://docs.typesafe.ai/models (2026-09-28): $0.042 per million input
// tokens, output tokens are not billed.
const JEV_INPUT_USD_PER_MTOK = 0.042;
const DEFAULT_TIMEOUT_MS = 5000;

// Circuit breaker: after this many calls in a row fail (timeouts, 5xx), skip
// Jev for the cooldown and answer with the LLM, so an outage doesn't add the
// timeout to every branding request. After the cooldown calls go through
// again; one more failure reopens it.
const BREAKER_FAILURES = 5;
const BREAKER_COOLDOWN_MS = 60_000;
let consecutiveFailures = 0;
let breakerOpenUntil = 0;

export function isJevBreakerOpen(now = Date.now()): boolean {
  return now < breakerOpenUntil;
}

function recordJevFailure(input: BrandingLLMInput): void {
  consecutiveFailures++;
  if (consecutiveFailures >= BREAKER_FAILURES && !isJevBreakerOpen()) {
    breakerOpenUntil = Date.now() + BREAKER_COOLDOWN_MS;
    input.logger.warn("Jev branding calls failing, using the LLM for a while", {
      consecutiveFailures,
      cooldownMs: BREAKER_COOLDOWN_MS,
    });
  }
}

export function resetJevBreaker(): void {
  consecutiveFailures = 0;
  breakerOpenUntil = 0;
}

const MAX_LOGOS = 20;
const MAX_BUTTONS = 12;
const MAX_COLORS = 24;
const MAX_FONTS = 8;

const NONE = "none";
// Below this a color role keeps the heuristic value.
const ROLE_MIN_CONFIDENCE = 0.35;

type ChoiceAnswer = ChoiceResponse;
type Answer = ChoiceResponse | NoulResponse;
type JevResponse = Pick<
  SystemOneResult<Record<string, Question>>,
  "model" | "usage"
> & { answers: Record<string, Answer> };

type JevBrandingResult = {
  enhancement: BrandingEnhancement;
  model: string;
  /** Confidence of the logo choice; undefined when there were no candidates. */
  logoConfidence?: number;
};

export function isJevBrandingEnabled(input: BrandingLLMInput): boolean {
  if (!config.TYPESAFE_API_KEY) return false;
  // Listed teams stay on the LLM unless a request asks for mode "fast". Every
  // other team ignores `mode` and follows the settings below.
  if (input.teamId && config.BRANDING_JEV_TEAM_IDS?.includes(input.teamId)) {
    return input.mode === "fast";
  }
  return (
    config.BRANDING_JEV === true ||
    (!!input.teamId &&
      sampled(`team:${input.teamId}`, config.BRANDING_JEV_ROLLOUT_PERCENT))
  );
}

// ---------------------------------------------------------------------------
// Colors. Jev reads hex values poorly (docs: model-jaggedness/jev-1.13), so
// candidates are described by name and usage; the hex stays in code.

const HUES: Array<[number, string]> = [
  [15, "red"],
  [40, "orange"],
  [52, "amber"],
  [68, "yellow"],
  [90, "yellow-green"],
  [150, "green"],
  [180, "teal"],
  [200, "cyan"],
  [240, "blue"],
  [255, "indigo"],
  [268, "violet"],
  [290, "purple"],
  [330, "magenta"],
  [345, "pink"],
  [360, "red"],
];

export function describeColor(hex: string): string {
  const parsed = parse(hex);
  const c = parsed ? hsl(parsed) : undefined;
  if (!c) return "unknown color";
  const s = c.s ?? 0;
  const l = c.l ?? 0;
  if (s < 0.12 || l < 0.06 || l > 0.97) {
    // Pages often pair pure white with an off-white; keep them apart.
    if (l > 0.995) return "white";
    if (l > 0.93) return "near-white";
    if (l > 0.7) return "light gray";
    if (l > 0.4) return "gray";
    if (l > 0.15) return "dark gray";
    return l > 0.06 ? "near-black" : "black";
  }
  const h = c.h ?? 0;
  const hue = HUES.find(([limit]) => h < limit)?.[1] ?? "red";
  const lightness =
    l < 0.25
      ? "very dark "
      : l < 0.4
        ? "dark "
        : l > 0.85
          ? "very light "
          : l > 0.7
            ? "light "
            : "";
  // Saturation reads as a distinct quality only away from the extremes.
  const saturation =
    l < 0.25 || l > 0.85 ? "" : s < 0.35 ? "muted " : s > 0.65 ? "vivid " : "";
  return `${lightness}${saturation}${hue}`;
}

function normalizeHex(value?: string | null): string | undefined {
  if (!value) return undefined;
  const c = parse(value.trim());
  // Mostly transparent colors are not what the visitor sees.
  if (!c || (c.alpha !== undefined && c.alpha < 0.5)) return undefined;
  return formatHex(c)?.toUpperCase();
}

function colorName(value: string | null | undefined, missing: string) {
  const hex = normalizeHex(value);
  return hex ? describeColor(hex) : missing;
}

type ColorCandidate = { hex: string; usage: string[] };

function collectColors(input: BrandingLLMInput): ColorCandidate[] {
  const byHex = new Map<string, ColorCandidate>();
  const add = (value: string | undefined | null, usage: string) => {
    const hex = normalizeHex(value);
    if (!hex) return;
    const entry = byHex.get(hex) ?? { hex, usage: [] };
    if (!entry.usage.includes(usage)) entry.usage.push(usage);
    byHex.set(hex, entry);
  };

  for (const [role, value] of Object.entries(input.jsAnalysis.colors ?? {})) {
    add(value, `heuristic guess for ${role}`);
  }
  for (const candidate of input.backgroundCandidates ?? []) {
    add(candidate.color, `page background candidate (${candidate.source})`);
  }
  const buttons = (input.buttons ?? []).slice(0, MAX_BUTTONS);
  for (const button of buttons) {
    const label = clip(button.text, 40) || "unlabeled";
    add(button.background, `background of button "${label}"`);
    add(button.textColor, `text on button "${label}"`);
    add(button.borderColor, `border of button "${label}"`);
  }
  return [...byHex.values()].slice(0, MAX_COLORS);
}

// ---------------------------------------------------------------------------
// Fonts. Name cleanup is deterministic; Jev only judges which are brand fonts
// and what role they play.

const GENERIC_FONTS = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-sans-serif",
  "ui-serif",
  "ui-monospace",
  "ui-rounded",
  "-apple-system",
  "blinkmacsystemfont",
  "inherit",
  "initial",
  "emoji",
  "math",
]);

// Fonts pages list as fallbacks in their stacks. They are only reported when
// the page's typography uses them, or when nothing else is left.
const FALLBACK_FONTS = new Set([
  "arial",
  "helvetica",
  "helvetica neue",
  "segoe ui",
  "roboto",
  "oxygen",
  "ubuntu",
  "cantarell",
  "noto sans",
  "droid sans",
  "lucida",
  "lucida grande",
  "lucida sans unicode",
  "tahoma",
  "verdana",
  "times",
  "times new roman",
  "georgia",
  "courier",
  "courier new",
  "apple color emoji",
  "segoe ui emoji",
  "segoe ui symbol",
  "noto color emoji",
]);

export function cleanFontFamily(raw: string): string | undefined {
  // A whole stack ("system-ui, sans-serif") reports its first family.
  let name = raw
    .split(",")[0]
    .trim()
    .replace(/^["']|["']$/g, "");
  if (!name || /^var\(/i.test(name)) return undefined;
  if (/fallback/i.test(name)) return undefined;
  // next/font obfuscation: "__Roboto_Mono_c8ca7d" → "Roboto Mono"
  name = name.replace(/^_+/, "").replace(/_[0-9a-f]{6}$/i, "");
  name = name.replace(/_/g, " ").replace(/\s+/g, " ").trim();
  // Variable-font builds name the same family: "Newsreader Variable".
  name = name.replace(/\s+(variable|vf)$/i, "");
  if (!name || GENERIC_FONTS.has(name.toLowerCase())) return undefined;
  if (name === name.toLowerCase()) {
    name = name.replace(/\b\w/g, ch => ch.toUpperCase());
  }
  return name;
}

type FontRole = BrandingEnhancement["cleanedFonts"][number]["role"];
type FontCandidate = { family: string; count: number; role?: FontRole };

/** Matching key for a family: case and spacing don't make a different font. */
const familyKey = (family: string) => family.toLowerCase().replace(/\s/g, "");

/** Role from the page's own typography: the heading and body stacks it measured. */
function typographyRole(
  family: string,
  input: BrandingLLMInput,
): FontRole | undefined {
  const t = input.jsAnalysis.typography;
  const first = (value?: string | string[]) => {
    const raw = Array.isArray(value) ? value[0] : value;
    const cleaned = raw ? cleanFontFamily(raw) : undefined;
    return cleaned ? familyKey(cleaned) : undefined;
  };
  const name = familyKey(family);
  if (/\b(mono|code)\b|consolas|menlo/i.test(family)) return "monospace";
  const body = [
    first(t?.fontFamilies?.primary),
    first(t?.fontStacks?.body),
    first(t?.fontStacks?.paragraph),
  ];
  const heading = [
    first(t?.fontFamilies?.heading),
    first(t?.fontStacks?.heading),
  ];
  // A family used for both is reported as body, the page's primary font.
  if (body.includes(name)) return "body";
  if (heading.includes(name)) return "heading";
  return undefined;
}

function collectFonts(input: BrandingLLMInput): FontCandidate[] {
  const byFamily = new Map<string, FontCandidate>();
  for (const font of input.jsAnalysis.fonts ?? []) {
    const raw = typeof font === "string" ? font : font.family;
    const family = raw ? cleanFontFamily(raw) : undefined;
    if (!family) continue;
    const count =
      typeof font === "object" && typeof font.count === "number"
        ? font.count
        : 1;
    // "CormorantGaramond" and "Cormorant Garamond" are one family; keep the
    // spaced name.
    const key = familyKey(family);
    const existing = byFamily.get(key);
    if (existing) {
      existing.count += count;
      if (!existing.family.includes(" ") && family.includes(" ")) {
        existing.family = family;
      }
    } else byFamily.set(key, { family, count });
  }
  return [...byFamily.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, MAX_FONTS)
    .map(font => ({ ...font, role: typographyRole(font.family, input) }));
}

// ---------------------------------------------------------------------------
// State + questions

function hrefKind(href: string | undefined, pageUrl: string, home: boolean) {
  if (!href?.trim()) return "no link";
  if (home) return "links to the homepage";
  try {
    const target = new URL(href, pageUrl);
    return target.hostname === new URL(pageUrl).hostname
      ? "links to another page on this site"
      : "links to another website";
  } catch {
    return "unknown link";
  }
}

function sizeLabel(width: number, height: number): string {
  const maxSide = Math.max(width, height);
  const area = width * height;
  if (maxSide <= 24 || area <= 400) return "tiny";
  if (maxSide <= 48 || area <= 1800) return "small";
  if (maxSide <= 140 || area <= 12000) return "medium";
  if (maxSide <= 320 || area <= 50000) return "large";
  return "hero-sized";
}

function fileName(src: string): string {
  if (src.startsWith("data:")) return "inline SVG";
  const path = src.split(/[?#]/)[0];
  return clip(path.split("/").pop(), 80);
}

// Cookie-consent controls are page chrome, never the site's call to action.
const CONSENT =
  /cookie|consent|gdpr|accept all|reject all|allow all|decline|manage (?:preferences|settings)|akzeptieren|ablehnen|accepter|refuser|aceptar|rechazar/i;
const isConsentButton = (button: { text?: string; classes?: string }) =>
  CONSENT.test(`${button.text ?? ""} ${button.classes ?? ""}`);

/** Everything merge copies from the chosen button, so look-alikes are truly alike. */
const buttonStyle = (b: {
  background?: string;
  textColor?: string;
  borderColor?: string | null;
  borderRadius?: string;
  shadow?: string | null;
}) =>
  [
    normalizeHex(b.background) ?? "none",
    normalizeHex(b.textColor) ?? "none",
    normalizeHex(b.borderColor) ?? "none",
    b.borderRadius ?? "",
    b.shadow ?? "",
  ].join("/");

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;

// slice() counts UTF-16 code units, so never end on the first half of a pair.
const clip = (value: string | undefined, max: number) => {
  const text = (value ?? "").replace(/\s+/g, " ").trim();
  return text.slice(
    0,
    isHighSurrogate(text.charCodeAt(max - 1)) ? max - 1 : max,
  );
};

// TypeSafe rejects text with lone surrogates as invalid Unicode. Page text can
// carry them (the branding script truncates by code unit), so replace them
// with U+FFFD, as String.prototype.toWellFormed does.
const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const wellFormed = (value: JsonValue): JsonValue =>
  typeof value === "string"
    ? value.replace(LONE_SURROGATE, "\uFFFD")
    : Array.isArray(value)
      ? value.map(wellFormed)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value).map(([k, v]) => [k, wellFormed(v)]),
          )
        : value;

type JevRequest = {
  state: Record<string, JsonValue>;
  questions: Record<string, Question>;
  colors: ColorCandidate[];
  fonts: FontCandidate[];
  logoCount: number;
  buttonCount: number;
  /** Background + text color per button, to group look-alike buttons. */
  buttonStyles: string[];
  /** Raw background per button: merge drops a secondary that matches the primary's. */
  buttonBackgrounds: string[];
};

export function buildJevRequest(input: BrandingLLMInput): JevRequest {
  const pageUrl = input.pageUrl || input.url;
  const logos = (input.logoCandidates ?? []).slice(0, MAX_LOGOS);
  const buttons = (input.buttons ?? []).slice(0, MAX_BUTTONS);
  const colors = collectColors(input);
  const fonts = collectFonts(input);

  const state: Record<string, JsonValue> = {
    page: {
      url: pageUrl,
      title: clip(input.pageTitle, 200),
      brand_name_hint: clip(input.brandName, 80),
      color_scheme: input.jsAnalysis.colorScheme ?? "unknown",
    },
  };

  if (logos.length > 0) {
    const heuristic = input.heuristicLogoPick?.selectedIndexInFilteredList;
    state.logo_candidates = Object.fromEntries(
      logos.map((logo, i) => {
        const width = Math.round(logo.position?.width ?? 0);
        const height = Math.round(logo.position?.height ?? 0);
        return [
          `logo_${i}`,
          {
            where: logo.location,
            visible: logo.isVisible,
            size: `${width}x${height} px (${sizeLabel(width, height)})`,
            shape:
              width && height && width / height >= 3
                ? "wide, wordmark-shaped"
                : "compact",
            kind: logo.isSvg ? "SVG" : "image",
            alt: clip(logo.alt, 100),
            aria_label: clip(logo.ariaLabel, 100),
            title: clip(logo.title, 100),
            link: hrefKind(logo.href, pageUrl, !!logo.indicators?.hrefMatch),
            file: fileName(logo.src),
            found_via: logo.source,
            heuristic_pick: i === heuristic,
          },
        ];
      }),
    );
  }

  // Ids keep each button's index in `input.buttons`, which is what merge reads.
  const ctaButtons = buttons
    .map((button, i) => ({ button, id: `button_${i}` }))
    .filter(({ button }) => !isConsentButton(button));

  if (ctaButtons.length > 0) {
    state.buttons = Object.fromEntries(
      ctaButtons.map(({ button, id }) => [
        id,
        {
          text: clip(button.text, 80),
          background: colorName(button.background, "transparent"),
          text_color: colorName(button.textColor, "unknown"),
          border: colorName(button.borderColor, "none"),
          css_classes: clip(button.classes, 120),
        },
      ]),
    );
  }

  if (colors.length > 0) {
    state.colors = Object.fromEntries(
      colors.map((color, i) => [
        `color_${i}`,
        { looks: describeColor(color.hex), used_as: color.usage.slice(0, 4) },
      ]),
    );
  }

  if (fonts.length > 0) {
    state.fonts = Object.fromEntries(
      fonts.map((font, i) => [
        `font_${i}`,
        {
          family: font.family,
          times_used: font.count,
          ...(font.role ? { used_for: `${font.role} text` } : {}),
        },
      ]),
    );
  }

  const classSample = [
    ...new Set(buttons.flatMap(b => (b.classes || "").split(/\s+/))),
  ]
    .filter(c => c.length > 0 && c.length < 50)
    .slice(0, 40);
  const frameworkHints = (
    ((input.jsAnalysis as any).__framework_hints as string[] | undefined) ?? []
  ).map(h => clip(h, 60));
  state.css = { class_sample: classSample, framework_hints: frameworkHints };

  const ids = (prefix: string, n: number) =>
    Array.from({ length: n }, (_, i) => `${prefix}_${i}`);
  const options = (keys: string[], none?: string) => ({
    ...Object.fromEntries(keys.map(k => [k, null])),
    ...(none ? { [NONE]: none } : {}),
  });

  const questions: Record<string, Question> = {};

  if (logos.length > 0) {
    questions.logo = {
      type: "choice",
      instructions:
        "Which entry in `logo_candidates` is this website's own primary brand logo: the mark of the brand named by `page` (title, URL, brand_name_hint), normally visible in the header and linking to the homepage? Menu, hamburger, close, social, partner, customer and payment icons are not the brand logo.",
      criteria: options(
        ids("logo", logos.length),
        "No candidate is this website's own brand logo.",
      ),
    };
  }

  if (ctaButtons.length > 0) {
    const buttonIds = ctaButtons.map(({ id }) => id);
    questions.primary_button = {
      type: "choice",
      instructions:
        "Which entry in `buttons` is the site's primary call-to-action button: the most prominent action a visitor is invited to take (such as Sign up, Get started, Buy, Book a demo, Donate)? Cookie-consent buttons are not calls to action.",
      // No "none": when a page has buttons, one of them is the primary style.
      criteria: options(buttonIds),
    };
    questions.secondary_button = {
      type: "choice",
      instructions:
        "Which entry in `buttons` is the secondary action button: a less prominent alternative to the primary one (such as Learn more, Contact sales, Log in), usually outlined, neutral or a different color?",
      criteria: options(buttonIds, "There is no secondary button."),
    };
  }

  if (colors.length > 0) {
    const colorIds = ids("color", colors.length);
    questions.primary_color = {
      type: "choice",
      instructions:
        "Which entry in `colors` is the brand's main color: the distinctive color of its logo, primary buttons and highlights? Page chrome such as white or black backgrounds, gray text and borders is not the brand color unless the brand is deliberately monochrome.",
      criteria: options(colorIds),
    };
    questions.accent_color = {
      type: "choice",
      instructions:
        "Which entry in `colors` is the accent color used for calls to action, highlights and links?",
      criteria: options(colorIds),
    };
    questions.secondary_color = {
      type: "choice",
      instructions:
        "Which entry in `colors` is a secondary brand color, different from the main brand color and used for supporting brand elements? Choose none if the brand has no clear secondary color.",
      criteria: options(colorIds, "The brand has no clear secondary color."),
    };
    questions.background_color = {
      type: "choice",
      instructions:
        "Which entry in `colors` is the main page background color?",
      criteria: options(colorIds),
    };
    questions.text_color = {
      type: "choice",
      instructions:
        "Which entry in `colors` is the main body text color, the one most paragraphs are written in?",
      criteria: options(colorIds),
    };
  }

  fonts.forEach((font, i) => {
    questions[`font_${i}_is_brand`] = {
      type: "noul",
      instructions: `Is \`fonts.font_${i}\` a real typeface this site uses for visible text, rather than an icon font, a fallback, or a generic family?`,
    };
    // The page's typography already says what the font is for.
    if (font.role) return;
    questions[`font_${i}_role`] = {
      type: "choice",
      instructions: `What is \`fonts.font_${i}\` mainly used for on this site?`,
      criteria: {
        heading: "Headings and titles",
        body: "Body text and paragraphs",
        monospace: "Code or monospaced text",
        display: "Large decorative display text or the logo",
        unknown: "Cannot tell",
      },
    };
  });

  questions.tone = {
    type: "choice",
    instructions: "Which word best describes the overall tone of this brand?",
    criteria: {
      professional: null,
      playful: null,
      modern: null,
      traditional: null,
      minimalist: null,
      bold: null,
    },
  };
  questions.energy = {
    type: "choice",
    instructions: "How much visual energy does this brand's design have?",
    criteria: { low: "Calm, restrained", medium: null, high: "Loud, vivid" },
  };
  questions.audience = {
    type: "choice",
    instructions: "Who is this website mainly for?",
    criteria: Object.fromEntries(AUDIENCES.map(a => [a, null])),
  };
  questions.framework = {
    type: "choice",
    instructions:
      "Which CSS framework does this site use, judging from `css.class_sample` and `css.framework_hints`?",
    criteria: {
      tailwind:
        "Utility classes such as flex, items-center, px-4, bg-blue-500, rounded-lg",
      bootstrap: "Classes such as btn, btn-primary, container, row, col-md-6",
      material: "Mui* or mdc-* classes",
      chakra: "chakra-* classes",
      custom: "Its own class names that match no standard framework",
      unknown: "Not enough evidence",
    },
  };
  questions.component_library = {
    type: "choice",
    instructions:
      "Which component library does this site use, judging from `css.class_sample` and `css.framework_hints`?",
    criteria: {
      "radix-ui": "radix-* data attributes or class names",
      shadcn: "shadcn/ui conventions on top of Tailwind and Radix",
      "headless-ui": "headlessui-* identifiers",
      mui: "Mui* classes",
      "chakra-ui": "chakra-* classes",
      "ant-design": "ant-* classes",
      mantine: "mantine-* classes",
      [NONE]: "None of these, or not enough evidence",
    },
  };

  return {
    state: wellFormed(state) as Record<string, JsonValue>,
    questions,
    colors,
    fonts,
    logoCount: logos.length,
    buttonCount: buttons.length,
    buttonStyles: buttons.map(buttonStyle),
    buttonBackgrounds: buttons.map(b => b.background),
  };
}

const AUDIENCES = [
  "general consumers",
  "shoppers",
  "businesses",
  "small businesses",
  "enterprises",
  "developers",
  "creative professionals",
  "marketers",
  "students and educators",
  "patients and healthcare professionals",
  "investors and finance professionals",
  "donors and nonprofit supporters",
  "travelers",
  "gamers",
  "job seekers",
  "government and public-sector users",
];

// ---------------------------------------------------------------------------
// Answer mapping

function choiceOf(answers: Record<string, Answer>, key: string) {
  const a = answers[key];
  return a && a.type === "choice" ? a : undefined;
}

/** Best option other than the excluded ones, by probability. */
function bestExcluding(answer: ChoiceAnswer, exclude: Set<string>) {
  return Object.entries(answer.probabilities)
    .filter(([option]) => !exclude.has(option))
    .sort((a, b) => b[1] - a[1])[0]?.[0];
}

function styleProbability(request: JevRequest, answer: ChoiceAnswer): number {
  const chosen = indexOf(answer.choice, "button");
  if (chosen < 0) return 0;
  const style = request.buttonStyles[chosen];
  return Object.entries(answer.probabilities)
    .filter(
      ([option]) => request.buttonStyles[indexOf(option, "button")] === style,
    )
    .reduce((sum, [, p]) => sum + p, 0);
}

const indexOf = (option: string | undefined, prefix: string) =>
  option?.startsWith(`${prefix}_`)
    ? Number(option.slice(prefix.length + 1))
    : -1;

function mapJevAnswers(
  request: JevRequest,
  response: JevResponse,
): JevBrandingResult {
  const { answers } = response;
  const tag = `jev ${response.model}`;

  // Buttons: the secondary must not share the primary's background, or merge
  // drops it. Skip every look-alike, not just the primary itself.
  const primaryButton = choiceOf(answers, "primary_button");
  const secondaryButton = choiceOf(answers, "secondary_button");
  const primaryButtonIndex = indexOf(primaryButton?.choice, "button");
  const primaryBackground = request.buttonBackgrounds[primaryButtonIndex];
  const looksLikePrimary = (option: string) =>
    option === primaryButton?.choice ||
    (primaryBackground !== undefined &&
      request.buttonBackgrounds[indexOf(option, "button")] ===
        primaryBackground);
  let secondaryOption = secondaryButton?.choice;
  if (secondaryButton && secondaryOption && looksLikePrimary(secondaryOption)) {
    secondaryOption = bestExcluding(
      secondaryButton,
      new Set(
        Object.keys(secondaryButton.probabilities).filter(looksLikePrimary),
      ),
    );
  }

  // Colors: text must differ from background, secondary from primary.
  const colorHex = (option?: string) => {
    const i = indexOf(option, "color");
    return i >= 0 ? request.colors[i]?.hex : undefined;
  };
  const primaryColor = choiceOf(answers, "primary_color");
  const background = choiceOf(answers, "background_color");
  const text = choiceOf(answers, "text_color");
  const accent = choiceOf(answers, "accent_color");
  const secondaryColor = choiceOf(answers, "secondary_color");
  let textOption = text?.choice;
  if (text && textOption === background?.choice) {
    textOption = bestExcluding(text, new Set([background!.choice]));
  }
  let secondaryColorOption = secondaryColor?.choice;
  if (secondaryColor && secondaryColorOption === primaryColor?.choice) {
    secondaryColorOption = bestExcluding(
      secondaryColor,
      new Set([primaryColor!.choice]),
    );
  }
  // A role Jev is unsure of is left empty so the heuristic value stays.
  const roleHex = (answer: ChoiceAnswer | undefined, option?: string) =>
    answer && answer.confidence >= ROLE_MIN_CONFIDENCE
      ? colorHex(option)
      : undefined;
  const colorConfidences = [primaryColor, background, text]
    .filter((a): a is ChoiceAnswer => !!a)
    .map(a => a.confidence);

  // Fonts: keep the ones Jev calls real typefaces, most used first.
  const realFonts = request.fonts
    .map((font, i) => {
      const isBrand = answers[`font_${i}_is_brand`];
      const role = choiceOf(answers, `font_${i}_role`);
      return {
        family: font.family,
        role: font.role ?? ((role?.choice ?? "unknown") as FontRole),
        // the page's own typography uses it for headings or body
        measured: font.role !== undefined,
        keep: isBrand?.type === "noul" ? isBrand.noul >= 0.5 : true,
      };
    })
    .filter(f => f.keep);
  // Drop fallback faces the page doesn't use for text, and once headings or
  // body are covered, fonts nobody could place.
  const isFallback = (f: (typeof realFonts)[number]) =>
    FALLBACK_FONTS.has(f.family.toLowerCase()) && !f.measured;
  const withoutFallbacks = realFonts.some(f => !isFallback(f))
    ? realFonts.filter(f => !isFallback(f))
    : realFonts;
  const placed = withoutFallbacks.some(
    f => f.role === "heading" || f.role === "body",
  );
  const cleanedFonts = withoutFallbacks
    .filter(f => !placed || f.role !== "unknown")
    .slice(0, 5)
    .map(({ family, role }) => ({ family, role }));

  const tone = choiceOf(answers, "tone");
  const energy = choiceOf(answers, "energy");
  const audience = choiceOf(answers, "audience");
  const framework = choiceOf(answers, "framework");
  const library = choiceOf(answers, "component_library");

  const enhancement: BrandingEnhancement = {
    buttonClassification: {
      primaryButtonIndex,
      primaryButtonReasoning: `${tag}: p=${primaryButton?.probabilities[primaryButton.choice]?.toFixed(2) ?? "n/a"}`,
      secondaryButtonIndex: indexOf(secondaryOption, "button"),
      secondaryButtonReasoning: `${tag}: p=${secondaryOption ? (secondaryButton?.probabilities[secondaryOption]?.toFixed(2) ?? "n/a") : "n/a"}`,
      // The output keeps only the button's style, so choosing between
      // identical-looking buttons is not uncertainty: count their combined
      // probability.
      confidence: primaryButton
        ? Math.max(
            primaryButton.confidence,
            styleProbability(request, primaryButton),
          )
        : 0,
    },
    colorRoles: {
      primaryColor: roleHex(primaryColor, primaryColor?.choice) ?? "",
      secondaryColor: roleHex(secondaryColor, secondaryColorOption) ?? "",
      accentColor: roleHex(accent, accent?.choice) ?? "",
      backgroundColor: roleHex(background, background?.choice) ?? "",
      textPrimary: roleHex(text, textOption) ?? "",
      // Merge applies the roles at >= 0.5. Jev's confidences are calibrated,
      // so average them instead of letting the least certain role veto all.
      confidence:
        colorConfidences.length > 0
          ? colorConfidences.reduce((a, b) => a + b, 0) /
            colorConfidences.length
          : 0,
    },
    cleanedFonts,
    ...(tone && energy
      ? {
          personality: {
            tone: tone.choice as NonNullable<
              BrandingEnhancement["personality"]
            >["tone"],
            energy: energy.choice as NonNullable<
              BrandingEnhancement["personality"]
            >["energy"],
            targetAudience: audience?.choice ?? "",
          },
        }
      : {}),
    ...(framework
      ? {
          designSystem: {
            framework: framework.choice as NonNullable<
              BrandingEnhancement["designSystem"]
            >["framework"],
            componentLibrary:
              library && library.choice !== NONE ? library.choice : "",
          },
        }
      : {}),
  };

  let logoConfidence: number | undefined;
  if (request.logoCount > 0) {
    const logo = choiceOf(answers, "logo");
    logoConfidence = logo?.confidence ?? 0;
    enhancement.logoSelection = {
      selectedLogoIndex: indexOf(logo?.choice, "logo"),
      selectedLogoReasoning: `${tag}: p=${logo?.probabilities[logo.choice]?.toFixed(2) ?? "n/a"}`,
      confidence: logoConfidence,
    };
  }

  return { enhancement, model: response.model, logoConfidence };
}

// ---------------------------------------------------------------------------
// Client

/**
 * Answer the branding decisions with Jev. Returns null when the call fails so
 * the caller can fall back to the LLM path.
 */
export async function enhanceBrandingWithJev(
  input: BrandingLLMInput,
  options: { shadow?: boolean } = {},
): Promise<JevBrandingResult | null> {
  const typesafe = getTypeSafeClient();
  if (!typesafe || isJevBreakerOpen()) return null;
  const started = Date.now();
  let request: JevRequest;
  let response: JevResponse;
  let called = false;
  try {
    request = buildJevRequest(input);
    response = await withSpan(
      "typesafe.systemone",
      async span => {
        called = true;
        const result = await typesafe.systemOne(
          {
            model: JEV_MODEL,
            state: request.state,
            questions: request.questions,
          },
          {
            timeout: config.BRANDING_JEV_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS,
            retry: { maxRetries: 1 },
          },
        );
        setSpanAttributes(span, {
          "typesafe.model": result.model,
          "typesafe.usage.input_tokens": result.usage?.input_tokens,
          "typesafe.usage.output_tokens": result.usage?.output_tokens,
        });
        return result as JevResponse;
      },
      {
        kind: SpanKind.CLIENT,
        // TypeSafe retains nothing for our account; our own trace of a ZDR
        // scrape must not be exported either.
        zeroDataRetention: input.zeroDataRetention === true,
        attributes: {
          feature: "branding",
          "branding.jev.questions": Object.keys(request.questions).length,
          ...(options.shadow ? { "branding.jev.shadow": true } : {}),
          ...(input.scrapeId ? { scrapeId: input.scrapeId } : {}),
          ...(input.teamId ? { teamId: input.teamId } : {}),
        },
      },
    );
  } catch (error) {
    // Only TypeSafe's own failures say anything about its health.
    if (called) recordJevFailure(input);
    input.logger.warn(
      options.shadow
        ? "Jev branding shadow call failed"
        : "Jev branding call failed, falling back to LLM",
      {
        error,
        elapsedMs: Date.now() - started,
      },
    );
    return null;
  }
  // A call that started before the breaker opened and succeeds late doesn't
  // close it: the next failure after the cooldown should reopen it at once.
  if (!isJevBreakerOpen()) consecutiveFailures = 0;

  const inputTokens = response.usage?.input_tokens ?? 0;
  const outputTokens = response.usage?.output_tokens ?? 0;
  input.costTracking.addCall({
    type: "other",
    metadata: { module: "branding", method: "enhanceBrandingWithJev" },
    model: response.model || JEV_MODEL,
    cost: (inputTokens * JEV_INPUT_USD_PER_MTOK) / 1_000_000,
    tokens: { input: inputTokens, output: outputTokens },
  });

  let result: JevBrandingResult;
  try {
    result = mapJevAnswers(request, response);
  } catch (error) {
    // A successful call whose answers don't have the expected shape.
    input.logger.warn(
      options.shadow
        ? "Jev branding shadow answers unusable"
        : "Jev branding answers unusable, falling back to LLM",
      {
        error,
        model: response.model,
      },
    );
    return null;
  }
  input.logger.info("Jev branding call", {
    model: response.model,
    shadow: options.shadow === true,
    elapsedMs: Date.now() - started,
    inputTokens,
    questions: Object.keys(request.questions).length,
    logoConfidence: result.logoConfidence,
  });
  return result;
}
