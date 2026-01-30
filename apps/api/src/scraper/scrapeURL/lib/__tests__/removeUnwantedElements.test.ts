import { htmlTransform } from "../removeUnwantedElements";
import { scrapeOptions } from "../../../../controllers/v2/types";
import { HtmlTransformError } from "../../../../lib/error";
import { transformHtml } from "@mendable/firecrawl-rs";

jest.mock("@mendable/firecrawl-rs", () => ({
  transformHtml: jest.fn(),
}));

describe("htmlTransform", () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it("throws HtmlTransformError when the transformer fails", async () => {
    (transformHtml as jest.Mock).mockRejectedValue(new Error("boom"));

    await expect(
      htmlTransform(
        "<html><body>test</body></html>",
        "https://example.com",
        scrapeOptions.parse({}),
      ),
    ).rejects.toBeInstanceOf(HtmlTransformError);
  });
});
