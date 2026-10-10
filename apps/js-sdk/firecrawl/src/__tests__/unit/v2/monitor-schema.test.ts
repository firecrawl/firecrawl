import { test } from "vitest";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { z } from "zod";
import { createMonitor, updateMonitor } from "../../../v2/methods/monitor";
import type { CreateMonitorRequest } from "../../../v2/types";
import { HttpClient } from "../../../v2/utils/httpClient";

for (const operation of ["create", "update"] as const) {
  for (const targetType of ["scrape", "crawl"] as const) {
    test(`${operation} monitor serializes ${targetType} target schemas without mutating input`, async () => {
      let captured: any;
      const server = createServer(async (req, res) => {
        let body = "";
        for await (const chunk of req) body += chunk;
        captured = JSON.parse(body);
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ success: true, data: { id: "mon_test" } }));
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      try {
        const address = server.address() as { port: number };
        const http = new HttpClient({ apiKey: "test", apiUrl: `http://127.0.0.1:${address.port}`, maxRetries: 1 });
        const schema = z.object({ title: z.string() });
        const formats = Object.freeze([
          Object.freeze({ type: "json" as const, schema }),
          Object.freeze({ type: "changeTracking" as const, schema }),
        ]);
        const options = Object.freeze({ formats, onlyMainContent: false });
        const target = Object.freeze({ type: targetType, ...(targetType === "scrape" ? { urls: ["https://example.com"] } : { url: "https://example.com" }), scrapeOptions: options });
        const search = { type: "search" as const, queries: ["news"], maxResults: 0 };
        const request = { name: "test", schedule: { text: "every day" }, targets: Object.freeze([target, search]) } as unknown as CreateMonitorRequest; // Public types are mutable; exercise frozen input at runtime.
        if (operation === "create") await createMonitor(http, request);
        else await updateMonitor(http, "mon_test", request);
        for (const format of captured.targets[0].scrapeOptions.formats) {
          assert.equal(format.schema.type, "object");
          assert.deepEqual(format.schema.properties.title, { type: "string" });
          assert.equal(format.schema._def, undefined);
        }
        assert.equal(captured.targets[0].scrapeOptions.onlyMainContent, false);
        assert.deepEqual(captured.targets[1], search);
        assert.equal(target.scrapeOptions.formats[0].schema, schema);
        assert.equal(target.scrapeOptions.formats[1].schema, schema);
      } finally {
        await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
      }
    });
  }
}

test("update without targets and plain JSON schemas remain intact", async () => {
  const bodies: any[] = [];
  const http: any = { patch: async (_path: string, body: any) => {
    bodies.push(JSON.parse(JSON.stringify(body)));
    return { status: 200, data: { success: true, data: { id: "mon_test" } } };
  } };
  await updateMonitor(http, "mon_test", { status: "paused" });
  const request: any = { targets: [{ type: "scrape", urls: ["https://example.com"], scrapeOptions: { formats: [{ type: "json", schema: { type: "string" } }] } }] };
  await updateMonitor(http, "mon_test", request);
  assert.deepEqual(bodies, [{ status: "paused" }, request]);
});
