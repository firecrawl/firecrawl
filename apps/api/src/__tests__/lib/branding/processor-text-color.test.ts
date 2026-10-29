import { processRawBranding } from "../../../lib/branding/processor";

const snap = (over: {
  tag?: string;
  text: string;
  textColor: string;
  background?: string;
  isButton?: boolean;
  w?: number;
  h?: number;
}) => ({
  tag: over.tag ?? "p",
  classes: "",
  text: over.text,
  rect: { w: over.w ?? 600, h: over.h ?? 24 },
  position: { top: 300, left: 0 },
  visible: true,
  colors: {
    text: over.textColor,
    background: over.background ?? "rgba(0, 0, 0, 0)",
    border: "rgba(0, 0, 0, 0)",
    borderWidth: 0,
  },
  typography: { fontStack: ["Inter"], size: "16px", weight: 400 },
  radius: 0,
  borderRadius: { topLeft: 0, topRight: 0, bottomRight: 0, bottomLeft: 0 },
  shadow: null,
  isButton: over.isButton ?? false,
  isNavigation: false,
  hasCTAIndicator: false,
  isInput: false,
  isLink: false,
});

const raw = (
  snapshots: ReturnType<typeof snap>[],
  page: { background: string; scheme: "light" | "dark" },
) =>
  ({
    cssData: { colors: [], spacings: [], radii: [] },
    snapshots,
    images: [],
    logoCandidates: [],
    brandName: "Acme",
    pageTitle: "Acme",
    pageUrl: "https://acme.test/",
    typography: { stacks: { body: [], heading: [], paragraph: [] }, sizes: {} },
    frameworkHints: [],
    colorScheme: page.scheme,
    pageBackground: page.background,
    backgroundCandidates: [],
  }) as any;

describe("text color heuristic", () => {
  it("takes the body text color, not the link color, on link-heavy pages", () => {
    const links = Array.from({ length: 10 }, (_, i) => ({
      ...snap({
        tag: "a",
        text: `Article ${i}`,
        textColor: "rgb(51, 102, 204)",
      }),
      isLink: true,
    }));
    const body = [
      snap({ tag: "h1", text: "Welcome", textColor: "rgb(32, 33, 34)" }),
      snap({ text: "The free encyclopedia", textColor: "rgb(32, 33, 34)" }),
    ];

    const profile = processRawBranding(
      raw([...links, ...body], {
        background: "rgb(255, 255, 255)",
        scheme: "light",
      }),
    );

    expect(profile.colors?.textPrimary).toBe("#202122");
  });

  it("takes the text color from the page's text, not from button fills", () => {
    const buttons = Array.from({ length: 8 }, (_, i) =>
      snap({
        tag: "a",
        text: `Order ${i}`,
        textColor: "rgb(255, 255, 255)",
        background: "rgb(50, 70, 47)",
        isButton: true,
        w: 180,
        h: 48,
      }),
    );
    // Dark gray buttons: their fills used to outvote the paragraph text.
    const grayButtons = Array.from({ length: 6 }, (_, i) =>
      snap({
        tag: "a",
        text: `Trade ${i}`,
        textColor: "rgb(255, 255, 255)",
        background: "rgb(70, 75, 85)",
        isButton: true,
        w: 180,
        h: 48,
      }),
    );
    const paragraphs = Array.from({ length: 4 }, (_, i) =>
      snap({ text: `Paragraph ${i}`, textColor: "rgb(33, 33, 33)" }),
    );

    const profile = processRawBranding(
      raw([...buttons, ...grayButtons, ...paragraphs], {
        background: "rgb(255, 255, 255)",
        scheme: "light",
      }),
    );

    expect(profile.colors?.textPrimary).toBe("#212121");
  });

  it("picks light text on a dark page", () => {
    const paragraphs = Array.from({ length: 4 }, (_, i) =>
      snap({ text: `Paragraph ${i}`, textColor: "rgb(255, 255, 255)" }),
    );

    const profile = processRawBranding(
      raw(paragraphs, { background: "rgb(18, 18, 18)", scheme: "dark" }),
    );

    expect(profile.colors?.textPrimary).toBe("#FFFFFF");
  });

  it("ignores text the visitor can't see", () => {
    const hidden = Array.from({ length: 10 }, (_, i) => ({
      ...snap({ text: `Menu item ${i}`, textColor: "rgb(120, 0, 0)" }),
      visible: false,
    }));
    const paragraphs = Array.from({ length: 3 }, (_, i) =>
      snap({ text: `Paragraph ${i}`, textColor: "rgb(33, 33, 33)" }),
    );

    const profile = processRawBranding(
      raw([...hidden, ...paragraphs], {
        background: "rgb(255, 255, 255)",
        scheme: "light",
      }),
    );

    expect(profile.colors?.textPrimary).toBe("#212121");
  });
});

describe("browser link colors", () => {
  it("never picks the default link blue as a brand or text color", () => {
    // Unstyled links in a footer or skip-nav, drawn in the browser's blue.
    const links = Array.from({ length: 12 }, (_, i) =>
      snap({ tag: "a", text: `Link ${i}`, textColor: "rgb(0, 0, 238)" }),
    );
    const visited = Array.from({ length: 4 }, (_, i) =>
      snap({ tag: "a", text: `Visited ${i}`, textColor: "rgb(85, 26, 139)" }),
    );
    const cta = snap({
      tag: "a",
      text: "Book a table",
      textColor: "rgb(255, 255, 255)",
      background: "rgb(200, 37, 64)",
      isButton: true,
      w: 180,
      h: 48,
    });
    const paragraphs = Array.from({ length: 3 }, (_, i) =>
      snap({ text: `Paragraph ${i}`, textColor: "rgb(33, 33, 33)" }),
    );

    const profile = processRawBranding(
      raw([...links, ...visited, cta, ...paragraphs], {
        background: "rgb(255, 255, 255)",
        scheme: "light",
      }),
    );

    const picked = Object.values(profile.colors ?? {}).map(c =>
      String(c).toUpperCase(),
    );
    expect(picked).not.toContain("#0000EE");
    expect(picked).not.toContain("#551A8B");
    expect(profile.colors?.primary).toBe("#C82540");
    expect(profile.colors?.textPrimary).toBe("#212121");
  });
});
