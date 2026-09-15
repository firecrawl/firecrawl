import { describe, expect, jest, test } from "@jest/globals";
import { browser } from "../../../v2/methods/browser";

describe("v2.browser unit", () => {
  test("browser accepts and sends recordSession", async () => {
    const post = jest.fn(async () => ({
      status: 200,
      data: { success: true, id: "session-id" },
    }));

    await browser({ post } as any, { recordSession: false });

    expect(post).toHaveBeenCalledWith("/v2/browser", {
      recordSession: false,
    });
  });
});
