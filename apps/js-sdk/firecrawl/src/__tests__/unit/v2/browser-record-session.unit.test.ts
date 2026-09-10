import { describe, expect, jest, test } from "@jest/globals";
import { browser } from "../../../v2/methods/browser";

function httpMock() {
  return {
    post: jest.fn(
      async () => ({ status: 200, data: { success: true, id: "sess_123" } }),
    ),
  } as any;
}

describe("v2 browser recordSession", () => {
  test("forwards recordSession: false so session recording can be disabled", async () => {
    const http = httpMock();

    await browser(http, { recordSession: false });

    expect(http.post).toHaveBeenCalledWith(
      "/v2/browser",
      { recordSession: false },
    );
  });

  test("omits recordSession when the caller does not set it (server default applies)", async () => {
    const http = httpMock();

    await browser(http, { ttl: 600 });

    expect(http.post).toHaveBeenCalledWith("/v2/browser", { ttl: 600 });
    const payload = http.post.mock.calls[0][1] as Record<string, unknown>;
    expect(payload).not.toHaveProperty("recordSession");
  });
});
