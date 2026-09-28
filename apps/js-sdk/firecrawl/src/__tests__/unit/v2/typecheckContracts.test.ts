import { describe, expect, jest, test } from "@jest/globals";
import { parse } from "../../../v2/methods/parse";
import { feedback, searchFeedback } from "../../../v2/methods/feedback";

describe("v2 request contracts", () => {
  test.each([
    Buffer.from([0, 1, 2, 3]).subarray(1, 3),
    new Uint8Array([0, 1, 2, 3]).subarray(1, 3),
  ])("uploads only the selected binary bytes", async (data) => {
    const postMultipart = jest.fn(async () => ({
      status: 200,
      data: { success: true, data: {} },
    }));
    await parse({ postMultipart } as any, {
      data,
      filename: "sample.bin",
      contentType: "application/octet-stream",
    });

    const form = postMultipart.mock.calls[0]![1] as FormData;
    const file = form.get("file") as File;
    expect(Array.from(new Uint8Array(await file.arrayBuffer()))).toEqual([
      1, 2,
    ]);
    expect(file.type).toBe("application/octet-stream");
  });

  test("sends feedback fields unchanged", async () => {
    const post = jest.fn(async () => ({
      status: 200,
      data: { success: true },
    }));
    const http = { post } as any;
    await feedback(http, {
      endpoint: "scrape",
      jobId: "job-id",
      rating: "good",
      note: "useful",
    });
    await searchFeedback(http, "search-id", {
      rating: "partial",
      querySuggestions: "more precise",
    });

    expect(post.mock.calls[0]![1]).toEqual({
      endpoint: "scrape",
      jobId: "job-id",
      rating: "good",
      note: "useful",
    });
    expect(post.mock.calls[1]![1]).toEqual({
      rating: "partial",
      querySuggestions: "more precise",
    });
  });
});
