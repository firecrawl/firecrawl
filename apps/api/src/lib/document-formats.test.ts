import { describe, expect, it } from "vitest";
import { documentExtensionFromUrlPath } from "./document-formats";

describe("documentExtensionFromUrlPath", () => {
  it.each([
    ["/archive.docx/report.csv", ".csv"],
    ["/archive.xlsx/report.doc", ".doc"],
    ["/archive.pptx/report.odt", ".odt"],
    ["/archive.docx/report.csv/download", ".csv"],
    ["/archive.docx/report.csv/hash/", ".csv"],
    ["/ARCHIVE.DOCX/REPORT.CSV/download", ".csv"],
  ])("uses the nearest filename segment in %s", (pathname, extension) => {
    expect(documentExtensionFromUrlPath(pathname)).toBe(extension);
  });

  it.each([
    ["/report.docx", ".docx"],
    ["/report.DOC", ".doc"],
    ["/report.xlsx/hash", ".xlsx"],
    ["/report.csv/download/", ".csv"],
    ["/download", null],
    ["/report.csv.bak", null],
    ["/report.docxml/path", null],
    ["/report.pdf", null],
  ])("preserves existing path classification for %s", (pathname, extension) => {
    expect(documentExtensionFromUrlPath(pathname)).toBe(extension);
  });
});
