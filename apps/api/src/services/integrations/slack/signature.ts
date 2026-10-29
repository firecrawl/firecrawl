import crypto from "crypto";
import { config } from "../../../config";

const FIVE_MINUTES_SECONDS = 60 * 5;

// Verifies the X-Slack-Signature header per
// https://api.slack.com/authentication/verifying-requests-from-slack
// The rawBody MUST be the exact bytes Slack sent (captured before body parsing).
export function verifySlackSignature(params: {
  signature: string | undefined;
  timestamp: string | undefined;
  rawBody: string | Buffer;
  signingSecret?: string;
}): boolean {
  const signingSecret = params.signingSecret ?? config.SLACK_SIGNING_SECRET;
  if (!signingSecret) return false;
  if (!params.signature || !params.timestamp) return false;

  const timestampSeconds = Number(params.timestamp);
  if (!Number.isFinite(timestampSeconds)) return false;

  // Guard against replay attacks with stale timestamps.
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - timestampSeconds) > FIVE_MINUTES_SECONDS) {
    return false;
  }

  const body =
    typeof params.rawBody === "string"
      ? params.rawBody
      : params.rawBody.toString("utf8");
  const base = `v0:${params.timestamp}:${body}`;
  const expected =
    "v0=" +
    crypto.createHmac("sha256", signingSecret).update(base).digest("hex");

  const a = Buffer.from(expected);
  const b = Buffer.from(params.signature);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
