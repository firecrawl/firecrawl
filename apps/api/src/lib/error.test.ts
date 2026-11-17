import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  CrawlDenialError,
  isTransportableError,
  TransportableError,
} from "./error";

describe("isTransportableError", () => {
  it("holds for the base class and for every subclass", () => {
    expect(
      isTransportableError(new TransportableError("SCRAPE_TIMEOUT", "slow")),
    ).toBe(true);
    expect(isTransportableError(new CrawlDenialError("denied"))).toBe(true);
  });

  it("does not hold for anything else", () => {
    expect(isTransportableError(new Error("plain"))).toBe(false);
    expect(
      isTransportableError(
        Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
      ),
    ).toBe(false);
    expect(isTransportableError({ code: "SCRAPE_TIMEOUT" })).toBe(false);
    expect(isTransportableError("SCRAPE_TIMEOUT")).toBe(false);
    expect(isTransportableError(null)).toBe(false);
    expect(isTransportableError(undefined)).toBe(false);
  });

  it("does not hold for a branded value that is no error or cannot write itself", () => {
    const branded = {
      [Symbol.for("firecrawl.TransportableError")]: true,
      code: "SCRAPE_TIMEOUT",
    };

    expect(isTransportableError({ ...branded, serialize: () => ({}) })).toBe(
      false,
    );
    expect(
      isTransportableError(Object.assign(new Error("slow"), branded)),
    ).toBe(false);
    expect(
      isTransportableError(
        Object.assign(new Error("slow"), branded, { serialize: () => ({}) }),
      ),
    ).toBe(true);
  });

  it("leaves what an error shows of itself unchanged", () => {
    const error = new CrawlDenialError("denied");

    expect(Object.getOwnPropertySymbols(error)).toEqual([]);
    expect(Object.keys(error).sort()).toEqual([
      "code",
      "reason",
      "robotsBlockedUrl",
    ]);
  });

  // `instanceof` misses an error built from another copy of the base class,
  // which then crosses the job queue as UNKNOWN_ERROR without its code.
  it("is what the code asks, never instanceof TransportableError", () => {
    const src = path.resolve(__dirname, "..");
    const asking = readdirSync(src, { recursive: true, encoding: "utf8" })
      .filter(
        file =>
          file.endsWith(".ts") &&
          !file.endsWith(".test.ts") &&
          !file.split(path.sep).includes("__tests__"),
      )
      .filter(file =>
        readFileSync(path.join(src, file), "utf8").includes(
          "instanceof TransportableError",
        ),
      );

    expect(asking).toEqual([]);
  });
});
