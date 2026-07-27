import type { ScrapeJobSingleUrls } from "../../types";
import { getACUCTeam } from "../../controllers/auth";
import { logger as _logger } from "../logger";
import {
  buildRejectedScrapeActivityEvent,
  buildScrapeActivityEvent,
  type RejectedScrapeActivity,
  type ScrapeActivityOutcome,
} from "./event";
import { enqueueSiemLoggingEvent, enqueueSiemLoggingEvents } from "./transport";
import { getApiKeyName, isOrgSiemLoggingEnabled } from "./store";

const logger = _logger.child({ module: "siem-logging" });

export function emitScrapeActivityEvent(
  jobId: string,
  job: ScrapeJobSingleUrls,
  outcome: ScrapeActivityOutcome,
): void {
  void emitScrapeActivityEventAsync(jobId, job, outcome);
}

async function emitScrapeActivityEventAsync(
  jobId: string,
  job: ScrapeJobSingleUrls,
  outcome: ScrapeActivityOutcome,
): Promise<void> {
  try {
    const team = await getACUCTeam(job.team_id);
    if (team?.flags?.siemLogging !== true) return;
    const orgId = job.internalOptions?.orgId ?? team.org_id;
    if (!orgId) return;

    if (!(await isOrgSiemLoggingEnabled(orgId))) return;

    const apiKeyName = await getApiKeyName(job.team_id, job.apiKeyId);
    const event = buildScrapeActivityEvent(
      jobId,
      job,
      orgId,
      apiKeyName,
      outcome,
    );
    await enqueueSiemLoggingEvent(orgId, event);
  } catch (error) {
    logger.error("Failed to enqueue scrape activity event", {
      error,
      jobId,
      teamId: job.team_id,
    });
  }
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
  void emitRejectedScrapeActivityEventsAsync(inputs);
}

async function emitRejectedScrapeActivityEventsAsync(
  inputs: RejectedScrapeActivity[],
): Promise<void> {
  try {
    const byTeam = new Map<string, RejectedScrapeActivity[]>();
    for (const input of inputs) {
      const teamInputs = byTeam.get(input.teamId) ?? [];
      teamInputs.push(input);
      byTeam.set(input.teamId, teamInputs);
    }

    for (const [teamId, teamInputs] of byTeam) {
      const team = await getACUCTeam(teamId);
      if (team?.flags?.siemLogging !== true) continue;
      const orgId = team.org_id;
      if (!orgId) continue;

      if (!(await isOrgSiemLoggingEnabled(orgId))) continue;

      const apiKeyNames = new Map<string | null, string | null>();
      const apiKeyIds = teamInputs.map(input =>
        input.apiKeyId == null ? null : String(input.apiKeyId),
      );
      await Promise.all(
        [...new Set(apiKeyIds)].map(async apiKeyId => {
          apiKeyNames.set(apiKeyId, await getApiKeyName(teamId, apiKeyId));
        }),
      );
      const events = teamInputs.map(input => {
        const apiKeyId = input.apiKeyId == null ? null : String(input.apiKeyId);
        return buildRejectedScrapeActivityEvent(
          input,
          orgId,
          apiKeyNames.get(apiKeyId) ?? null,
        );
      });
      await enqueueSiemLoggingEvents(orgId, events);
    }
  } catch (error) {
    logger.error("Failed to enqueue rejected scrape activity events", {
      error,
      eventCount: inputs.length,
      teamIds: [...new Set(inputs.map(input => input.teamId))],
    });
  }
}
