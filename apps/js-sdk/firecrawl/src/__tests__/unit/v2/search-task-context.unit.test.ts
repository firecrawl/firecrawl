import { describe, expect, jest, test } from "@jest/globals";
import { search } from "../../../v2/methods/search";

describe("v2 search task context", () => {
  test("forwards optional task context without changing other options", async () => {
    const http = {
      post: jest.fn(async () => ({ status: 200, data: { success: true } })),
    } as any;

    await search(http, {
      query: "React memo docs",
      objective: "Find official rerender guidance",
    });

    expect(http.post).toHaveBeenCalledWith(
      "/v2/search",
      {
        query: "React memo docs",
        objective: "Find official rerender guidance",
      },
      {},
    );
  });
});
