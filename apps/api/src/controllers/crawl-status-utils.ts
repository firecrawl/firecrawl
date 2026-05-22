import type { StoredCrawl } from "../lib/crawl-redis";
import { normalizeOwnerId } from "../services/worker/nuq";
import type { NuQJobGroupInstance } from "../services/worker/nuq";

export function isCrawlStatusVisibleToTeam(input: {
  group: NuQJobGroupInstance | null;
  groupAnyJob: unknown | null;
  storedCrawl: Pick<StoredCrawl, "team_id"> | null;
  teamId: string;
}) {
  if (input.storedCrawl?.team_id === input.teamId) {
    return true;
  }

  if (!input.group) {
    return false;
  }

  const normalizedTeamId = normalizeOwnerId(input.teamId);
  if (normalizedTeamId && input.group.ownerId === normalizedTeamId) {
    return true;
  }

  return Boolean(input.groupAnyJob);
}

export function getCrawlStatusExpiresAt(input: {
  group: Pick<NuQJobGroupInstance, "createdAt" | "expiresAt" | "ttl"> | null;
  redisExpiry: Date | null;
}) {
  if (input.redisExpiry && input.redisExpiry.getTime() > Date.now()) {
    return input.redisExpiry;
  }

  if (!input.group) {
    return new Date(Date.now() + 24 * 60 * 60 * 1000);
  }

  return (
    input.group.expiresAt ??
    new Date(input.group.createdAt.valueOf() + input.group.ttl)
  );
}
