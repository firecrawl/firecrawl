import type {
  AgentHintSignals,
  AgentHintSignalValue,
} from "./agent-hint-signals";

/**
 * Provider-supplied response guidance rules, evaluated locally against
 * computed signals.
 *
 * - Rules are evaluated in order; a rule fires when every condition in `when`
 *   holds (an empty `when` always holds).
 * - Rules sharing a `group` are alternatives: the first rule in the group whose
 *   conditions hold is the group's rule, and later rules in that group are
 *   skipped.
 * - `text` may contain `{signal}` placeholders. List signals also accept
 *   `{signal:first=N}` (first N items) and `{signal:remaining=N}` (count of
 *   items after the first N), with N at most 100. Lists render joined with
 *   ", ". A rule whose text references an absent signal, or uses a modifier it
 *   cannot apply, emits nothing.
 * - A condition on an absent signal holds only for `exists` with `false`.
 */
type AgentHintRuleScalar = string | number | boolean;
type AgentHintRuleOp =
  | "eq"
  | "ne"
  | "lt"
  | "lte"
  | "gt"
  | "gte"
  | "in"
  | "exists";
export type AgentHintRuleCondition =
  | { signal: string; op: "eq" | "ne"; value: AgentHintRuleScalar }
  | { signal: string; op: "lt" | "lte" | "gt" | "gte"; value: number }
  | { signal: string; op: "in"; value: AgentHintRuleScalar[] }
  | { signal: string; op: "exists"; value: boolean };
export type AgentHintRule = {
  id: string;
  group?: string;
  when: AgentHintRuleCondition[];
  text: string;
};

const MAX_RULES = 32;
const MAX_CONDITIONS = 16;
const MAX_IN_VALUES = 32;
const MAX_NAME_LENGTH = 64;
const MAX_STRING_VALUE_LENGTH = 200;
const MAX_RULE_TEXT_LENGTH = 500;
const MAX_LIST_ARGUMENT = 100;
const MAX_RULE_HINTS = 3;

const SIGNAL_NAME = /^[a-z][a-z0-9_]*$/;
const PLACEHOLDER = /\{([a-z][a-z0-9_]*)(?::(first|remaining)=(\d+))?\}/g;

function cleanString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(/\p{Cc}/gu, " ").trim();
  return cleaned && cleaned.length <= maxLength ? cleaned : undefined;
}

function isScalar(value: unknown): value is AgentHintRuleScalar {
  return (
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value)) ||
    (typeof value === "string" && value.length <= MAX_STRING_VALUE_LENGTH)
  );
}

function parseCondition(raw: unknown): AgentHintRuleCondition | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const { signal, op, value } = raw as Record<string, unknown>;
  if (
    typeof signal !== "string" ||
    signal.length > MAX_NAME_LENGTH ||
    !SIGNAL_NAME.test(signal)
  ) {
    return undefined;
  }
  switch (op) {
    case "eq":
    case "ne":
      return isScalar(value) ? { signal, op, value } : undefined;
    case "lt":
    case "lte":
    case "gt":
    case "gte":
      return typeof value === "number" && Number.isFinite(value)
        ? { signal, op, value }
        : undefined;
    case "in":
      return Array.isArray(value) &&
        value.length <= MAX_IN_VALUES &&
        value.every(isScalar)
        ? { signal, op, value }
        : undefined;
    case "exists":
      return typeof value === "boolean" ? { signal, op, value } : undefined;
    default:
      return undefined;
  }
}

function parseRule(raw: unknown): AgentHintRule | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const rule = raw as Record<string, unknown>;
  const id = cleanString(rule.id, MAX_NAME_LENGTH);
  const text = cleanString(rule.text, MAX_RULE_TEXT_LENGTH);
  const group =
    rule.group === undefined
      ? undefined
      : cleanString(rule.group, MAX_NAME_LENGTH);
  const rawWhen = rule.when === undefined ? [] : rule.when;
  if (
    !id ||
    !text ||
    (rule.group !== undefined && !group) ||
    !Array.isArray(rawWhen) ||
    rawWhen.length > MAX_CONDITIONS
  ) {
    return undefined;
  }
  const when: AgentHintRuleCondition[] = [];
  for (const value of rawWhen) {
    const condition = parseCondition(value);
    if (!condition) return undefined;
    when.push(condition);
  }
  return group ? { id, group, when, text } : { id, when, text };
}

/**
 * Validates a rule set as a whole: returns undefined unless it is an array of
 * at most MAX_RULES rules that are all valid. Dropping individual rules could
 * change which rule in a group applies, so a partially valid set is rejected.
 */
export function parseAgentHintRules(
  values: unknown,
): AgentHintRule[] | undefined {
  if (!Array.isArray(values) || values.length > MAX_RULES) return undefined;
  const rules: AgentHintRule[] = [];
  for (const value of values) {
    const rule = parseRule(value);
    if (!rule) return undefined;
    rules.push(rule);
  }
  return rules;
}

function conditionHolds(
  condition: AgentHintRuleCondition,
  signals: AgentHintSignals,
): boolean {
  const actual: AgentHintSignalValue | undefined = signals.get(
    condition.signal,
  );
  if (condition.op === "exists") {
    return (actual !== undefined) === condition.value;
  }
  if (actual === undefined || Array.isArray(actual)) return false;
  switch (condition.op) {
    case "eq":
      return actual === condition.value;
    case "ne":
      return actual !== condition.value;
    case "in":
      return condition.value.includes(actual);
    case "lt":
      return typeof actual === "number" && actual < condition.value;
    case "lte":
      return typeof actual === "number" && actual <= condition.value;
    case "gt":
      return typeof actual === "number" && actual > condition.value;
    case "gte":
      return typeof actual === "number" && actual >= condition.value;
  }
}

function renderText(
  template: string,
  signals: AgentHintSignals,
): string | undefined {
  let complete = true;
  const rendered = template.replace(
    PLACEHOLDER,
    (_match, name: string, modifier?: string, count?: string) => {
      const value = signals.get(name);
      const n = count === undefined ? undefined : Number(count);
      if (
        value === undefined ||
        (modifier !== undefined && !Array.isArray(value)) ||
        (n !== undefined && n > MAX_LIST_ARGUMENT)
      ) {
        complete = false;
        return "";
      }
      if (!Array.isArray(value)) return String(value);
      if (modifier === "first") return value.slice(0, n).join(", ");
      if (modifier === "remaining") {
        return String(Math.max(0, value.length - (n ?? 0)));
      }
      return value.join(", ");
    },
  );
  return complete ? rendered : undefined;
}

export function evaluateAgentHintRules(
  rules: AgentHintRule[],
  signals: AgentHintSignals,
): string[] {
  const claimedGroups = new Set<string>();
  const hints: string[] = [];
  for (const rule of rules) {
    if (hints.length >= MAX_RULE_HINTS) break;
    if (rule.group !== undefined && claimedGroups.has(rule.group)) continue;
    if (!rule.when.every(condition => conditionHolds(condition, signals))) {
      continue;
    }
    if (rule.group !== undefined) claimedGroups.add(rule.group);
    const text = renderText(rule.text, signals);
    if (text && !hints.includes(text)) hints.push(text);
  }
  return hints;
}
