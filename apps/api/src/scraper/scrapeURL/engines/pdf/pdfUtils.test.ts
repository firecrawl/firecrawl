import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { stripLeadingBytes } from "./pdfUtils";

const PDF = Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n");
const WRAPPER = Buffer.from(
  "------------------------------1234567890\r\n" +
    'Content-Disposition: form-data; name="file"; filename="file.pdf"\r\n' +
    "Content-Type: application/pdf\r\n\r\n",
);

describe("stripLeadingBytes", () => {
  let dir: string;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("rewrites the file in place from the header and leaves no temp file", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "pdfUtils-"));
    const filePath = path.join(dir, "file.pdf");
    await writeFile(filePath, Buffer.concat([WRAPPER, PDF]));

    await stripLeadingBytes(filePath, WRAPPER.length);

    expect(await readFile(filePath)).toEqual(PDF);
    expect(await readdir(dir)).toEqual(["file.pdf"]);
  });

  it("leaves a file alone when there is nothing to strip", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "pdfUtils-"));
    const filePath = path.join(dir, "file.pdf");
    await writeFile(filePath, PDF);

    await stripLeadingBytes(filePath, 0);

    expect(await readFile(filePath)).toEqual(PDF);
  });
});
