import { judgeChange } from "./judgeChange";
import { logger as winstonLogger } from "../../lib/logger";

const HAS_GEMINI = !!process.env.GOOGLE_GENERATIVE_AI_API_KEY;
const describeIfGemini = HAS_GEMINI ? describe : describe.skip;
const TEST_TIMEOUT = 30000;
const buildLogger = () => winstonLogger.child({ test: "judgeChange" });

describe("judgeChange — input validation (no LLM call)", () => {
  it("returns low-confidence meaningful when no diff payload is provided", async () => {
    const result = await judgeChange({
      logger: buildLogger(),
      goal: "anything",
    });
    expect(result.meaningful).toBe(true);
    expect(result.confidence).toBe("low");
    expect(result.meaningfulChanges).toEqual([]);
  });
});

describeIfGemini("judgeChange — live Gemini", () => {
  it(
    "classifies whitespace-only field change as noise",
    async () => {
      const result = await judgeChange({
        logger: buildLogger(),
        goal: "Track the page heading verbatim",
        jsonDiff: {
          headline: {
            previous: "Power AI agents with clean web data",
            current: "Power AI agents with  clean web data",
          },
        },
      });
      expect(result.meaningful).toBe(false);
    },
    TEST_TIMEOUT,
  );

  it(
    "named-field rule: sub-1% price change is meaningful when goal names 'price'",
    async () => {
      const result = await judgeChange({
        logger: buildLogger(),
        goal: "Track the Pro tier price. Tell me about ANY price change.",
        jsonDiff: {
          pro_price: { previous: "$19.00", current: "$19.01" },
        },
      });
      expect(result.meaningful).toBe(true);
    },
    TEST_TIMEOUT,
  );

  it(
    "named-field rule does NOT apply to unmentioned fields",
    async () => {
      const result = await judgeChange({
        logger: buildLogger(),
        goal: "Track the Pro tier price.",
        jsonDiff: {
          view_count: { previous: "12402", current: "12418" },
        },
      });
      expect(result.meaningful).toBe(false);
    },
    TEST_TIMEOUT,
  );

  it(
    "markdown: new list item matching the goal is meaningful",
    async () => {
      const result = await judgeChange({
        logger: buildLogger(),
        goal: "tell me when a new MacBook is announced",
        markdownDiff: {
          diffText:
            "@@ -1,4 +1,5 @@\n # MacBook lineup\n+- MacBook Air M4 — NEW\n - MacBook Air M2\n - MacBook Pro M3\n \n-Updated 2026-05-19T18:42:00Z\n+Updated 2026-05-19T18:43:01Z",
        },
      });
      expect(result.meaningful).toBe(true);
      expect(result.reason.toLowerCase()).toMatch(/macbook|m4|new/);
    },
    TEST_TIMEOUT,
  );
});
