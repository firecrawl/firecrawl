const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
}));

vi.mock("undici", async importOriginal => {
  const actual = await importOriginal<typeof import("undici")>();
  return { ...actual, fetch: mocks.fetch };
});

vi.mock("./safeFetch", () => ({
  getSecureDispatcher: () => undefined,
}));

import { UnsupportedFileError } from "../../error";
import { downloadFile, fetchFileToBuffer } from "./downloadFile";

// A response that declares more bytes than the cap allows, with a body that
// records whether it was cancelled.
function oversizedResponse() {
  const cancel = vi.fn().mockResolvedValue(undefined);
  const response = {
    status: 200,
    headers: new Headers({ "content-length": "1000" }),
    body: { cancel },
  };
  return { response, cancel };
}

beforeEach(() => {
  mocks.fetch.mockReset();
});

describe("declared size over the cap", () => {
  it("fetchFileToBuffer cancels the body before rejecting", async () => {
    const { response, cancel } = oversizedResponse();
    mocks.fetch.mockResolvedValue(response);

    await expect(
      fetchFileToBuffer("https://example.com/big.docx", false, undefined, 10),
    ).rejects.toThrow(UnsupportedFileError);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("downloadFile cancels the body before rejecting", async () => {
    const { response, cancel } = oversizedResponse();
    mocks.fetch.mockResolvedValue(response);

    await expect(
      downloadFile(
        "test",
        "https://example.com/big.docx",
        false,
        undefined,
        10,
      ),
    ).rejects.toThrow(UnsupportedFileError);
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
