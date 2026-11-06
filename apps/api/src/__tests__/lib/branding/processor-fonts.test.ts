import { describe, expect, it } from "vitest";
import { processRawBranding } from "../../../lib/branding/processor";

const snap = (fontStack: string[], text = "Some text") => ({
  tag: "p",
  classes: "",
  text,
  rect: { w: 600, h: 24 },
  position: { top: 300, left: 0 },
  visible: true,
  colors: {
    text: "rgb(20, 20, 20)",
    background: "rgba(0, 0, 0, 0)",
    border: "rgba(0, 0, 0, 0)",
    borderWidth: 0,
  },
  typography: { fontStack, size: "16px", weight: 400 },
  radius: 0,
  borderRadius: { topLeft: 0, topRight: 0, bottomRight: 0, bottomLeft: 0 },
  shadow: null,
  isButton: false,
  isNavigation: false,
  hasCTAIndicator: false,
  isInput: false,
  isLink: false,
});

const raw = (
  stacks: { body: string[]; heading: string[]; paragraph: string[] },
  snapshots: ReturnType<typeof snap>[],
) =>
  ({
    cssData: { colors: [], spacings: [], radii: [] },
    snapshots,
    images: [],
    logoCandidates: [],
    brandName: "Acme",
    pageTitle: "Acme",
    pageUrl: "https://acme.test/",
    typography: { stacks, sizes: {} },
    frameworkHints: [],
    colorScheme: "light" as const,
    pageBackground: "rgb(255, 255, 255)",
    backgroundCandidates: [
      { color: "rgb(255, 255, 255)", source: "body", priority: 100 },
    ],
  }) as any;

const families = (profile: any) =>
  (profile.fonts as Array<{ family: string; count: number }>).map(
    f => `${f.family}:${f.count}`,
  );

describe("fonts the page renders", () => {
  it("counts one family per stack, the one it shows", () => {
    const system = [
      "-apple-system",
      "BlinkMacSystemFont",
      "Segoe UI",
      "Roboto",
      "sans-serif",
    ];
    const inter = ["inter-variable-web", ...system];
    const profile = processRawBranding(
      raw(
        { body: inter, heading: ["recoleta-web", "Georgia", "serif"], paragraph: inter },
        [snap(inter), snap(inter), snap(system), snap(["Georgia", "serif"])],
      ),
    );

    // Not "Segoe UI" or "Roboto": a system stack names no brand font, and
    // the fallbacks of a styled stack are not what it renders. Build
    // suffixes come off the names the API reports.
    expect(families(profile)).toEqual(["Inter:4", "Recoleta:1", "Georgia:1"]);
  });

  it("looks past a site builder's hashed alias to the face behind it", () => {
    const wix = [
      "wfont_2feeec_e1b10df92bd244baba1e35d632c6fa41",
      "wf_e1b10df92bd244baba1e35d63",
      "orig_libre_baskerville",
    ];
    const profile = processRawBranding(
      raw(
        { body: ["Arial", "Helvetica", "sans-serif"], heading: wix, paragraph: wix },
        [snap(wix), snap(wix), snap(["wf_38b82f6a99a44d63a0bc6a5d605011dd"])],
      ),
    );

    // The alias resolves to the face behind it, spelled as a family name.
    expect(families(profile)).toEqual(["Libre Baskerville:4", "Arial:1"]);
  });

  it("reports a page set entirely in generic or system fonts as such, not as its fallbacks", () => {
    const generic = ["sans-serif"];
    const plain = processRawBranding(
      raw({ body: generic, heading: generic, paragraph: generic }, [snap(generic)]),
    );
    expect(families(plain)).toEqual(["sans-serif:1"]);
    expect(plain.typography?.fontFamilies).toEqual({
      primary: "sans-serif",
      heading: "sans-serif",
    });

    const system = ["-apple-system", "BlinkMacSystemFont", "Roboto", "Arial", "sans-serif"];
    const espn = processRawBranding(
      raw({ body: system, heading: system, paragraph: system }, [snap(system), snap(["a"])]),
    );
    // Not "Roboto", "Arial" or the one-letter declaration.
    expect(families(espn)).toEqual(["system-ui:1"]);
    expect(espn.typography?.fontFamilies).toEqual({
      primary: "system-ui",
      heading: "system-ui",
    });

    // An empty body measurement: the fallback still comes from another stack,
    // and a ui-monospace stack is reported as itself, not as system-ui.
    const mono = ["ui-monospace", "Menlo", "monospace"];
    const code = processRawBranding(
      raw({ body: [], heading: mono, paragraph: [] }, [snap(mono)]),
    );
    expect(families(code)).toEqual(["ui-monospace:1"]);
  });
});
