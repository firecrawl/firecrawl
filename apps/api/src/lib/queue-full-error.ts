const QUEUE_FULL_ERROR_NAME = "QueueFullError";

export class QueueFullError extends Error {
  statusCode = 429;

  constructor(queueSize: number, queueLimit: number) {
    super(
      `Queue limit reached: your team has ${queueSize} jobs queued (limit: ${queueLimit}). Please wait for existing jobs to complete before adding more, or upgrade your plan for a higher limit. For more info, see https://docs.firecrawl.dev/rate-limits#concurrent-browser-limits`,
    );
    this.name = QUEUE_FULL_ERROR_NAME;
  }
}
