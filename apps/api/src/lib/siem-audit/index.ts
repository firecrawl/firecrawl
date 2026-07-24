import type { ScrapeJobSingleUrls } from "../../types";
import { getACUCTeam } from "../../controllers/auth";
import { logger as _logger } from "../logger";
import { enqueueForSiemDelivery } from "./buffer";
import {
  buildRejectedScrapeActivityEvent,
  buildScrapeActivityEvent,
  type RejectedScrapeActivity,
  type ScrapeActivityOutcome,
} from "./event";
import { getApiKeyName, getOrgSiemAuditConfig } from "./store";

export { withoutAuditMetadata } from "./redaction";

const logger = _logger.child({ module: "siem-audit" });

export function emitScrapeActivityEvent(
  jobId: string,
  job: ScrapeJobSingleUrls,
  outcome: ScrapeActivityOutcome,
): void {
  void (async () => {
    const team = await getACUCTeam(job.team_id);
    if (team?.flags?.siemAudit !== true) return;
    const orgId = job.internalOptions?.orgId ?? team.org_id;
    if (!orgId) return;

    const siemConfig = await getOrgSiemAuditConfig(orgId);
    if (!siemConfig?.enabled) return;

    const apiKeyName = await getApiKeyName(
      job.team_id,
      job.apiKeyIdText ?? job.apiKeyId,
    );
    const event = buildScrapeActivityEvent(
      jobId,
      job,
      orgId,
      apiKeyName,
      outcome,
    );
    enqueueForSiemDelivery(orgId, siemConfig.destination, event);
  })().catch(error => {
    logger.error("Failed to enqueue scrape activity event", {
      error,
      jobId,
      teamId: job.team_id,
    });
  });
}

export function emitRejectedScrapeActivityEvent(
  input: RejectedScrapeActivity,
): void {
  emitRejectedScrapeActivityEvents([input]);
}

export function emitRejectedScrapeActivityEvents(
  inputs: RejectedScrapeActivity[],
): void {
  if (inputs.length === 0) return;
  void (async () => {
    const byTeam = new Map<string, RejectedScrapeActivity[]>();
    for (const input of inputs) {
      const teamInputs = byTeam.get(input.teamId) ?? [];
      teamInputs.push(input);
      byTeam.set(input.teamId, teamInputs);
    }

    for (const [teamId, teamInputs] of byTeam) {
      const team = await getACUCTeam(teamId);
      if (team?.flags?.siemAudit !== true) continue;
      const orgId = team.org_id;
      if (!orgId) continue;

      const siemConfig = await getOrgSiemAuditConfig(orgId);
      if (!siemConfig?.enabled) continue;

      const apiKeyNames = new Map<string | null, string | null>();
      const apiKeyIds = teamInputs.map(input =>
        input.apiKeyId == null ? null : String(input.apiKeyId),
      );
      await Promise.all(
        [...new Set(apiKeyIds)].map(async apiKeyId => {
          apiKeyNames.set(apiKeyId, await getApiKeyName(teamId, apiKeyId));
        }),
      );
      for (const input of teamInputs) {
        const apiKeyId = input.apiKeyId == null ? null : String(input.apiKeyId);
        const event = buildRejectedScrapeActivityEvent(
          input,
          orgId,
          apiKeyNames.get(apiKeyId) ?? null,
        );
        enqueueForSiemDelivery(orgId, siemConfig.destination, event);
      }
    }
  })().catch(error => {
    logger.error("Failed to enqueue rejected scrape activity events", {
      error,
      eventCount: inputs.length,
      teamIds: [...new Set(inputs.map(input => input.teamId))],
    });
  });
}
