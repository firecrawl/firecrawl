export class ScrapeProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScrapeProfileError";
  }
}

const fallbackMessage =
  "The saved profile could not be used. Re-save the profile and try again.";

// Missing errorData keeps the previous engine-failure path.
export function scrapeProfileErrorFromFireEngine(
  body: unknown,
): ScrapeProfileError | null {
  const data = (body as { errorData?: { code?: unknown; message?: unknown } })
    ?.errorData;
  if (data?.code !== "PROFILE_FAILED") return null;
  return new ScrapeProfileError(
    typeof data.message === "string" && data.message !== ""
      ? data.message
      : fallbackMessage,
  );
}
