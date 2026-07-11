import { execFileSync } from "child_process";

test("migration control-plane exports do not eagerly load foundationdb", () => {
  const script = `
    const Module = require("module");
    const originalLoad = Module._load;
    Module._load = function (id, ...args) {
      if (id === "foundationdb") throw new Error("eager native foundationdb import");
      return originalLoad.call(this, id, ...args);
    };
    require("./src/services/worker/nuq-fdb/index.ts");
    process.stdout.write("lazy-ok");
  `;
  const output = execFileSync(
    process.execPath,
    ["--require", "tsx/cjs", "-e", script],
    {
      cwd: process.cwd(),
      env: { ...process.env, FDB_CLUSTER_FILE: "", NUQ_BACKEND: "pg" },
      encoding: "utf8",
    },
  );
  expect(output).toBe("lazy-ok");
});
