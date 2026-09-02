import { beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../config";
import { getACUCTeam } from "../controllers/auth";
import { imageOcrGate, isImageOcrEnabled } from "./image-ocr-gate";

vi.mock("../config", () => ({
  config: {
    FIRE_PDF_BASE_URL: "http://fire-pdf.test",
  },
}));

vi.mock("../controllers/auth", () => ({
  getACUCTeam: vi.fn(),
}));

vi.mock("./logger", () => ({
  logger: { warn: vi.fn() },
}));

const mockedGetACUCTeam = vi.mocked(getACUCTeam);

describe("isImageOcrEnabled", () => {
  it("requires the imageOcr team flag", () => {
    expect(isImageOcrEnabled(null)).toBe(false);
    expect(isImageOcrEnabled(undefined)).toBe(false);
    expect(isImageOcrEnabled({})).toBe(false);
    expect(isImageOcrEnabled({ imageOcr: false })).toBe(false);
    expect(isImageOcrEnabled({ imageOcr: true })).toBe(true);
  });

  it("requires FirePDF to be configured even for flagged teams", () => {
    const mutable = config as { FIRE_PDF_BASE_URL?: string };
    const previous = mutable.FIRE_PDF_BASE_URL;
    mutable.FIRE_PDF_BASE_URL = undefined;
    try {
      expect(isImageOcrEnabled({ imageOcr: true })).toBe(false);
    } finally {
      mutable.FIRE_PDF_BASE_URL = previous;
    }
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
    expect(mockedGetACUCTeam).not.toHaveBeenCalled();
  });

  it("uses the flags carried on the job without a lookup", async () => {
    await expect(
      imageOcrGate("team", { imageOcr: true }, true)(),
    ).resolves.toBe(true);
    await expect(imageOcrGate("team", null, true)()).resolves.toBe(false);
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

  it("leaves image OCR off when the lookup fails or there is no team", async () => {
    mockedGetACUCTeam.mockRejectedValueOnce(new Error("redis down"));
    await expect(imageOcrGate("team", undefined, true)()).resolves.toBe(false);
    await expect(imageOcrGate(undefined, undefined, true)()).resolves.toBe(
      false,
    );
  });
});
