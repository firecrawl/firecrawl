import { readFileSync } from "fs";
import { join } from "path";

// Regression test for zombie process accumulation under self-hosted Docker
// Compose: harness.js runs as PID 1 in the `api` container and spawns
// detached worker subprocesses (see src/harness.ts) that node never reaps
// on its own. `init: true` runs tini as PID 1 to reap them.
describe("docker-compose.yaml api service", () => {
  it("enables an init process to reap detached worker subprocesses", () => {
    const composePath = join(__dirname, "../../../../docker-compose.yaml");
    const compose = readFileSync(composePath, "utf8");

    const apiServiceMatch = compose.match(/\n {2}api:\n([\s\S]*?)(?=\n {2}\S)/);
    expect(apiServiceMatch).not.toBeNull();

    const apiServiceBlock = apiServiceMatch![1];
    expect(apiServiceBlock).toMatch(/^\s{4}init:\s*true\s*$/m);
  });
});
