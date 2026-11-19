import { reconcilePageCountWithPdfParse } from "./pageCount";

describe("reconcilePageCountWithPdfParse", () => {
  it("keeps a failed native detection at 0, so billing stays at the base credit", () => {
    expect(reconcilePageCountWithPdfParse(0, { pagesProcessed: 1000 })).toBe(0);
  });

  it("lowers a native count that pdf-parse truncated at its cap", () => {
    expect(reconcilePageCountWithPdfParse(5000, { pagesProcessed: 1000 })).toBe(
      1000,
    );
  });

  it("keeps a native count within the cap", () => {
    expect(reconcilePageCountWithPdfParse(300, { pagesProcessed: 300 })).toBe(
      300,
    );
    expect(reconcilePageCountWithPdfParse(7, { pagesProcessed: 10 })).toBe(7);
  });

  it("never raises the count", () => {
    expect(reconcilePageCountWithPdfParse(0, { pagesProcessed: 3 })).toBe(0);
    expect(reconcilePageCountWithPdfParse(2, { pagesProcessed: 9 })).toBe(2);
  });

  it("leaves the count alone when pdf-parse reports nothing", () => {
    expect(
      reconcilePageCountWithPdfParse(7, { pagesProcessed: undefined }),
    ).toBe(7);
    expect(reconcilePageCountWithPdfParse(7, null)).toBe(7);
  });
});
