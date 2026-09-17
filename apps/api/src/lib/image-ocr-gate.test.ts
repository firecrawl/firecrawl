import { describe, expect, it, vi } from "vitest";
import { config } from "../config";
import { imageOcrGate, isImageOcrEnabled } from "./image-ocr-gate";

vi.mock("../config", () => ({
  config: {
    FIRE_PDF_BASE_URL: "http://fire-pdf.test",
    IMAGE_OCR_ENABLED: true,
  },
}));

const mutableConfig = config as {
  FIRE_PDF_BASE_URL?: string;
  IMAGE_OCR_ENABLED: boolean;
};

function withConfig<T>(
  overrides: Partial<typeof mutableConfig>,
  run: () => T,
): T {
  const previous = { ...mutableConfig };
  Object.assign(mutableConfig, overrides);
  try {
    return run();
  } finally {
    Object.assign(mutableConfig, previous);
  }
}

describe("isImageOcrEnabled", () => {
  it("follows the deployment switch", () => {
    expect(isImageOcrEnabled()).toBe(true);
    withConfig({ IMAGE_OCR_ENABLED: false }, () => {
      expect(isImageOcrEnabled()).toBe(false);
    });
  });

  it("requires FirePDF to be configured even with the switch on", () => {
    withConfig({ FIRE_PDF_BASE_URL: undefined }, () => {
      expect(isImageOcrEnabled()).toBe(false);
    });
  });
});

describe("imageOcrGate", () => {
  it("is off when the request did not ask for the image parser", async () => {
    await expect(imageOcrGate(false)()).resolves.toBe(false);
  });

  it("follows the deployment switch for a request that asked", async () => {
    await expect(imageOcrGate(true)()).resolves.toBe(true);
    await withConfig({ IMAGE_OCR_ENABLED: false }, () =>
      expect(imageOcrGate(true)()).resolves.toBe(false),
    );
    await withConfig({ FIRE_PDF_BASE_URL: undefined }, () =>
      expect(imageOcrGate(true)()).resolves.toBe(false),
    );
  });
});
