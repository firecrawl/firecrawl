import { config } from "../config";
import { alexandriaFeedbackNextStep } from "./alexandria-feedback-hint";
import { alexandriaFeedbackSchema } from "../controllers/v2/feedback/alexandria-schema";

const original = config.FEEDBACK_REFUND_ENABLED;
beforeEach(() => {
  config.FEEDBACK_REFUND_ENABLED = true;
});
afterAll(() => {
  config.FEEDBACK_REFUND_ENABLED = original;
});

it("points an MCP client at firecrawl_feedback with the arguments it takes", () => {
  expect(alexandriaFeedbackNextStep("mcp-claude-code@3.40.0")).toEqual({
    instruction:
      "Next: once you have used this result, rate it with firecrawl_feedback if that tool is available. Eligible feedback can refund 1 credit.",
    tool: "firecrawl_feedback",
    arguments: {
      endpoint: "alexandria",
      rating: "<good|partial|bad>",
      requestedWebsite: {
        url: "<website the data is about>",
        requestedFunctionality: "<what you needed from it>",
      },
      objective: "<the underlying goal>",
      rationale: "<what was right, wrong or missing>",
    },
  });
});

it.each([
  ["cli.codex", undefined],
  ["api", "cli"],
  ["api", " CLI "],
])("gives the CLI its own command (origin %s)", (origin, integration) => {
  expect(alexandriaFeedbackNextStep(origin, integration)).toEqual({
    instruction:
      "Next: once you have used this result, run this command to rate it. Eligible feedback can refund 1 credit.",
    command:
      'firecrawl alexandria feedback --rating "<good|partial|bad>" --url "<website the data is about>" --requested-functionality "<what you needed from it>" --objective "<the underlying goal>" --rationale "<what was right, wrong or missing>"',
  });
});

it("reads the origin without regard to case or padding", () => {
  expect(alexandriaFeedbackNextStep(" MCP-Cursor@3.40.0 ")).toMatchObject({
    tool: "firecrawl_feedback",
  });
});

it("gives any other caller the HTTP request, with the tokens it rates", () => {
  const step = alexandriaFeedbackNextStep("api", null);
  expect(step).toMatchObject({
    instruction:
      "Next: once you have used this result, POST /v2/feedback to rate it. Eligible feedback can refund 1 credit.",
    request: "POST /v2/feedback",
    body: { tokens: ["<feedbackToken of each result you rate>"] },
  });
});

it("names only fields the feedback endpoint accepts", () => {
  const step = alexandriaFeedbackNextStep("api") as {
    body: Record<string, unknown>;
  };
  expect(
    alexandriaFeedbackSchema.safeParse({
      ...step.body,
      rating: "good",
      requestedWebsite: {
        url: "https://example.com",
        requestedFunctionality: "stock price",
      },
    }).success,
  ).toBe(true);
});

it("does not promise a refund when refunds are off", () => {
  config.FEEDBACK_REFUND_ENABLED = false;
  expect(alexandriaFeedbackNextStep("mcp-cursor").instruction).toBe(
    "Next: once you have used this result, rate it with firecrawl_feedback if that tool is available.",
  );
});

it("stays short", () => {
  for (const origin of ["mcp-cursor", "cli", "api"])
    expect(
      JSON.stringify(alexandriaFeedbackNextStep(origin)).length,
    ).toBeLessThan(500);
});
