import { Response } from "express";
import { z } from "zod";
import { generateText } from "ai";
import * as Sentry from "@sentry/node";
import { logger } from "../../lib/logger";
import { RequestWithAuth } from "./types";
import { supabase_service } from "../../services/supabase";
import { getModel } from "../../lib/generic-ai";

const askSchema = z.object({
  question: z.string().min(1).max(2000),
});

type ScheduleAskResponse =
  | { success: true; answer: string }
  | { success: false; error: string };

export async function scheduleAskController(
  req: RequestWithAuth<
    { scheduleId: string },
    ScheduleAskResponse,
    { question: string }
  >,
  res: Response<ScheduleAskResponse>,
) {
  try {
    const { question } = askSchema.parse(req.body);

    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(503).json({
        success: false,
        error:
          "AI Q&A is not configured on this server (missing ANTHROPIC_API_KEY)",
      });
    }

    const { data, error } = await supabase_service
      .from("schedules")
      .select("last_result")
      .eq("id", req.params.scheduleId)
      .eq("team_id", req.auth.team_id)
      .single();

    if (error || !data) {
      return res
        .status(404)
        .json({ success: false, error: "Schedule not found" });
    }

    if (!data.last_result) {
      return res.status(400).json({
        success: false,
        error:
          "No scrape result available yet — wait for the schedule to run at least once",
      });
    }

    const { text } = await generateText({
      model: getModel("claude-haiku-4-5", "anthropic"),
      messages: [
        {
          role: "system",
          content:
            "You are a helpful assistant. Answer questions concisely based on the following web page content.",
        },
        {
          role: "user",
          content: `${data.last_result}\n\n---\nQuestion: ${question}`,
        },
      ],
    });

    return res.json({ success: true, answer: text });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        success: false,
        error: error.issues.map((e: any) => e.message).join(", "),
      });
    }
    Sentry.captureException(error);
    logger.error("scheduleAskController error", { error });
    return res.status(500).json({ success: false, error: error.message });
  }
}
