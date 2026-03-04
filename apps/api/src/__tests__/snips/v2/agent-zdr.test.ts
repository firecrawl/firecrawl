import { getJobFromGCS } from "../../../lib/gcs-jobs";
import { supabase_service } from "../../../services/supabase";
import { describeIf, TEST_PRODUCTION } from "../lib";
import { agent, agentStatusRaw, idmux, zdrcleaner } from "./lib";

describeIf(TEST_PRODUCTION)("Zero Data Retention Agent", () => {
  describe.each(["Team-scoped", "Request-scoped"] as const)("%s", scope => {
    it("cleans up agent outputs", async () => {
      const identity = await idmux({
        name: `zdr/${scope}/agent`,
        credits: 10000,
        flags: {
          allowZDR: true,
          ...(scope === "Team-scoped" ? { forceZDR: true } : {}),
        },
      });

      const response = await agent(
        {
          prompt: "Extract the main heading from the page.",
          urls: ["https://firecrawl.dev"],
          strictConstrainToURLs: true,
          zeroDataRetention: scope === "Request-scoped" ? true : undefined,
          model: "spark-1-mini",
        },
        identity,
      );

      expect(response.status).toBe("completed");

      const { data: requests, error: requestError } = await supabase_service
        .from("requests")
        .select("*")
        .eq("id", response.id)
        .limit(1);

      expect(requestError).toBeFalsy();
      expect(requests).toHaveLength(1);

      const requestRecord = (requests ?? [])[0] as any;
      expect(requestRecord.dr_clean_by).not.toBeNull();
      expect(requestRecord.target_hint).toBe(
        "<redacted due to zero data retention>",
      );

      const { data: agents, error: agentError } = await supabase_service
        .from("agents")
        .select("*")
        .eq("id", response.id)
        .limit(1);

      expect(agentError).toBeFalsy();
      expect(agents).toHaveLength(1);

      const agentRecord = (agents ?? [])[0] as any;
      const options = agentRecord?.options ?? {};
      expect(options.zeroDataRetention).toBe(true);
      expect(options.prompt).toBeUndefined();
      expect(options.urls).toBeUndefined();
      expect(options.schema).toBeUndefined();
      expect(options.webhook).toBeUndefined();

      const gcsJob = await getJobFromGCS(response.id);
      expect(gcsJob).not.toBeNull();

      await zdrcleaner(identity.teamId!);

      const cleanedJob = await getJobFromGCS(response.id);
      expect(cleanedJob).toBeNull();

      if (scope === "Request-scoped") {
        const status = await agentStatusRaw(response.id, identity);
        expect(status.statusCode).toBe(404);
      }
    }, 600000);
  });
});
