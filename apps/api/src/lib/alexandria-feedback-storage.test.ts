import { config } from "../config";
import { alexandriaFeedbackStorage } from "./alexandria-feedback-storage";

const original = config.USE_DB_AUTHENTICATION;
beforeEach(() => {
  config.USE_DB_AUTHENTICATION = true;
});
afterAll(() => {
  config.USE_DB_AUTHENTICATION = original;
});

it.each([{}, null, undefined, { searchZDR: "allowed" }, { allowZDR: true }])(
  "allows storage for an ordinary team (flags %j)",
  flags => {
    expect(alexandriaFeedbackStorage("team", flags as any)).toBe("allowed");
  },
);

it("is unavailable without database authentication, whatever the team", () => {
  config.USE_DB_AUTHENTICATION = false;
  expect(alexandriaFeedbackStorage("team", {})).toBe("unavailable");
  expect(
    alexandriaFeedbackStorage("preview", { searchFeedbackOptOut: true }),
  ).toBe("unavailable");
});

it.each(["preview", "preview_example", "preview_keyless_example"])(
  "names preview team %s before its flags",
  teamId => {
    expect(
      alexandriaFeedbackStorage(teamId, {
        searchFeedbackOptOut: true,
        forceZDR: true,
      }),
    ).toBe("preview_team");
  },
);

it("does not mistake a team whose id only starts with the word for a preview team", () => {
  expect(alexandriaFeedbackStorage("previewer", {})).toBe("allowed");
});

it("names the opt-out before zero data retention", () => {
  expect(
    alexandriaFeedbackStorage("team", { searchFeedbackOptOut: true }),
  ).toBe("opted_out");
  expect(
    alexandriaFeedbackStorage("team", {
      searchFeedbackOptOut: true,
      forceZDR: true,
    }),
  ).toBe("opted_out");
});

it.each([
  { forceZDR: true },
  { scrapeZDR: "forced" },
  { alexandriaZDR: "forced" },
  { searchZDR: "forced" },
  { searchZDR: "forced-zdr" },
  { searchZDR: "forced-anon" },
])("names zero data retention for a forced policy (flags %j)", flags => {
  expect(alexandriaFeedbackStorage("team", flags as any)).toBe(
    "zero_data_retention",
  );
});
