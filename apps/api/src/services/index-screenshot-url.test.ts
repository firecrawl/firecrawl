import { describe, expect, it } from "vitest";
import {
  getGcsScreenshotUrlResignReason,
  getGcsSignedUrlExpiration,
} from "./index-screenshot-url";

describe("index screenshot signed URLs", () => {
  it("parses v2 and v4 expiration times", () => {
    const v2Url = new URL(
      "https://storage.googleapis.com/media-bucket/screenshot.png?Expires=4102444800",
    );
    const v4Url = new URL(
      "https://storage.googleapis.com/media-bucket/screenshot.png?X-Goog-Date=20300101T000000Z&X-Goog-Expires=60",
    );

    expect(getGcsSignedUrlExpiration(v2Url)).toBe(4102444800000);
    expect(getGcsSignedUrlExpiration(v4Url)).toBe(
      Date.UTC(2030, 0, 1, 0, 1, 0),
    );
  });

  it("requests re-signing when the URL is expired", () => {
    const url = new URL(
      "https://storage.googleapis.com/media-bucket/screenshot.png?GoogleAccessId=current%40project.iam.gserviceaccount.com&Expires=100",
    );

    expect(
      getGcsScreenshotUrlResignReason(url, {
        now: 101000,
      }),
    ).toBe("expired");
  });

  it("requests re-signing when the index entry predates GCS_SCREENSHOT_RESIGN_BEFORE", () => {
    const url = new URL(
      "https://storage.googleapis.com/media-bucket/screenshot.png?GoogleAccessId=current%40project.iam.gserviceaccount.com&Expires=4102444800",
    );

    expect(
      getGcsScreenshotUrlResignReason(url, {
        now: Date.UTC(2026, 5, 25),
        indexCreatedAt: "2026-06-24T19:59:59.000Z",
        resignBefore: "2026-06-24T20:00:00.000Z",
      }),
    ).toBe("resign_before");
  });

  it("does not re-sign when the index entry is on or after GCS_SCREENSHOT_RESIGN_BEFORE", () => {
    const url = new URL(
      "https://storage.googleapis.com/media-bucket/screenshot.png?GoogleAccessId=current%40project.iam.gserviceaccount.com&Expires=4102444800",
    );

    expect(
      getGcsScreenshotUrlResignReason(url, {
        now: Date.UTC(2026, 5, 25),
        indexCreatedAt: "2026-06-24T20:00:00.000Z",
        resignBefore: "2026-06-24T20:00:00.000Z",
      }),
    ).toBeNull();
  });

  it("does not re-sign non-GCS URLs before GCS_SCREENSHOT_RESIGN_BEFORE", () => {
    const url = new URL(
      "https://cdn.example.com/screenshot.png?GoogleAccessId=current%40project.iam.gserviceaccount.com&Expires=100",
    );

    expect(
      getGcsScreenshotUrlResignReason(url, {
        now: 101000,
        indexCreatedAt: "2026-06-24T19:59:59.000Z",
        resignBefore: "2026-06-24T20:00:00.000Z",
      }),
    ).toBeNull();
  });
});
