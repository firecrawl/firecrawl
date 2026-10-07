import {
  evaluateAgentHintRules,
  parseAgentHintRules,
  type AgentHintRule,
} from "./agent-hint-rules";
import type { AgentHintSignalValue } from "./agent-hint-signals";

const signals = (values: Record<string, AgentHintSignalValue>) =>
  new Map(Object.entries(values));

const rule = (
  id: string,
  when: AgentHintRule["when"],
  text: string,
  group?: string,
): AgentHintRule => (group ? { id, group, when, text } : { id, when, text });

describe("agent hint rule matcher", () => {
  it.each([
    ["eq", 404, 404, true],
    ["eq", 404, "404", false],
    ["ne", 404, 410, true],
    ["ne", 404, 404, false],
    ["lt", 99, 100, true],
    ["lt", 100, 100, false],
    ["lte", 100, 100, true],
    ["gt", 4, 3, true],
    ["gt", 3, 3, false],
    ["gte", 0.75, 0.75, true],
    ["gte", 0.74, 0.75, false],
    ["lt", "1", 100, false],
  ] as const)("%s: %p against %p holds = %p", (op, actual, value, expected) => {
    const result = evaluateAgentHintRules(
      [rule("r", [{ signal: "s", op, value } as any], "fired")],
      signals({ s: actual }),
    );
    expect(result).toEqual(expected ? ["fired"] : []);
  });

  it("matches in against a list of scalars", () => {
    const rules = [
      rule("r", [{ signal: "s", op: "in", value: [404, 410] }], "fired"),
    ];
    expect(evaluateAgentHintRules(rules, signals({ s: 410 }))).toEqual([
      "fired",
    ]);
    expect(evaluateAgentHintRules(rules, signals({ s: 401 }))).toEqual([]);
  });

  it("only lets exists hold for absent signals", () => {
    for (const op of ["eq", "ne", "lt", "in"] as const) {
      const value = op === "in" ? [1] : 1;
      expect(
        evaluateAgentHintRules(
          [rule("r", [{ signal: "missing", op, value } as any], "fired")],
          signals({}),
        ),
      ).toEqual([]);
    }
    const exists = (value: boolean) =>
      rule("r", [{ signal: "s", op: "exists", value }], "fired");
    expect(evaluateAgentHintRules([exists(false)], signals({}))).toEqual([
      "fired",
    ]);
    expect(evaluateAgentHintRules([exists(true)], signals({}))).toEqual([]);
    expect(evaluateAgentHintRules([exists(true)], signals({ s: 0 }))).toEqual([
      "fired",
    ]);
  });

  it("never matches list signals with comparison operators", () => {
    expect(
      evaluateAgentHintRules(
        [rule("r", [{ signal: "s", op: "eq", value: "a" }], "fired")],
        signals({ s: ["a"] }),
      ),
    ).toEqual([]);
  });

  it("requires every condition and treats an empty condition list as always", () => {
    const rules = [
      rule(
        "both",
        [
          { signal: "a", op: "eq", value: true },
          { signal: "b", op: "gt", value: 1 },
        ],
        "both",
      ),
      rule("always", [], "always"),
    ];
    expect(evaluateAgentHintRules(rules, signals({ a: true, b: 2 }))).toEqual([
      "both",
      "always",
    ]);
    expect(evaluateAgentHintRules(rules, signals({ a: true, b: 1 }))).toEqual([
      "always",
    ]);
  });

  it("fires only the first matching rule of a group, in rule order", () => {
    const rules = [
      rule("independent", [], "independent"),
      rule("first", [{ signal: "n", op: "gt", value: 5 }], "first", "g"),
      rule("second", [{ signal: "n", op: "gt", value: 1 }], "second", "g"),
      rule("third", [], "third", "g"),
    ];
    expect(evaluateAgentHintRules(rules, signals({ n: 9 }))).toEqual([
      "independent",
      "first",
    ]);
    expect(evaluateAgentHintRules(rules, signals({ n: 2 }))).toEqual([
      "independent",
      "second",
    ]);
    expect(evaluateAgentHintRules(rules, signals({ n: 0 }))).toEqual([
      "independent",
      "third",
    ]);
  });

  it("claims the group even when the matching rule cannot render", () => {
    const rules = [
      rule("needs-id", [], "Use {id}.", "g"),
      rule("fallback", [], "Fallback.", "g"),
    ];
    expect(evaluateAgentHintRules(rules, signals({}))).toEqual([]);
    expect(evaluateAgentHintRules(rules, signals({ id: "x" }))).toEqual([
      "Use x.",
    ]);
  });

  it("fills placeholders and leaves JSON braces alone", () => {
    expect(
      evaluateAgentHintRules(
        [
          rule(
            "r",
            [],
            'Got {status} at {origin}; try {"url":"{origin}","n":{count}}.',
          ),
        ],
        signals({ status: 404, origin: "https://a.example", count: 3 }),
      ),
    ).toEqual([
      'Got 404 at https://a.example; try {"url":"https://a.example","n":3}.',
    ]);
  });

  it("renders list placeholders with first and remaining modifiers", () => {
    const list = signals({ items: ["#1", "#2", "#3", "#4", "#5"] });
    expect(
      evaluateAgentHintRules(
        [
          rule(
            "r",
            [],
            "{items:first=3} and {items:remaining=3} more; all: {items}",
          ),
        ],
        list,
      ),
    ).toEqual(["#1, #2, #3 and 2 more; all: #1, #2, #3, #4, #5"]);
    expect(
      evaluateAgentHintRules(
        [rule("r", [], "{items:remaining=9}")],
        signals({ items: ["#1"] }),
      ),
    ).toEqual(["0"]);
  });

  it("emits nothing for list counts above the limit, however many digits", () => {
    const list = signals({ items: ["#1"] });
    for (const text of ["{items:first=101}", "{items:remaining=1000}"]) {
      expect(evaluateAgentHintRules([rule("r", [], text)], list)).toEqual([]);
    }
    expect(
      evaluateAgentHintRules([rule("r", [], "{items:first=100}")], list),
    ).toEqual(["#1"]);
  });

  it("emits nothing for modifiers on scalar signals", () => {
    expect(
      evaluateAgentHintRules([rule("r", [], "{n:first=2}")], signals({ n: 5 })),
    ).toEqual([]);
  });

  it("drops duplicate texts and caps the number of hints", () => {
    const rules = ["a", "a", "b", "c", "d"].map((text, i) =>
      rule(`r${i}`, [], text),
    );
    expect(evaluateAgentHintRules(rules, signals({}))).toEqual(["a", "b", "c"]);
  });
});

describe("agent hint rule parsing", () => {
  it("keeps valid rules in order and caps their number", () => {
    const raw = Array.from({ length: 40 }, (_, i) => ({
      id: `r${i}`,
      when: [],
      text: `Rule ${i}.`,
    }));
    const rules = parseAgentHintRules(raw);
    expect(rules).toHaveLength(32);
    expect(rules[0]).toEqual({ id: "r0", when: [], text: "Rule 0." });
  });

  it("returns no rules for anything but an array", () => {
    expect(parseAgentHintRules(undefined)).toEqual([]);
    expect(parseAgentHintRules({ id: "r" })).toEqual([]);
  });

  it("drops rules with too many conditions or oversized in lists", () => {
    const condition = { signal: "s", op: "eq", value: 1 };
    expect(
      parseAgentHintRules([
        { id: "many", when: Array(17).fill(condition), text: "x" },
        {
          id: "wide",
          when: [{ signal: "s", op: "in", value: Array(33).fill(1) }],
          text: "x",
        },
        { id: "nan", when: [{ signal: "s", op: "gt", value: NaN }], text: "x" },
        { id: "ok", when: Array(16).fill(condition), text: "x" },
      ]).map(r => r.id),
    ).toEqual(["ok"]);
  });
});
