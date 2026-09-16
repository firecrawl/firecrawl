import { config } from "../config";
import { getBigtableTable } from "./bigtable-client";
import { saltedUuidV7RowKey } from "./bigtable-row-key";
import { setSpanAttributes, withSpan } from "./otel-tracer";
import type { ScrapeReplayContext } from "./scrape-interact/scrape-replay";

const QUALIFIER = "v";
const FAMILY = "s";
const STATE_RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_ERROR_LENGTH = 16_384;

export type ScrapeJobState = {
  status: "completed" | "failed";
  requestId: string;
  completedAtMs: number;
  creditsBilled: number;
  error?: string;
  replay?: ScrapeReplayContext;
  profile?: { name: string; saveChanges: boolean };
  origin?: string;
};

export type ExtractJobState = {
  status: "completed" | "failed";
  completedAtMs: number;
  creditsBilled: number;
  error?: string;
};

type StoredScrapeJobState = ScrapeJobState & { version: 1 };
type StoredExtractJobState = ExtractJobState & { version: 1 };

function parseState<T>(
  value: Buffer | string,
  validate: (row: Record<string, unknown>) => boolean,
  name: string,
): T {
  const parsed: unknown = JSON.parse(value.toString());
  if (!parsed || typeof parsed !== "object" || !validate(parsed as any)) {
    throw new Error(`Invalid Bigtable ${name} row`);
  }
  return parsed as T;
}

function isTerminalStatus(value: unknown): value is "completed" | "failed" {
  return value === "completed" || value === "failed";
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parseScrapeState(value: Buffer | string): ScrapeJobState {
  const row = parseState<StoredScrapeJobState>(
    value,
    candidate =>
      candidate.version === 1 &&
      isTerminalStatus(candidate.status) &&
      typeof candidate.requestId === "string" &&
      isFiniteNumber(candidate.completedAtMs) &&
      isFiniteNumber(candidate.creditsBilled) &&
      (candidate.error === undefined || typeof candidate.error === "string") &&
      (candidate.replay === undefined ||
        (typeof candidate.replay === "object" &&
          candidate.replay !== null &&
          typeof (candidate.replay as any).targetUrl === "string" &&
          isFiniteNumber((candidate.replay as any).waitForMs) &&
          Array.isArray((candidate.replay as any).actions))) &&
      (candidate.profile === undefined ||
        (typeof candidate.profile === "object" &&
          candidate.profile !== null &&
          typeof (candidate.profile as any).name === "string" &&
          typeof (candidate.profile as any).saveChanges === "boolean")) &&
      (candidate.origin === undefined || typeof candidate.origin === "string"),
    "scrape state",
  );
  const { version: _, ...state } = row;
  return state;
}

function parseExtractState(value: Buffer | string): ExtractJobState {
  const row = parseState<StoredExtractJobState>(
    value,
    candidate =>
      candidate.version === 1 &&
      isTerminalStatus(candidate.status) &&
      isFiniteNumber(candidate.completedAtMs) &&
      isFiniteNumber(candidate.creditsBilled) &&
      (candidate.error === undefined || typeof candidate.error === "string"),
    "extract state",
  );
  const { version: _, ...state } = row;
  return state;
}

async function writeState(params: {
  id: string;
  tableId: string | undefined;
  spanName: string;
  value: object;
}): Promise<boolean> {
  const tableId = params.tableId;
  if (!tableId) return false;

  return withSpan(params.spanName, async span => {
    setSpanAttributes(span, {
      "db.system": "bigtable",
      "bigtable.table": tableId,
      "bigtable.operation": "mutate",
    });
    const table = await getBigtableTable(tableId);
    await table.mutate([
      {
        key: saltedUuidV7RowKey(params.id),
        method: "insert",
        data: {
          [FAMILY]: {
            [QUALIFIER]: {
              value: Buffer.from(JSON.stringify(params.value)),
              timestamp: new Date(Date.now() + STATE_RETENTION_MS),
            },
          },
        },
      },
    ]);
    return true;
  });
}

async function readState<T>(params: {
  id: string;
  tableId: string | undefined;
  spanName: string;
  parse: (value: Buffer | string) => T;
}): Promise<T | null> {
  const tableId = params.tableId;
  if (!tableId) return null;

  return withSpan(params.spanName, async span => {
    setSpanAttributes(span, {
      "db.system": "bigtable",
      "bigtable.table": tableId,
      "bigtable.operation": "getRows",
    });
    const table = await getBigtableTable(tableId);
    const [rows] = await table.getRows({
      keys: [saltedUuidV7RowKey(params.id)],
      filter: [{ column: { name: QUALIFIER, cellLimit: 1 } }],
    });
    const cells = rows[0]?.data?.[FAMILY]?.[QUALIFIER];
    const cell = Array.isArray(cells) ? cells[0] : undefined;
    if (cell?.value == null) {
      setSpanAttributes(span, { "bigtable.read.outcome": "not_found" });
      return null;
    }
    setSpanAttributes(span, { "bigtable.read.outcome": "found" });
    return params.parse(cell.value);
  });
}

export function writeScrapeJobState(
  id: string,
  state: ScrapeJobState,
): Promise<boolean> {
  return writeState({
    id,
    tableId: config.BIGTABLE_SCRAPE_STATE_TABLE,
    spanName: "bigtable.scrape_state.write",
    value: {
      version: 1,
      ...state,
      ...(state.error ? { error: state.error.slice(0, MAX_ERROR_LENGTH) } : {}),
    },
  });
}

export function readScrapeJobState(id: string): Promise<ScrapeJobState | null> {
  return readState({
    id,
    tableId: config.BIGTABLE_SCRAPE_STATE_TABLE,
    spanName: "bigtable.scrape_state.read",
    parse: parseScrapeState,
  });
}

export function writeExtractJobState(
  id: string,
  state: ExtractJobState,
): Promise<boolean> {
  return writeState({
    id,
    tableId: config.BIGTABLE_EXTRACT_STATE_TABLE,
    spanName: "bigtable.extract_state.write",
    value: {
      version: 1,
      ...state,
      ...(state.error ? { error: state.error.slice(0, MAX_ERROR_LENGTH) } : {}),
    },
  });
}

export function readExtractJobState(
  id: string,
): Promise<ExtractJobState | null> {
  return readState({
    id,
    tableId: config.BIGTABLE_EXTRACT_STATE_TABLE,
    spanName: "bigtable.extract_state.read",
    parse: parseExtractState,
  });
}
