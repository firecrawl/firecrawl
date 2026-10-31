const mocks = vi.hoisted(() => ({
  attemptRequest: vi.fn(async (_url: string, _data: string) => [
    { url: "https://example.com/" },
  ]),
}));

vi.mock("../config", () => ({
  config: { FIRE_ENGINE_BETA_URL: "http://fire-engine.test" },
}));
vi.mock("../lib/retry-utils", () => ({
  attemptRequest: mocks.attemptRequest,
  executeWithRetry: (request: () => Promise<unknown>) => request(),
}));

import { fireEngineMap } from "./fireEngine";

describe("fireEngineMap", () => {
  beforeEach(() => {
    mocks.attemptRequest.mockClear();
  });

  it.each([true, false])(
    "tells fire-engine whether the map request is zero data retention (%s)",
    async zeroDataRetention => {
      await fireEngineMap("site:example.com", {
        numResults: 100,
        page: 1,
        zeroDataRetention,
      });
      expect(mocks.attemptRequest).toHaveBeenCalledTimes(1);
      const [url, body] = mocks.attemptRequest.mock.calls[0];
      expect(url).toBe("http://fire-engine.test/map");
      expect(JSON.parse(body).zeroDataRetention).toBe(zeroDataRetention);
    },
  );
});
