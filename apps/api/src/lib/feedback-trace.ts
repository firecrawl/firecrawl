import type { Request } from "express";
import { externalRequestId } from "./external-request-id";
import {
  LINEAGE_ID_PATTERN,
  LINEAGE_ID_SECRET_PATTERN,
  OBJECTIVE_MAX_LENGTH,
  SECRET_PATTERN,
  SESSION_SOURCES,
  THREAD_SOURCES,
  redactText,
} from "./mcp-lineage";

const EXTERNAL_REQUEST_ID_MAX_LENGTH = 128;
const LINEAGE_HEADER_MAX_BYTES = 4096;
// Node decodes base64 leniently and skips anything outside the alphabet.
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+={0,2}$/;

export type FeedbackTrace = {
  external_request_id: string | null;
  session_id: string | null;
  session_source: (typeof SESSION_SOURCES)[number] | null;
  thread_id: string | null;
  thread_source: (typeof THREAD_SOURCES)[number] | null;
  objective: string | null;
};

type TraceRequest = Pick<Request, "headers"> & {
  auth?: { hostedMcp?: boolean };
};

function mcpLineage(req: TraceRequest): Record<string, unknown> {
  if (req.auth?.hostedMcp !== true) return {};

  const raw = req.headers["x-firecrawl-mcp-lineage"];
  if (typeof raw !== "string") return {};
  if (Buffer.byteLength(raw) > LINEAGE_HEADER_MAX_BYTES) return {};
  if (!BASE64URL_PATTERN.test(raw)) return {};

  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    return parsed !== null && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function lineagePair<T extends string>(
  lineage: Record<string, unknown>,
  kind: "session" | "thread",
  sources: readonly T[],
): { id: string | null; source: T | null } {
  const id = lineage[`${kind}_id`];
  const source = lineage[`${kind}_source`];
  if (
    typeof id !== "string" ||
    !LINEAGE_ID_PATTERN.test(id) ||
    SECRET_PATTERN.test(id) ||
    LINEAGE_ID_SECRET_PATTERN.test(id) ||
    !sources.includes(source as T)
  ) {
    return { id: null, source: null };
  }
  return { id, source: source as T };
}

/**
 * The session and conversation ids of a hosted MCP call, when it sent usable
 * ones. No conversation is named when its id is the session's own.
 */
export function lineageIds(req: TraceRequest): {
  sessionId?: string;
  threadId?: string;
} {
  const lineage = mcpLineage(req);
  const sessionId = lineagePair(lineage, "session", SESSION_SOURCES).id;
  const thread = lineagePair(lineage, "thread", THREAD_SOURCES);
  // A thread id borrowed from the session is not a conversation of its own.
  const threadId =
    thread.source === "session" || thread.id === sessionId ? null : thread.id;
  return {
    ...(sessionId ? { sessionId } : {}),
    ...(threadId ? { threadId } : {}),
  };
}

/**
 * The ids that tie a feedback row to the request and conversation it came
 * from. The lineage header is read for hosted MCP calls only. Anything
 * unusable becomes null: feedback never fails over telemetry.
 */
export function feedbackTrace(req: TraceRequest): FeedbackTrace {
  const requestId = externalRequestId(req);
  const lineage = mcpLineage(req);
  const session = lineagePair(lineage, "session", SESSION_SOURCES);
  const thread = lineagePair(lineage, "thread", THREAD_SOURCES);

  return {
    external_request_id:
      requestId !== null && requestId.length <= EXTERNAL_REQUEST_ID_MAX_LENGTH
        ? requestId
        : null,
    session_id: session.id,
    session_source: session.source,
    thread_id: thread.id,
    thread_source: thread.source,
    objective:
      typeof lineage.objective === "string"
        ? redactText(lineage.objective, OBJECTIVE_MAX_LENGTH)
        : null,
  };
}
