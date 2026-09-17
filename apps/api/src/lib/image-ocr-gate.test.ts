import { beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../config";
import { getACUCTeam } from "../controllers/auth";
import { imageOcrGate, isImageOcrEnabled } from "./image-ocr-gate";

vi.mock("../config", () => ({
  config: {
    FIRE_PDF_BASE_URL: "http://fire-pdf.test",
    IMAGE_OCR_ENABLED: false,
  },
}));

vi.mock("../controllers/auth", () => ({
  getACUCTeam: vi.fn(),
}));

vi.mock("./logger", () => ({
  logger: { warn: vi.fn() },
}));

const mockedGetACUCTeam = vi.mocked(getACUCTeam);
const mutableConfig = config as {
  FIRE_PDF_BASE_URL?: string;
  IMAGE_OCR_ENABLED: boolean;
};

async function withConfig<T>(
  overrides: Partial<typeof mutableConfig>,
  run: () => T | Promise<T>,
): Promise<T> {
  const previous = { ...mutableConfig };
  Object.assign(mutableConfig, overrides);
  try {
    return await run();
  } finally {
    Object.assign(mutableConfig, previous);
  }
}

describe("isImageOcrEnabled", () => {
  it("follows the deployment default for teams without the flag", async () => {
    expect(isImageOcrEnabled(null)).toBe(false);
    expect(isImageOcrEnabled(undefined)).toBe(false);
    expect(isImageOcrEnabled({})).toBe(false);
    await withConfig({ IMAGE_OCR_ENABLED: true }, () => {
      expect(isImageOcrEnabled(null)).toBe(true);
      expect(isImageOcrEnabled(undefined)).toBe(true);
      expect(isImageOcrEnabled({})).toBe(true);
    });
  });

  it("lets the imageOcr team flag override the default in both directions", async () => {
    expect(isImageOcrEnabled({ imageOcr: true })).toBe(true);
    expect(isImageOcrEnabled({ imageOcr: false })).toBe(false);
    await withConfig({ IMAGE_OCR_ENABLED: true }, () => {
      expect(isImageOcrEnabled({ imageOcr: true })).toBe(true);
      expect(isImageOcrEnabled({ imageOcr: false })).toBe(false);
    });
  });

  it("requires FirePDF to be configured whatever the flag or default", async () => {
    await withConfig(
      { FIRE_PDF_BASE_URL: undefined, IMAGE_OCR_ENABLED: true },
      () => {
        expect(isImageOcrEnabled({ imageOcr: true })).toBe(false);
        expect(isImageOcrEnabled(null)).toBe(false);
      },
    );
  });
});

describe("imageOcrGate", () => {
  beforeEach(() => {
    mockedGetACUCTeam.mockReset();
  });

  it("is off without the image parser and never looks the team up", async () => {
    await expect(
      imageOcrGate("team", { imageOcr: true }, false)(),
    ).resolves.toBe(false);
    await expect(imageOcrGate("team", undefined, false)()).resolves.toBe(false);
    await withConfig({ IMAGE_OCR_ENABLED: true }, () =>
      expect(imageOcrGate("team", undefined, false)()).resolves.toBe(false),
    );
    expect(mockedGetACUCTeam).not.toHaveBeenCalled();
  });

  it("uses the flags carried on the job without a lookup", async () => {
    await expect(
      imageOcrGate("team", { imageOcr: true }, true)(),
    ).resolves.toBe(true);
    await expect(imageOcrGate("team", null, true)()).resolves.toBe(false);
    await withConfig({ IMAGE_OCR_ENABLED: true }, async () => {
      await expect(imageOcrGate("team", null, true)()).resolves.toBe(true);
      await expect(
        imageOcrGate("team", { imageOcr: false }, true)(),
      ).resolves.toBe(false);
    });
    expect(mockedGetACUCTeam).not.toHaveBeenCalled();
  });

  it("falls back to the cached team ACUC once per scrape when the job carries no flags", async () => {
    mockedGetACUCTeam.mockResolvedValueOnce({
      flags: { imageOcr: true },
    } as Awaited<ReturnType<typeof getACUCTeam>>);
    const gate = imageOcrGate("team", undefined, true);
    await expect(gate()).resolves.toBe(true);
    await expect(gate()).resolves.toBe(true);
    expect(mockedGetACUCTeam).toHaveBeenCalledTimes(1);
    expect(mockedGetACUCTeam).toHaveBeenCalledWith("team");

    mockedGetACUCTeam.mockResolvedValueOnce(null);
    await expect(imageOcrGate("team", undefined, true)()).resolves.toBe(false);
  });

  it("honours a team opt-out found through the lookup when the default is on", async () => {
    await withConfig({ IMAGE_OCR_ENABLED: true }, async () => {
      mockedGetACUCTeam.mockResolvedValueOnce({
        flags: { imageOcr: false },
      } as Awaited<ReturnType<typeof getACUCTeam>>);
      await expect(imageOcrGate("team", undefined, true)()).resolves.toBe(
        false,
      );
      mockedGetACUCTeam.mockResolvedValueOnce(null);
      await expect(imageOcrGate("team", undefined, true)()).resolves.toBe(true);
    });
  });

  it("leaves image OCR off when the lookup fails, whatever the default", async () => {
    mockedGetACUCTeam.mockRejectedValueOnce(new Error("redis down"));
    await expect(imageOcrGate("team", undefined, true)()).resolves.toBe(false);
    await withConfig({ IMAGE_OCR_ENABLED: true }, async () => {
      // The team may have opted out; an unreadable flag must not be
      // overridden by the deployment default.
      mockedGetACUCTeam.mockRejectedValueOnce(new Error("redis down"));
      await expect(imageOcrGate("team", undefined, true)()).resolves.toBe(
        false,
      );
    });
  });

  it("uses the deployment default when the job carries no team", async () => {
    await expect(imageOcrGate(undefined, undefined, true)()).resolves.toBe(
      false,
    );
    await withConfig({ IMAGE_OCR_ENABLED: true }, () =>
      expect(imageOcrGate(undefined, undefined, true)()).resolves.toBe(true),
    );
    expect(mockedGetACUCTeam).not.toHaveBeenCalled();
  });
});
