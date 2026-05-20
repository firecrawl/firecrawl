import { describe, test, expect } from "@jest/globals";
import type { SearchRequest } from "../../../v2/types";

describe("v2 types: SearchRequest", () => {
  test("accepts country field", () => {
    const req: SearchRequest = {
      query: "restaurants",
      country: "DE",
    };
    expect(req.country).toBe("DE");
  });

  test("country is optional", () => {
    const req: SearchRequest = { query: "test" };
    expect(req.country).toBeUndefined();
  });

  test("accepts enterprise field with valid values", () => {
    const req: SearchRequest = {
      query: "sensitive topic",
      enterprise: ["zdr"],
    };
    expect(req.enterprise).toEqual(["zdr"]);
  });

  test("enterprise accepts all documented values", () => {
    const req: SearchRequest = {
      query: "test",
      enterprise: ["default", "anon", "zdr"],
    };
    expect(req.enterprise).toHaveLength(3);
  });

  test("enterprise is optional", () => {
    const req: SearchRequest = { query: "test" };
    expect(req.enterprise).toBeUndefined();
  });

  test("accepts both country and enterprise together", () => {
    const req: SearchRequest = {
      query: "test",
      country: "US",
      enterprise: ["default"],
    };
    expect(req.country).toBe("US");
    expect(req.enterprise).toEqual(["default"]);
  });
});
