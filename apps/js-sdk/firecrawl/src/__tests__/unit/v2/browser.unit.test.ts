import { describe, test, expect, vi } from "vitest";
import { browser } from "../../../v2/methods/browser";

describe("JS SDK v2 browser", () => {
  test("sends location when creating a session", async () => {
    const post = vi.fn(async () => ({
      status: 200,
      data: { success: true, id: "session-1" },
    }));

    await browser({ post } as any, { location: { country: "GB" } });

    expect(post).toHaveBeenCalledWith("/v2/browser", {
      location: { country: "GB" },
    });
  });

  test("omits location by default", async () => {
    const post = vi.fn(async () => ({
      status: 200,
      data: { success: true, id: "session-1" },
    }));

    await browser({ post } as any);

    expect(post).toHaveBeenCalledWith("/v2/browser", {});
  });
});
