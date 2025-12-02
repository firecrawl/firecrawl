import { hexify } from "../../../lib/branding/processor";

describe("hexify color conversion", () => {
  describe("basic color formats", () => {
    it("converts rgb to hex", () => {
      expect(hexify("rgb(255, 0, 0)")).toBe("#FF0000");
      expect(hexify("rgb(0, 255, 0)")).toBe("#00FF00");
      expect(hexify("rgb(0, 0, 255)")).toBe("#0000FF");
      expect(hexify("rgb(128, 128, 128)")).toBe("#808080");
    });

    it("converts rgba to hex (opaque)", () => {
      expect(hexify("rgba(255, 0, 0, 1)")).toBe("#FF0000");
      expect(hexify("rgba(0, 255, 0, 1.0)")).toBe("#00FF00");
      expect(hexify("rgba(0, 0, 255, 1)")).toBe("#0000FF");
    });

    it("converts hex to hex (normalized)", () => {
      expect(hexify("#ff0000")).toBe("#FF0000");
      expect(hexify("#00ff00")).toBe("#00FF00");
      expect(hexify("#0000ff")).toBe("#0000FF");
    });

    it("handles black colors correctly", () => {
      expect(hexify("rgb(0, 0, 0)")).toBe("#000000");
      expect(hexify("rgba(0, 0, 0, 1)")).toBe("#000000");
      expect(hexify("#000000")).toBe("#000000");
    });

    it("handles white colors correctly", () => {
      expect(hexify("rgb(255, 255, 255)")).toBe("#FFFFFF");
      expect(hexify("rgba(255, 255, 255, 1)")).toBe("#FFFFFF");
      expect(hexify("#ffffff")).toBe("#FFFFFF");
    });
  });

  describe("transparent colors", () => {
    it("returns null for fully transparent colors", () => {
      expect(hexify("rgba(0, 0, 0, 0)")).toBeNull();
      expect(hexify("rgba(255, 255, 255, 0)")).toBeNull();
      expect(hexify("rgba(100, 200, 50, 0)")).toBeNull();
    });

    it("returns null for very low alpha values", () => {
      expect(hexify("rgba(0, 0, 0, 0.001)")).toBeNull();
      expect(hexify("rgba(255, 255, 255, 0.005)")).toBeNull();
    });

    it("handles transparent keyword", () => {
      expect(hexify("transparent")).toBeNull();
    });
  });

  describe("semi-transparent colors without background", () => {
    it("blends semi-transparent colors with default white background", () => {
      // rgba(255, 255, 255, 0.5) on white = white
      const result = hexify("rgba(255, 255, 255, 0.5)");
      expect(result).toBe("#FFFFFF");

      // rgba(0, 0, 0, 0.5) on white = gray
      const black50 = hexify("rgba(0, 0, 0, 0.5)");
      expect(black50).toBe("#808080");

      // rgba(255, 0, 0, 0.5) on white = light red
      const red50 = hexify("rgba(255, 0, 0, 0.5)");
      // Expected: 0.5 * 255 + 0.5 * 255 = 255 for red, 0.5 * 0 + 0.5 * 255 = 127.5 ≈ 128 for others
      expect(red50).toBe("#FF8080");
    });

    it("blends semi-transparent colors correctly with different alpha values", () => {
      // rgba(0, 0, 0, 0.2) on white = very light gray
      const black20 = hexify("rgba(0, 0, 0, 0.2)");
      // Expected: 0.2 * 0 + 0.8 * 255 = 204
      expect(black20).toBe("#CCCCCC");

      // rgba(0, 0, 0, 0.8) on white = dark gray
      const black80 = hexify("rgba(0, 0, 0, 0.8)");
      // Expected: 0.8 * 0 + 0.2 * 255 = 51
      expect(black80).toBe("#333333");
    });
  });

  describe("semi-transparent colors with opaque background", () => {
    it("blends semi-transparent colors with provided background", () => {
      // rgba(255, 255, 255, 0.5) on black = gray
      const whiteOnBlack = hexify("rgba(255, 255, 255, 0.5)", "rgb(0, 0, 0)");
      // Expected: 0.5 * 255 + 0.5 * 0 = 127.5 ≈ 128
      expect(whiteOnBlack).toBe("#808080");

      // rgba(0, 0, 0, 0.5) on black = black
      const blackOnBlack = hexify("rgba(0, 0, 0, 0.5)", "rgb(0, 0, 0)");
      expect(blackOnBlack).toBe("#000000");

      // rgba(255, 0, 0, 0.5) on blue = purple
      const redOnBlue = hexify("rgba(255, 0, 0, 0.5)", "rgb(0, 0, 255)");
      // Expected: R: 0.5 * 255 + 0.5 * 0 = 127.5 ≈ 128, G: 0, B: 0.5 * 0 + 0.5 * 255 = 127.5 ≈ 128
      expect(redOnBlue).toBe("#800080");
    });

    it("blends with colored backgrounds correctly", () => {
      // rgba(255, 255, 255, 0.5) on red = light red/pink
      const whiteOnRed = hexify("rgba(255, 255, 255, 0.5)", "rgb(255, 0, 0)");
      // Expected: R: 0.5 * 255 + 0.5 * 255 = 255, G: 0.5 * 255 + 0.5 * 0 = 127.5 ≈ 128, B: 0.5 * 255 + 0.5 * 0 = 127.5 ≈ 128
      expect(whiteOnRed).toBe("#FF8080");
    });
  });

  describe("semi-transparent colors with transparent background", () => {
    it("falls back to white when background is transparent", () => {
      // rgba(255, 255, 255, 0.5) on transparent = white (blended with white default)
      const whiteOnTransparent = hexify(
        "rgba(255, 255, 255, 0.5)",
        "rgba(0, 0, 0, 0)",
      );
      expect(whiteOnTransparent).toBe("#FFFFFF");

      // rgba(0, 0, 0, 0.5) on transparent = gray (blended with white default, not black)
      const blackOnTransparent = hexify(
        "rgba(0, 0, 0, 0.5)",
        "rgba(0, 0, 0, 0)",
      );
      // Expected: 0.5 * 0 + 0.5 * 255 = 127.5 ≈ 128 (gray, not black)
      expect(blackOnTransparent).toBe("#808080");
    });

    it("falls back to white when background has very low alpha", () => {
      // rgba(255, 255, 255, 0.5) on nearly transparent = white
      const whiteOnNearTransparent = hexify(
        "rgba(255, 255, 255, 0.5)",
        "rgba(0, 0, 0, 0.001)",
      );
      expect(whiteOnNearTransparent).toBe("#FFFFFF");

      // rgba(0, 0, 0, 0.5) on nearly transparent = gray (not black)
      const blackOnNearTransparent = hexify(
        "rgba(0, 0, 0, 0.5)",
        "rgba(0, 0, 0, 0.005)",
      );
      expect(blackOnNearTransparent).toBe("#808080");
    });

    it("uses background when alpha is above threshold", () => {
      // rgba(0, 0, 0, 0.5) on semi-transparent black (alpha 0.1) = should use the background
      const blackOnSemiTransparent = hexify(
        "rgba(0, 0, 0, 0.5)",
        "rgba(0, 0, 0, 0.1)",
      );
      // Background alpha 0.1 is above 0.01 threshold, so it should be used
      // But wait, the background itself is semi-transparent. Let me think...
      // Actually, the background is parsed and if its alpha >= 0.01, we use its RGB values
      // So rgba(0, 0, 0, 0.1) gives us RGB(0, 0, 0) as background
      // Then rgba(0, 0, 0, 0.5) on rgb(0, 0, 0) = 0.5 * 0 + 0.5 * 0 = 0 = black
      expect(blackOnSemiTransparent).toBe("#000000");
    });
  });

  describe("edge cases", () => {
    it("handles null and undefined inputs", () => {
      expect(hexify(null as any)).toBeNull();
      expect(hexify(undefined as any)).toBeNull();
      expect(hexify("")).toBeNull();
    });

    it("handles invalid color strings", () => {
      expect(hexify("not a color")).toBeNull();
      expect(hexify("rgb(invalid)")).toBeNull();
      expect(hexify("#gggggg")).toBeNull();
    });

    it("handles null background parameter", () => {
      // Should default to white
      const result = hexify("rgba(0, 0, 0, 0.5)", null);
      expect(result).toBe("#808080");
    });

    it("handles invalid background color", () => {
      // Should default to white when background is invalid
      const result = hexify("rgba(0, 0, 0, 0.5)", "invalid background");
      expect(result).toBe("#808080");
    });

    it("clamps color values to valid range", () => {
      // Colors outside 0-255 range should be clamped
      // This is handled by culori, but we test the output is valid hex
      const result = hexify("rgb(300, -10, 128)");
      expect(result).toMatch(/^#[0-9A-F]{6}$/);
    });
  });

  describe("regression tests for fixed issues", () => {
    it("prevents translucent overlays from being treated as opaque black", () => {
      // Before fix: rgba(0, 0, 0, 0.2) would be treated as #000000
      // After fix: rgba(0, 0, 0, 0.2) on white = #CCCCCC
      const translucentBlack = hexify("rgba(0, 0, 0, 0.2)");
      expect(translucentBlack).not.toBe("#000000");
      expect(translucentBlack).toBe("#CCCCCC");
    });

    it("prevents transparent backgrounds from being treated as black", () => {
      // Before fix: rgba(255, 255, 255, 0.5) on transparent would blend with black
      // After fix: rgba(255, 255, 255, 0.5) on transparent = white (blended with white)
      const whiteOnTransparent = hexify(
        "rgba(255, 255, 255, 0.5)",
        "rgba(0, 0, 0, 0)",
      );
      expect(whiteOnTransparent).toBe("#FFFFFF");
    });

    it("handles opaque black backgrounds correctly", () => {
      // rgb(0, 0, 0) is a valid opaque black background, not transparent
      const blackBg = hexify("rgba(255, 255, 255, 0.5)", "rgb(0, 0, 0)");
      expect(blackBg).toBe("#808080");
    });

    it("handles semi-transparent black backgrounds correctly", () => {
      // rgba(0, 0, 0, 0.8) is a valid dark background, not transparent
      const darkBg = hexify("rgba(255, 255, 255, 0.5)", "rgba(0, 0, 0, 0.8)");
      // Background alpha 0.8 >= 0.01, so use it
      // rgba(255, 255, 255, 0.5) on rgb(0, 0, 0) = 0.5 * 255 + 0.5 * 0 = 127.5 ≈ 128
      expect(darkBg).toBe("#808080");
    });
  });
});
