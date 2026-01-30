import { detectSpecialtyPlan } from "./specialtyHandler";
import { logger as baseLogger } from "../../../../lib/logger";
import { stat, unlink } from "fs/promises";

describe("detectSpecialtyPlan", () => {
  it("detects PDFs via content-type", async () => {
    const plan = await detectSpecialtyPlan(baseLogger, {
      contentType: "application/pdf",
    });

    expect(plan?.type).toBe("pdf");
    expect(plan?.contentType).toBe("application/pdf");
  });

  it("detects PDFs via signature when content-type is missing", async () => {
    const plan = await detectSpecialtyPlan(baseLogger, {
      body: "%PDF-1.5",
    });

    expect(plan?.type).toBe("pdf");
    expect(plan?.contentType).toBeUndefined();
  });

  it("detects documents via signature and creates a prefetch file", async () => {
    const binaryContent = Buffer.from("PK\u0003\u0004").toString("base64");
    let filePath: string | undefined;

    try {
      const plan = await detectSpecialtyPlan(baseLogger, {
        contentType: "application/octet-stream",
        binaryFile: { content: binaryContent },
        url: "https://example.com/file",
        status: 200,
        proxyUsed: "basic",
      });

      expect(plan?.type).toBe("document");
      expect(plan?.prefetch).toBeDefined();
      filePath = plan?.prefetch?.filePath;
      expect(filePath).toBeTruthy();
      if (filePath) {
        await expect(stat(filePath)).resolves.toBeDefined();
      }
    } finally {
      if (filePath) {
        await unlink(filePath);
      }
    }
  });
});
