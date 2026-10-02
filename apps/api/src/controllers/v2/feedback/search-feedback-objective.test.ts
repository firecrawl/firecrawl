import { searchFeedbackSchema } from "../types";
import { toSearchFeedbackInput } from "./request-input";

const base = {
  rating: "bad" as const,
  missingContent: [{ topic: "Contract attachments" }],
};

describe("search feedback objective", () => {
  it("records the trimmed objective behind the search", () => {
    const body = searchFeedbackSchema.parse({
      ...base,
      objective: "  Shortlist federal IT contracts to bid on this quarter  ",
    });

    expect(toSearchFeedbackInput(body).objective).toBe(
      "Shortlist federal IT contracts to bid on this quarter",
    );
  });

  it("keeps feedback without an objective unchanged", () => {
    const body = searchFeedbackSchema.parse(base);

    expect(body).not.toHaveProperty("objective");
    expect(toSearchFeedbackInput(body).objective).toBeUndefined();
  });

  it.each([{ objective: " " }, { objective: "x".repeat(2001) }, { objective: 42 }])(
    "drops an invalid objective without rejecting the feedback %j",
    context => {
      const result = searchFeedbackSchema.safeParse({ ...base, ...context });

      expect(result.success).toBe(true);
      expect(result.data?.objective).toBeUndefined();
    },
  );

  it("does not let an objective satisfy the substantive-feedback rule", () => {
    expect(
      searchFeedbackSchema.safeParse({
        rating: "bad",
        objective: "Shortlist federal IT contracts to bid on this quarter",
      }).success,
    ).toBe(false);
  });
});
