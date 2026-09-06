import { readFileSync } from "fs";
import { join } from "path";
import { parse } from "yaml";

// Regression test for zombie process accumulation under self-hosted Docker
// Compose: harness.js runs as PID 1 in the `api` container and spawns
// detached worker subprocesses (see src/harness.ts) that node never reaps
// on its own. `init: true` runs tini as PID 1 to reap them.
describe("docker-compose.yaml api service", () => {
  it("enables an init process to reap detached worker subprocesses", () => {
    const composePath = join(__dirname, "../../../../docker-compose.yaml");
    const compose = readFileSync(composePath, "utf8");
    const composeConfig = parse(compose);

    expect(composeConfig.services?.api).toBeDefined();
    expect(composeConfig.services.api.init).toBe(true);
  });
});
