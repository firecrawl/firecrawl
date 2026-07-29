import { specialtyScrapeCheck } from "./specialtyHandler";
import { UnsupportedFileError } from "../../error";
import winston from "winston";

const silentLogger = winston.createLogger({
  silent: true,
  transports: [new winston.transports.Console({ silent: true })],
});

describe("specialtyScrapeCheck — legacy .doc rejection", () => {
  it("rejects application/msword with UnsupportedFileError", async () => {
    await expect(
      specialtyScrapeCheck(silentLogger, {
        "content-type": "application/msword",
      }),
    ).rejects.toBeInstanceOf(UnsupportedFileError);
  });

  it("rejects octet-stream with OLE2/CFB signature", async () => {
    const oleBase64 = "0M8R4KGxGuE=";
    const feRes = {
      url: "https://example.com/file.doc",
      file: { content: oleBase64 },
      content: "",
    } as any;
    await expect(
      specialtyScrapeCheck(
        silentLogger,
        { "content-type": "application/octet-stream" },
        feRes,
      ),
    ).rejects.toBeInstanceOf(UnsupportedFileError);
  });
});
