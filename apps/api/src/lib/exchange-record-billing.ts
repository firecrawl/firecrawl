import { z } from "zod";
import { billTeam } from "../services/billing/credit_billing";
import { autumnService } from "../services/autumn/autumn.service";
import { reportExchangeBilling } from "./exchange";

const deliveredRecord = z.object({
  success: z.literal(true),
  accessEventId: z.string().uuid(),
  creditsCost: z.number().int().nonnegative().safe(),
});

export async function billExchangeRecord(
  body: unknown,
  context: {
    teamId: string;
    apiKeyId: number | null;
    maxCredits: number;
  },
): Promise<
  { success: true } | { success: false; status: number; error: string }
> {
  const parsed = deliveredRecord.safeParse(body);
  if (!parsed.success)
    return {
      success: false,
      status: 502,
      error: "Exchange returned an invalid billing receipt.",
    };
  const { accessEventId, creditsCost } = parsed.data;
  if (creditsCost > context.maxCredits) {
    await reportExchangeBilling({ accessEventId, status: "void" });
    return {
      success: false,
      status: 409,
      error: "The document price exceeds the accepted credit limit.",
    };
  }
  if (
    creditsCost === 0 ||
    context.teamId === "preview" ||
    context.teamId.startsWith("preview_")
  ) {
    await reportExchangeBilling({ accessEventId, status: "void" });
    return { success: true };
  }
  const balance = await autumnService.checkCredits({
    teamId: context.teamId,
    value: creditsCost,
    properties: { source: "exchange-record-fetch", apiKeyId: context.apiKeyId },
  });
  if (!balance?.allowed) {
    await reportExchangeBilling({ accessEventId, status: "void" });
    return {
      success: false,
      status: balance === null ? 503 : 402,
      error: "Unable to authorize credits for this document.",
    };
  }
  const billingReference = `exchange:${accessEventId}`;
  const result = await billTeam(
    context.teamId,
    creditsCost,
    context.apiKeyId,
    { endpoint: "scrape", chargeId: billingReference },
    undefined,
    { accessEventId, billingReference },
  );
  if (!result.success)
    return {
      success: false,
      status: 503,
      error:
        "Document billing is pending reconciliation. Please try again later.",
    };
  return { success: true };
}
