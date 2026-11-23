import { describe, expect, it } from "vitest";

import {
  CrawlDenialError,
  ScrapeJobTimeoutError,
  TransportableError,
} from "./error";
import {
  deserializeTransportableError,
  serializeTransportableError,
} from "./error-serde";

const wire = (code: string, payload: unknown) =>
  `${code}|${JSON.stringify(payload)}`;

describe("deserializeTransportableError", () => {
  describe("a code with a class", () => {
    it("round-trips to its class with its fields", () => {
      const original = new CrawlDenialError("Blocked by robots.txt", {
        robotsBlockedUrl: "https://example.com/private",
      });
      const revived = deserializeTransportableError(
        serializeTransportableError(original),
      );

      expect(revived).toBeInstanceOf(CrawlDenialError);
      expect(revived.code).toBe("CRAWL_DENIAL");
      expect(revived.message).toBe("Blocked by robots.txt");
      expect(revived.reason).toBe("Blocked by robots.txt");
      expect(revived.robotsBlockedUrl).toBe("https://example.com/private");
      expect(revived.stack).toBe(original.stack);
    });

    it("reads a payload written as code, separator, JSON", () => {
      const revived = deserializeTransportableError(
        'SCRAPE_TIMEOUT|{"stack":"Error: slow | very slow\\n    at worker","message":"slow | very slow"}',
      );

      expect(revived).toBeInstanceOf(ScrapeJobTimeoutError);
      expect(revived.code).toBe("SCRAPE_TIMEOUT");
      expect(revived.message).toBe("slow | very slow");
      expect(revived.stack).toBe("Error: slow | very slow\n    at worker");
    });
  });

  describe("a code with no class", () => {
    it("gives a plain error that keeps the code and the message", () => {
      const revived = deserializeTransportableError(
        wire("SCRAPE_FROM_ANOTHER_BUILD", {
          stack: "Error: Not known here\n    at worker",
          message: "Not known here",
          detail: { onlyTheOtherBuildReadsThis: true },
        }),
      );

      expect(revived).toBeInstanceOf(TransportableError);
      expect(revived.constructor).toBe(TransportableError);
      expect(revived.code).toBe("SCRAPE_FROM_ANOTHER_BUILD");
      expect(revived.message).toBe("Not known here");
      expect(revived.stack).toBe("Error: Not known here\n    at worker");
    });

    it("keeps a message that contains the separator", () => {
      const revived = deserializeTransportableError(
        wire("SCRAPE_FROM_ANOTHER_BUILD", { message: "a | b | c" }),
      );

      expect(revived.code).toBe("SCRAPE_FROM_ANOTHER_BUILD");
      expect(revived.message).toBe("a | b | c");
    });

    it("keeps the code and the message when serialized again", () => {
      const first = deserializeTransportableError(
        wire("SCRAPE_FROM_ANOTHER_BUILD", {
          stack: "Error: Not known here\n    at worker",
          message: "Not known here",
        }),
      );
      const second = deserializeTransportableError(
        serializeTransportableError(first),
      );

      expect(second.constructor).toBe(TransportableError);
      expect(second.code).toBe("SCRAPE_FROM_ANOTHER_BUILD");
      expect(second.message).toBe("Not known here");
      expect(second.stack).toBe("Error: Not known here\n    at worker");
    });

    it("treats a code that is listed without a class the same way", () => {
      const revived = deserializeTransportableError(
        wire("SAFE_MODE_BLOCKED", { message: "Blocked by Safe Mode" }),
      );

      expect(revived.constructor).toBe(TransportableError);
      expect(revived.code).toBe("SAFE_MODE_BLOCKED");
      expect(revived.message).toBe("Blocked by Safe Mode");
    });

    it("does not take an inherited object key for a class", () => {
      const revived = deserializeTransportableError(
        wire("constructor", { message: "Not a class" }),
      );

      expect(revived.constructor).toBe(TransportableError);
      expect(revived.code).toBe("constructor");
      expect(deserializeTransportableError("toString")).toBeNull();
    });
  });

  describe("a string that is not a serialized error", () => {
    it.each([
      ["a plain message", "Timed out"],
      ["a sentence", "Job raced out while waiting for it"],
      ["an empty string", ""],
      ["a separator with no JSON after it", "connection lost|retrying"],
      ["prose before a JSON object", 'request failed|{"message":"nope"}'],
      ["an empty code", '|{"message":"nope"}'],
      ["a payload with no message", 'SOME_CODE|{"detail":"nope"}'],
      ["a payload whose message is not a string", 'SOME_CODE|{"message":5}'],
      ["an array payload", 'SOME_CODE|["nope"]'],
      ["a string payload", 'SOME_CODE|"nope"'],
      ["a null payload", "SOME_CODE|null"],
      ["a truncated payload", 'SOME_CODE|{"message":"cut of'],
      ["a code with a class and no payload", "SCRAPE_TIMEOUT"],
      [
        "a code with a class and a payload that is not JSON",
        "UNKNOWN_ERROR|oops",
      ],
      [
        "a code with a class and a truncated payload",
        'SCRAPE_TIMEOUT|{"message":"cut of',
      ],
      ["a code with a class and a null payload", "SCRAPE_TIMEOUT|null"],
    ])("returns null for %s", (_name, data) => {
      expect(deserializeTransportableError(data)).toBeNull();
    });
  });
});

describe("serializeTransportableError", () => {
  it("writes the code, a separator, then the JSON of serialize()", () => {
    const original = new CrawlDenialError("denied");
    const serialized = serializeTransportableError(original);

    expect(serialized.startsWith("CRAWL_DENIAL|")).toBe(true);
    expect(JSON.parse(serialized.slice("CRAWL_DENIAL|".length))).toEqual({
      stack: original.stack,
      message: "denied",
      reason: "denied",
      robotsBlockedUrl: null,
    });
  });
});
