import { describe, expect, it } from "vitest";
import { coreParts, defaultModules } from "../service";
import type { Engine } from "../service/engines";
import { testService, withService } from "../service/testing";
import { imageOcrGate, isImageOcrEnabled } from "./image-ocr-gate";

function makeImageEngine(enabled: boolean, cache = false): Engine {
  return {
    name: cache ? "pdf" : "document",
    quality: 1,
    fileOnly: true,
    cache,
    features: { image: true },
    enabled: () => enabled,
    scrape: async () => {
      throw new Error("not used");
    },
    maxReasonableTime: () => 1000,
  };
}

describe("isImageOcrEnabled", () => {
  it("returns false when no service is installed or no non-cache image engine is enabled", async () => {
    expect(isImageOcrEnabled()).toBe(false);

    const disabledSvc = testService(defaultModules(), coreParts(), {}, [
      {
        name: "image-ext",
        engines: [makeImageEngine(false), makeImageEngine(true, true)],
      },
    ]);
    await withService(disabledSvc, async () => {
      expect(isImageOcrEnabled()).toBe(false);
    });
  });

  it("returns true when an extension registers an enabled non-cache image engine", async () => {
    const enabledSvc = testService(defaultModules(), coreParts(), {}, [
      { name: "image-ext", engines: [makeImageEngine(true)] },
    ]);
    await withService(enabledSvc, async () => {
      expect(isImageOcrEnabled()).toBe(true);
    });
  });
});

describe("imageOcrGate", () => {
  it("is off when the request did not ask for the image parser", async () => {
    const enabledSvc = testService(defaultModules(), coreParts(), {}, [
      { name: "image-ext", engines: [makeImageEngine(true)] },
    ]);
    await withService(enabledSvc, async () => {
      await expect(imageOcrGate(false)()).resolves.toBe(false);
    });
  });

  it("follows the registered image engine availability for requests that asked", async () => {
    const enabledSvc = testService(defaultModules(), coreParts(), {}, [
      { name: "image-ext", engines: [makeImageEngine(true)] },
    ]);
    const disabledSvc = testService(defaultModules(), coreParts(), {}, [
      { name: "image-ext", engines: [makeImageEngine(false)] },
    ]);

    await withService(enabledSvc, async () => {
      await expect(imageOcrGate(true)()).resolves.toBe(true);
    });
    await withService(disabledSvc, async () => {
      await expect(imageOcrGate(true)()).resolves.toBe(false);
    });
  });
});
