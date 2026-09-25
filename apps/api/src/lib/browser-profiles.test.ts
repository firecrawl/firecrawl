import { browserProfileDeletedKey } from "./browser-profiles";
const TEAM = "00000000-0000-4000-8000-000000000001";
const OTHER_TEAM = "00000000-0000-4000-8000-000000000002";
describe("browserProfileDeletedKey", () => {
  it("isolates teams and preserves names containing separators", () => {
    expect(browserProfileDeletedKey(TEAM, "login")).not.toBe(
      browserProfileDeletedKey(OTHER_TEAM, "login"),
    );
    expect(browserProfileDeletedKey("a_b", "c")).not.toBe(
      browserProfileDeletedKey("a", "b_c"),
    );
    expect(browserProfileDeletedKey(TEAM, "a/b c")).not.toBe(
      browserProfileDeletedKey(TEAM, "a/b"),
    );
  });
});

it("keeps the serialized identity stable, including JSON escaping", () => {
  expect(browserProfileDeletedKey("team", "login")).toBe(
    'browser-profile-deleted:["team","login"]',
  );
  expect(browserProfileDeletedKey("team", 'a/b \"\\\n')).toBe(
    'browser-profile-deleted:["team","a/b \\"\\\\\\n"]',
  );
});
