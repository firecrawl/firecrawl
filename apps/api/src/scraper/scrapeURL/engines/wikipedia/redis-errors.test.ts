const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  del: vi.fn(),
  fetch: vi.fn(),
}));
vi.mock("undici", () => ({ fetch: mocks.fetch }));
vi.mock("../../../../services/queue-service", () => ({
  getRedisConnection: () => ({ get: mocks.get, del: mocks.del }),
}));
vi.mock("../../../../services/redlock", () => ({ redlock: {} }));
import { scrapeURLWithWikipedia } from "./index";
const meta = {
  url: "https://en.wikipedia.org/wiki/Test",
  logger: { info: vi.fn(), warn: vi.fn() },
} as any;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockResolvedValue("test-token");
  mocks.del.mockResolvedValue(1);
  mocks.fetch.mockImplementation(async (url: string) =>
    url.includes("w/api.php")
      ? { ok: true, json: async () => ({}) }
      : { status: 401 },
  );
});
it("preserves the authorization error when token deletion succeeds", async () => {
  await expect(scrapeURLWithWikipedia(meta)).rejects.toThrow(
    "authorization failed (401)",
  );
  expect(mocks.del).toHaveBeenCalled();
});
it("retains both authorization and original Redis cleanup errors", async () => {
  const error = new Error("original Redis DEL failure");
  mocks.del.mockRejectedValueOnce(error);
  await expect(scrapeURLWithWikipedia(meta)).rejects.toMatchObject({
    errors: [
      expect.objectContaining({
        message: expect.stringContaining("authorization failed (401)"),
      }),
      error,
    ],
  });
});
it("propagates the original token read failure", async () => {
  const error = new Error("original Redis GET failure");
  mocks.get.mockRejectedValueOnce(error);
  await expect(scrapeURLWithWikipedia(meta)).rejects.toBe(error);
});
