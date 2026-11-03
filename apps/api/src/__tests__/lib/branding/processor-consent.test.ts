import { describe, expect, it } from "vitest";
import { processRawBranding } from "../../../lib/branding/processor";

const button = (text: string, background: string, isConsent: boolean) => ({
  tag: "button",
  classes: "",
  text,
  rect: { w: 150, h: 44 },
  position: { top: 500, left: 0 },
  visible: true,
  colors: { text: "rgb(255, 255, 255)", background, border: "rgba(0, 0, 0, 0)", borderWidth: 0 },
  typography: { fontStack: ["Inter"], size: "16px", weight: 500 },
  radius: 6,
  borderRadius: { topLeft: 6, topRight: 6, bottomRight: 6, bottomLeft: 6 },
  shadow: null,
  isButton: true,
  isNavigation: false,
  hasCTAIndicator: false,
  isInput: false,
  isLink: false,
  isConsent,
});

describe("consent dialogs in the button candidates", () => {
  it("never offers a consent dialog's buttons as the brand's", () => {
    const profile: any = processRawBranding({
      cssData: { colors: [], spacings: [], radii: [] },
      snapshots: [
        button("Accepter", "rgb(53, 71, 103)", true),
        button("Refuser", "rgb(249, 249, 249)", true),
        button("Demander un devis", "rgb(197, 82, 41)", false),
      ],
      images: [],
      logoCandidates: [],
      brandName: "Acme",
      pageTitle: "Acme",
      pageUrl: "https://acme.test/",
      typography: { stacks: { body: ["Inter"], heading: ["Inter"], paragraph: ["Inter"] }, sizes: {} },
      frameworkHints: [],
      colorScheme: "light",
      pageBackground: "rgb(255, 255, 255)",
      backgroundCandidates: [{ color: "rgb(255, 255, 255)", source: "body", priority: 100 }],
    } as any);

    expect(profile.__button_snapshots.map((b: any) => b.text)).toEqual(["Demander un devis"]);
  });

  it("does not report a label the same color as its fill", () => {
    const withText = (bg: string, text: string, label: string) => ({
      ...button(label, bg, false),
      colors: { text, background: bg, border: "rgba(0, 0, 0, 0)", borderWidth: 0 },
    });
    const profile: any = processRawBranding({
      cssData: { colors: [], spacings: [], radii: [] },
      snapshots: [
        // Orange on orange: a deferred stylesheet hadn't set the white label yet.
        withText("rgb(197, 82, 41)", "rgb(197, 82, 41)", "Entretien préventif"),
        withText("rgb(240, 240, 240)", "rgb(240, 240, 240)", "Voir plus"),
        withText("rgb(53, 71, 103)", "rgb(255, 255, 255)", "Maintenance curative"),
      ],
      images: [],
      logoCandidates: [],
      brandName: "Acme",
      pageTitle: "Acme",
      pageUrl: "https://acme.test/",
      typography: { stacks: { body: ["Inter"], heading: ["Inter"], paragraph: ["Inter"] }, sizes: {} },
      frameworkHints: [],
      colorScheme: "light",
      pageBackground: "rgb(255, 255, 255)",
      backgroundCandidates: [{ color: "rgb(255, 255, 255)", source: "body", priority: 100 }],
    } as any);

    const by = Object.fromEntries(profile.__button_snapshots.map((b: any) => [b.text, b]));
    expect(by["Entretien préventif"].textColor).toBe("#FFFFFF");
    expect(by["Voir plus"].textColor).toBe("#000000");
    expect(by["Maintenance curative"].textColor).toBe("#FFFFFF");
  });
});
