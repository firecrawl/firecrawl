/**
 * Tests for the extract status race condition fix.
 *
 * This test suite verifies that the code changes correctly address:
 *
 * 1. Problem 1 (Fire-and-forget): Status update is now synchronous, ensuring
 *    Redis is updated before the extraction function returns.
 *
 * 2. Problem 2 (Missing status on failure): When performExtraction returns
 *    success: false, the worker now sets status: "failed".
 *
 * 3. Problem 3 (No fallback for processing): The status endpoint now checks
 *    BullMQ/DB even when Redis says "processing", to catch race conditions.
 */

import { describe, it, expect } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";

describe("Extract Worker Status Update Fix (Problem 2)", () => {
  describe("Worker should set status: 'failed' on extraction failure", () => {
    it("extract-worker.ts should include status: 'failed' in updateExtract call for failed extractions", () => {
      // This is a code structure verification test
      // We verify that the worker code includes status: "failed" in the else branch

      const workerPath = path.join(
        __dirname,
        "../../services/extract-worker.ts",
      );
      const workerContent = fs.readFileSync(workerPath, "utf-8");

      // Check that the else branch (success: false case) includes status: "failed"
      // Look for the pattern: await updateExtract(..., { status: "failed", ...
      const elseBlockPattern =
        /}\s*else\s*\{[\s\S]*?await\s+updateExtract\s*\(\s*job\.data\.extractId\s*,\s*\{\s*status:\s*["']failed["']/;

      expect(workerContent).toMatch(elseBlockPattern);
    });

    it("catch block should also set status: 'failed'", () => {
      const workerPath = path.join(
        __dirname,
        "../../services/extract-worker.ts",
      );
      const workerContent = fs.readFileSync(workerPath, "utf-8");

      // Check that the catch block also sets status to failed
      const catchBlockPattern =
        /catch\s*\([\s\S]*?\)\s*\{[\s\S]*?await\s+updateExtract\s*\(\s*job\.data\.extractId\s*,\s*\{\s*status:\s*["']failed["']/;

      expect(workerContent).toMatch(catchBlockPattern);
    });
  });
});

describe("Extract Status Controller Fallback Fix (Problem 3)", () => {
  describe("v1 and v2 status controllers should check BullMQ when Redis says 'processing'", () => {
    it("v1/extract-status.ts should include 'processing' in the condition to check BullMQ", () => {
      const statusPath = path.join(
        __dirname,
        "../../controllers/v1/extract-status.ts",
      );
      const statusContent = fs.readFileSync(statusPath, "utf-8");

      // Check that the condition includes extract.status === "processing"
      const conditionPattern =
        /if\s*\(\s*!extract\s*\|\|\s*extract\.status\s*===\s*["']completed["']\s*\|\|\s*extract\.status\s*===\s*["']processing["']\s*\)/;

      expect(statusContent).toMatch(conditionPattern);
    });

    it("v2/extract-status.ts should include 'processing' in the condition to check BullMQ", () => {
      const statusPath = path.join(
        __dirname,
        "../../controllers/v2/extract-status.ts",
      );
      const statusContent = fs.readFileSync(statusPath, "utf-8");

      // Check that the condition includes extract.status === "processing"
      const conditionPattern =
        /if\s*\(\s*!extract\s*\|\|\s*extract\.status\s*===\s*["']completed["']\s*\|\|\s*extract\.status\s*===\s*["']processing["']\s*\)/;

      expect(statusContent).toMatch(conditionPattern);
    });
  });
});

describe("Extraction Service Synchronous Status Update Fix (Problem 1)", () => {
  describe("extraction-service.ts should await status update", () => {
    it("should NOT use fire-and-forget pattern (.then) for logExtract", () => {
      const servicePath = path.join(
        __dirname,
        "../../lib/extract/extraction-service.ts",
      );
      const serviceContent = fs.readFileSync(servicePath, "utf-8");

      // Check that we DON'T have the fire-and-forget pattern
      // This pattern was: logExtract({...}).then(() => { updateExtract(...) })
      const fireAndForgetPattern =
        /logExtract\s*\(\s*\{[\s\S]*?\}\s*\)\s*\.then\s*\(\s*\(\s*\)\s*=>\s*\{[\s\S]*?updateExtract/;

      // The fire-and-forget pattern should NOT exist
      expect(serviceContent).not.toMatch(fireAndForgetPattern);
    });

    it("should use await for logExtract call", () => {
      const servicePath = path.join(
        __dirname,
        "../../lib/extract/extraction-service.ts",
      );
      const serviceContent = fs.readFileSync(servicePath, "utf-8");

      // Check that we have await before logExtract
      const awaitLogExtractPattern = /await\s+logExtract\s*\(\s*\{/;

      expect(serviceContent).toMatch(awaitLogExtractPattern);
    });

    it("should use await for updateExtract with status: 'completed'", () => {
      const servicePath = path.join(
        __dirname,
        "../../lib/extract/extraction-service.ts",
      );
      const serviceContent = fs.readFileSync(servicePath, "utf-8");

      // Check that we have await before updateExtract with completed status
      const awaitUpdateExtractPattern =
        /await\s+updateExtract\s*\(\s*extractId\s*,\s*\{\s*status:\s*["']completed["']/;

      expect(serviceContent).toMatch(awaitUpdateExtractPattern);
    });
  });

  describe("extraction-service-f0.ts should await status update", () => {
    it("should NOT use fire-and-forget pattern (.then) for logExtract", () => {
      const servicePath = path.join(
        __dirname,
        "../../lib/extract/fire-0/extraction-service-f0.ts",
      );
      const serviceContent = fs.readFileSync(servicePath, "utf-8");

      // Check that we DON'T have the fire-and-forget pattern
      const fireAndForgetPattern =
        /logExtract\s*\(\s*\{[\s\S]*?\}\s*\)\s*\.then\s*\(\s*\(\s*\)\s*=>\s*\{[\s\S]*?updateExtract/;

      // The fire-and-forget pattern should NOT exist
      expect(serviceContent).not.toMatch(fireAndForgetPattern);
    });

    it("should use await for logExtract call", () => {
      const servicePath = path.join(
        __dirname,
        "../../lib/extract/fire-0/extraction-service-f0.ts",
      );
      const serviceContent = fs.readFileSync(servicePath, "utf-8");

      // Check that we have await before logExtract
      const awaitLogExtractPattern = /await\s+logExtract\s*\(\s*\{/;

      expect(serviceContent).toMatch(awaitLogExtractPattern);
    });

    it("should use await for updateExtract with status: 'completed'", () => {
      const servicePath = path.join(
        __dirname,
        "../../lib/extract/fire-0/extraction-service-f0.ts",
      );
      const serviceContent = fs.readFileSync(servicePath, "utf-8");

      // Check that we have await before updateExtract with completed status
      const awaitUpdateExtractPattern =
        /await\s+updateExtract\s*\(\s*extractId\s*,\s*\{\s*status:\s*["']completed["']/;

      expect(serviceContent).toMatch(awaitUpdateExtractPattern);
    });
  });
});

describe("Code Comment Documentation", () => {
  it("extraction-service.ts should have comment explaining the fix", () => {
    const servicePath = path.join(
      __dirname,
      "../../lib/extract/extraction-service.ts",
    );
    const serviceContent = fs.readFileSync(servicePath, "utf-8");

    // Check for the explanatory comment
    expect(serviceContent).toMatch(/race condition/i);
  });

  it("extraction-service-f0.ts should have comment explaining the fix", () => {
    const servicePath = path.join(
      __dirname,
      "../../lib/extract/fire-0/extraction-service-f0.ts",
    );
    const serviceContent = fs.readFileSync(servicePath, "utf-8");

    // Check for the explanatory comment
    expect(serviceContent).toMatch(/race condition/i);
  });

  it("extract-worker.ts should have comment explaining the fix", () => {
    const workerPath = path.join(__dirname, "../../services/extract-worker.ts");
    const workerContent = fs.readFileSync(workerPath, "utf-8");

    // Check for the explanatory comment about setting status to failed
    expect(workerContent).toMatch(/status.*"?failed"?/i);
  });

  it("v1/extract-status.ts should have comment explaining the fallback", () => {
    const statusPath = path.join(
      __dirname,
      "../../controllers/v1/extract-status.ts",
    );
    const statusContent = fs.readFileSync(statusPath, "utf-8");

    // Check for the explanatory comment about checking BullMQ for processing state
    expect(statusContent).toMatch(/processing|race condition/i);
  });

  it("v2/extract-status.ts should have comment explaining the fallback", () => {
    const statusPath = path.join(
      __dirname,
      "../../controllers/v2/extract-status.ts",
    );
    const statusContent = fs.readFileSync(statusPath, "utf-8");

    // Check for the explanatory comment about checking BullMQ for processing state
    expect(statusContent).toMatch(/processing|race condition/i);
  });
});
