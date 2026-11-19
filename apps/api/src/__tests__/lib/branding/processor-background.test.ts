import { describe, expect, it } from "vitest";

import {
  pickPageBackground,
  processRawBranding,
} from "../../../lib/branding/processor";

const snap = (over: {
  tag?: string;
  text: string;
  textColor: string;
  background?: string;
  isLink?: boolean;
  isNavigation?: boolean;
  isButton?: boolean;
}) => ({
  tag: over.tag ?? "p",
  classes: "",
  text: over.text,
  rect: { w: 600, h: 24 },
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
  isNavigation: over.isNavigation ?? false,
  hasCTAIndicator: false,
  isInput: false,
  isLink: over.isLink ?? false,
});

type Candidate = { color: string; source: string; priority: number };

const raw = (
  snapshots: ReturnType<typeof snap>[],
  page: { scheme: "light" | "dark"; backgrounds: Candidate[] },
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
    pageBackground: page.backgrounds[0]?.color ?? null,
    backgroundCandidates: page.backgrounds,
  }) as any;

const paragraphs = Array.from({ length: 8 }, (_, i) =>
  snap({ text: `Paragraph ${i}`, textColor: "rgb(17, 17, 17)" }),
);

describe("page background", () => {
  it("skips a translucent overlay and a dark section on a light page", () => {
    expect(
      pickPageBackground(
        [
          { color: "rgba(0,0,0,0.95)", source: "most-common-visible", priority: 12 },
          { color: "rgb(20, 20, 20)", source: "hero", priority: 11 },
          { color: "rgb(255, 255, 255)", source: "body", priority: 10 },
        ],
        "light",
      ),
    ).toBe("#FFFFFF");
  });

  it("wants a dark page background on a dark page", () => {
    expect(
      pickPageBackground(
        [
          { color: "rgb(255, 255, 255)", source: "header-container", priority: 12 },
          { color: "rgb(17, 17, 17)", source: "body", priority: 10 },
        ],
        "dark",
      ),
    ).toBe("#111111");
    expect(pickPageBackground([], "dark")).toBeNull();
  });

  it("keeps the page white, and its text dark, under a cookie dialog's backdrop", () => {
    const profile = processRawBranding(
      raw(paragraphs, {
        scheme: "light",
        backgrounds: [
          { color: "rgba(0,0,0,0.95)", source: "most-common-visible", priority: 12 },
          { color: "rgb(255, 255, 255)", source: "body", priority: 10 },
        ],
      }),
    );
    expect(profile.colors?.background).toBe("#FFFFFF");
    expect(profile.colors?.textPrimary).toBe("#111111");
  });
});

describe("link color", () => {
  const page = {
    scheme: "light" as const,
    backgrounds: [{ color: "rgb(255, 255, 255)", source: "body", priority: 10 }],
  };

  it("is what the content's links are written in, not the navigation's", () => {
    const profile = processRawBranding(
      raw(
        [
          ...paragraphs,
          ...["Docs", "Pricing", "Blog"].map(text =>
            snap({ tag: "a", text, textColor: "rgb(255, 255, 255)", isLink: true, isNavigation: true }),
          ),
          snap({ tag: "a", text: "Read more", textColor: "rgb(51, 102, 204)", isLink: true }),
          snap({ tag: "a", text: "Terms", textColor: "rgb(51, 102, 204)", isLink: true }),
        ],
        page,
      ),
    );
    expect(profile.colors?.link).toBe("#3366CC");
    expect((profile as any).__link_measured).toBe(true);
  });

  it("falls back to the navigation's links, and then to the accent", () => {
    const withNav = processRawBranding(
      raw(
        [
          ...paragraphs,
          snap({ tag: "a", text: "Docs", textColor: "rgb(200, 30, 30)", isLink: true, isNavigation: true }),
        ],
        page,
      ),
    );
    expect(withNav.colors?.link).toBe("#C81E1E");

    const noLinks = processRawBranding(raw(paragraphs, page));
    expect(noLinks.colors?.link).toBe(noLinks.colors?.accent);
    expect((noLinks as any).__link_measured).toBe(false);
  });

  it("ignores the browser's default blue, body-text black and a dark header's white", () => {
    const profile = processRawBranding(
      raw(
        [
          ...paragraphs,
          snap({ tag: "a", text: "Unstyled", textColor: "rgb(0, 0, 238)", isLink: true }),
          snap({ tag: "a", text: "Plain", textColor: "rgb(17, 17, 17)", isLink: true }),
          snap({ tag: "a", text: "Plain too", textColor: "rgb(17, 17, 17)", isLink: true }),
          snap({ tag: "a", text: "Docs", textColor: "rgb(255, 255, 255)", isLink: true, isNavigation: true }),
        ],
        page,
      ),
    );
    expect(profile.colors?.link).toBe(profile.colors?.accent);
  });

  it("does not make white body text the accent on a dark page", () => {
    const profile = processRawBranding(
      raw(
        [
          ...Array.from({ length: 12 }, (_, i) =>
            snap({ text: `Paragraph ${i}`, textColor: "rgb(255, 255, 255)" }),
          ),
          snap({ text: "Get started", textColor: "rgb(255, 255, 255)", background: "rgb(0, 97, 254)", isButton: true }),
          snap({ tag: "a", text: "Docs", textColor: "rgb(255, 255, 255)", isLink: true }),
        ],
        {
          scheme: "dark",
          backgrounds: [{ color: "rgb(17, 17, 17)", source: "body", priority: 10 }],
        },
      ),
    );
    expect(profile.colors?.accent).not.toBe("#FFFFFF");
    expect(profile.colors?.link).not.toBe("#FFFFFF");
  });

  it("composites button colors against the page, not the overlay", () => {
    const profile = processRawBranding(
      raw(
        [
          ...paragraphs,
          snap({ tag: "button", text: "Get started", textColor: "rgb(255, 255, 255)", background: "rgba(0, 97, 254, 0.5)", isButton: true }),
        ],
        {
          scheme: "light",
          backgrounds: [
            { color: "rgba(0,0,0,0.95)", source: "most-common-visible", priority: 12 },
            { color: "rgb(255, 255, 255)", source: "body", priority: 10 },
          ],
        },
      ),
    );
    // 50% brand blue over white, not over the backdrop's black.
    expect((profile as any).__button_snapshots?.[0]?.background).toBe("#80B0FF");
  });

  it("does not blend an overlay into gray when nothing measured can be the page", () => {
    const profile = processRawBranding(
      raw(paragraphs, {
        scheme: "light",
        backgrounds: [
          { color: "rgba(0,0,0,0.5)", source: "most-common-visible", priority: 12 },
        ],
      }),
    );
    expect(profile.colors?.background).toBe("#FFFFFF");
    expect(profile.colors?.textPrimary).toBe("#111111");
  });
});
