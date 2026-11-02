import { gzipSync } from "node:zlib";
import { gunzipBounded, MAX_GUNZIPPED_FILE_SIZE } from "./gunzip";

describe("gunzipBounded", () => {
  it("inflates output under the cap", async () => {
    const original = Buffer.from("<urlset>".repeat(100));
    const inflated = await gunzipBounded(gzipSync(original), 16 * 1024);
    expect(inflated.equals(original)).toBe(true);
  });

  it("rejects output over an explicit cap", async () => {
    const bomb = gzipSync(Buffer.alloc(1024 * 1024));
    await expect(gunzipBounded(bomb, 64 * 1024)).rejects.toThrow(RangeError);
  });

  it("rejects output over the default cap", async () => {
    const bomb = gzipSync(Buffer.alloc(MAX_GUNZIPPED_FILE_SIZE + 1));
    expect(bomb.length).toBeLessThan(1024 * 1024);
    await expect(gunzipBounded(bomb)).rejects.toThrow(RangeError);
  });
});
