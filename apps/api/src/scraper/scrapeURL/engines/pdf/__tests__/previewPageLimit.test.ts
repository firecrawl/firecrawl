import { exceedsPreviewPdfPageLimit } from "../pdfUtils";
import { PDFPageLimitExceededError } from "../../../error";
import {
  deserializeTransportableError,
  serializeTransportableError,
} from "../../../../../lib/error-serde";

describe("exceedsPreviewPdfPageLimit", () => {
  it("trips only for preview-shaped teams over the limit", () => {
    expect(exceedsPreviewPdfPageLimit("preview_abc123", 501, 500)).toBe(true);
    expect(
      exceedsPreviewPdfPageLimit("preview_keyless_1.2.3.4", 4000, 500),
    ).toBe(true);
    expect(exceedsPreviewPdfPageLimit("preview", 501, 500)).toBe(true);
  });

  it("allows preview teams at or under the limit", () => {
    expect(exceedsPreviewPdfPageLimit("preview_abc123", 500, 500)).toBe(false);
    expect(exceedsPreviewPdfPageLimit("preview_keyless_1.2.3.4", 12, 500)).toBe(
      false,
    );
  });

  it("never trips for real (keyed) teams", () => {
    expect(
      exceedsPreviewPdfPageLimit(
        "6f616b42-0ed8-571e-823f-ee4aca6b7ce9",
        99999,
        500,
      ),
    ).toBe(false);
    expect(exceedsPreviewPdfPageLimit(undefined, 99999, 500)).toBe(false);
  });

  it("is disabled at limit 0 and inert on unknown page counts", () => {
    expect(exceedsPreviewPdfPageLimit("preview_abc123", 99999, 0)).toBe(false);
    expect(exceedsPreviewPdfPageLimit("preview_abc123", 0, 500)).toBe(false);
  });
});

describe("PDFPageLimitExceededError", () => {
  it("round-trips through serde with its fields", () => {
    const original = new PDFPageLimitExceededError(4000, 500);
    const revived = deserializeTransportableError(
      serializeTransportableError(original),
    );
    expect(revived).toBeInstanceOf(PDFPageLimitExceededError);
    expect((revived as PDFPageLimitExceededError).pageCount).toBe(4000);
    expect((revived as PDFPageLimitExceededError).limit).toBe(500);
    expect(revived?.message).toContain("4000 pages");
    expect(revived?.message).toContain("500-page limit");
  });
});
