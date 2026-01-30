import { parse } from "../../../v2/methods/parse";

describe("v2.parse unit", () => {
  test("uses multipart upload and /v2/parse endpoint", async () => {
    const postFormData = jest.fn().mockResolvedValue({
      status: 200,
      data: { success: true, data: { markdown: "ok" } },
    });

    const http = { postFormData } as any;
    const file = new Uint8Array([1, 2, 3, 4]);

    await parse(
      http,
      file,
      { formats: ["markdown"] },
      { filename: "sample.txt" },
    );

    expect(postFormData).toHaveBeenCalledTimes(1);
    const [endpoint, form] = postFormData.mock.calls[0];
    expect(endpoint).toBe("/v2/parse");
    expect(form).toBeInstanceOf(FormData);
    expect(form.get("options")).toBe(JSON.stringify({ formats: ["markdown"] }));
    expect(form.get("file")).toBeTruthy();
  });
});
