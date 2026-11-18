import { describe, expect, it } from "vitest";
import { coreParts } from "./core-parts";
import { createService } from "./service";

describe("coreParts", () => {
  it("gives the service every process role, and nothing else yet", () => {
    const built = createService({ modules: {} }, coreParts());

    expect(built.describe()).toEqual({
      extensions: ["core"],
      modules: [],
      hooks: {},
      roles: {
        api: "core",
        "cclog-worker": "core",
        "extract-worker": "core",
        harness: "core",
        "index-worker": "core",
        "nuq-fdb-worker": "core",
        "nuq-prefetch-worker": "core",
        "nuq-reconciler-worker": "core",
        "nuq-worker": "core",
        "queue-worker": "core",
        "zdr-worker": "core",
      },
    });
  });
});
