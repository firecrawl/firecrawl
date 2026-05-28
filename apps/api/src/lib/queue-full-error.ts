const QUEUE_FULL_ERROR_NAME = "QueueFullError";
const QUEUE_FULL_ERROR_MESSAGE_PREFIX = "Queue limit reached:";

export class QueueFullError extends Error {
  statusCode = 429;

  constructor(queueSize: number, queueLimit: number) {
    super(
      `Queue limit reached: your team has ${queueSize} jobs queued (limit: ${queueLimit}). Please wait for existing jobs to complete before adding more, or upgrade your plan for a higher limit. For more info, see https://docs.firecrawl.dev/rate-limits#concurrent-browser-limits`,
    );
    this.name = QUEUE_FULL_ERROR_NAME;
  }
}

function getStringField(
  error: Record<string, unknown>,
  fields: string[],
): string {
  for (const field of fields) {
    if (field in error && error[field] !== undefined && error[field] !== null) {
      return String(error[field]);
    }
  }

  return "";
}

export function isQueueFullError(error: unknown): boolean {
  const objectError =
    error && typeof error === "object"
      ? (error as Record<string, unknown>)
      : null;

  const errorName = objectError
    ? getStringField(objectError, ["name", "type"])
    : "";
  if (errorName === QUEUE_FULL_ERROR_NAME) {
    return true;
  }

  const errorMessage =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : objectError
          ? getStringField(objectError, ["message", "value"])
          : "";

  return errorMessage.startsWith(QUEUE_FULL_ERROR_MESSAGE_PREFIX);
}
