import { gzipSync } from "node:zlib";
import { gunzipBounded, MAX_GUNZIPPED_FILE_SIZE } from "./gunzip";

const CAP = 64 * 1024;

describe("gunzipBounded", () => {
  it("inflates output under the cap", async () => {
    const original = Buffer.from("<urlset>".repeat(100));
    const inflated = await gunzipBounded(gzipSync(original), CAP);
    expect(inflated.equals(original)).toBe(true);
  });

  it("inflates output exactly at the cap", async () => {
    const original = Buffer.alloc(CAP, 1);
    const inflated = await gunzipBounded(gzipSync(original), CAP);
    expect(inflated.equals(original)).toBe(true);
  });

  it("rejects output one byte over the cap", async () => {
    const bomb = gzipSync(Buffer.alloc(CAP + 1));
    await expect(gunzipBounded(bomb, CAP)).rejects.toThrow(RangeError);
  });

  it("rejects output over an explicit cap", async () => {
    const bomb = gzipSync(Buffer.alloc(1024 * 1024));
    await expect(gunzipBounded(bomb, CAP)).rejects.toThrow(RangeError);
  });

  describe("ceiling", () => {
    // A few kilobytes of gzip that inflate just past the ceiling.
    const bomb = gzipSync(Buffer.alloc(MAX_GUNZIPPED_FILE_SIZE + 1));

    it("rejects output over the default cap", async () => {
      expect(bomb.length).toBeLessThan(1024 * 1024);
      await expect(gunzipBounded(bomb)).rejects.toThrow(RangeError);
    });

    it.each([MAX_GUNZIPPED_FILE_SIZE * 2, Infinity, NaN])(
      "never raises the cap past the ceiling (%s)",
      async cap => {
        await expect(gunzipBounded(bomb, cap)).rejects.toThrow(RangeError);
      },
    );
  });
});
