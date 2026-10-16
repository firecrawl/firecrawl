import { apiKeyToFcApiKey, parseApi } from "./parseApi";

describe("parseApi", () => {
  it.each([
    [
      "fc-3D478A296E59403E85C794ABA81FFD2A",
      "3d478a29-6e59-403e-85c7-94aba81ffd2a",
    ],
    [
      "3D478A29-6E59-403E-85C7-94ABA81FFD2A",
      "3d478a29-6e59-403e-85c7-94aba81ffd2a",
    ],
  ])("lowercases %s to the canonical uuid", (key, uuid) => {
    expect(parseApi(key)).toBe(uuid);
  });

  it("round-trips a canonical uuid back to the fc- form", () => {
    expect(apiKeyToFcApiKey("3d478a29-6e59-403e-85c7-94aba81ffd2a")).toBe(
      "fc-3d478a296e59403e85c794aba81ffd2a",
    );
    expect(apiKeyToFcApiKey(null)).toBeNull();
  });
});
