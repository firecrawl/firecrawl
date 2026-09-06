import ts from "typescript";

export interface GeneratedCodeIssue {
  field: string;
  reason: string;
  excerpt: string;
}

function parseSource(code: string): ts.SourceFile {
  return ts.createSourceFile(
    "extractor.js",
    code,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
}

function stripCodeFences(raw: string): string {
  const text = raw.trim();

  const fenced = text.match(/```(?:javascript|js|ts)?\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1]!.trim();

  return text
    .replace(/^```(?:javascript|js|ts)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
}

function findTopLevelExtractor(
  source: ts.SourceFile,
): ts.FunctionDeclaration | undefined {
  // On a duplicate `function extract`, the last declaration wins at runtime.
  const matches = source.statements.filter(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === "extract" &&
      !!statement.body,
  );
  return matches[matches.length - 1];
}

function isAllowedTopLevelDeclaration(statement: ts.Statement): boolean {
  return (
    ts.isFunctionDeclaration(statement) ||
    ts.isVariableStatement(statement) ||
    ts.isClassDeclaration(statement)
  );
}

export function cleanGeneratedCode(raw: string): string {
  const code = stripCodeFences(raw).trim();

  const source = parseSource(code);
  const fn = findTopLevelExtractor(source);
  if (!fn) {
    throw new Error("LLM did not return a function named extract");
  }

  const kept = source.statements.filter(
    statement =>
      statement === fn ||
      (isAllowedTopLevelDeclaration(statement) &&
        !ts.isEmptyStatement(statement)),
  );

  // The sandbox runs this as a plain script, so a surviving `export` would throw.
  return kept
    .map(statement =>
      code
        .slice(statement.getStart(source), statement.end)
        .replace(/^\s*export\s+(?:default\s+)?/i, ""),
    )
    .join("\n\n")
    .trim();
}

function nodeExcerpt(source: ts.SourceFile, node: ts.Node): string {
  const text = node.getText(source).replace(/\s+/g, " ").trim();
  return text.length > 180 ? `${text.slice(0, 177)}...` : text;
}

function validateTopLevelShape(
  source: ts.SourceFile,
  fn: ts.FunctionDeclaration | undefined,
  issues: GeneratedCodeIssue[],
): void {
  const parseDiagnostics =
    (source as ts.SourceFile & { parseDiagnostics?: ts.Diagnostic[] })
      .parseDiagnostics ?? [];
  for (const diagnostic of parseDiagnostics.slice(0, 3)) {
    issues.push({
      field: "source",
      reason: ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
      excerpt: "",
    });
  }

  if (!fn) {
    issues.push({
      field: "source",
      reason: "missing function declaration named extract",
      excerpt: "",
    });
    return;
  }

  const extras = source.statements.filter(
    statement =>
      statement !== fn &&
      !ts.isEmptyStatement(statement) &&
      !isAllowedTopLevelDeclaration(statement),
  );

  for (const extra of extras) {
    issues.push({
      field: "source",
      reason:
        "top-level code is not allowed; only function/class/const/let/var declarations may sit beside extract",
      excerpt: nodeExcerpt(source, extra),
    });
  }

  const isAsync = fn.modifiers?.some(
    modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword,
  );

  if (!isAsync) {
    issues.push({
      field: "extract",
      reason: "extract must be async",
      excerpt: nodeExcerpt(source, fn),
    });
  }

  if (fn.parameters.length !== 2) {
    issues.push({
      field: "extract",
      reason: "extract must accept exactly two parameters: doc and askLlm",
      excerpt: nodeExcerpt(source, fn),
    });
  }
}

// Reject references a generated DOM extractor has no legitimate reason to use.
// The extractor runs inside jsdom's VM context (see sandbox/harness.ts); this is
// a best-effort validation/robustness layer, not an exhaustive one, and not the
// enforcement boundary (the runtime sandbox is). It flags the disallowed names
// where they are statically and unambiguously reached — member (`x.name`),
// computed-string (`x["name"]`), and declaration destructuring
// (`const { name } = x`), plus `with`. Names reached only through indirection are
// deliberately out of scope, since resolving them reliably needs analysis this
// pass doesn't do: a variable-keyed access (`x[k]`), a reflection helper, or an
// assignment / `for..of` destructuring pattern.
//
// Globals the sandbox doesn't provide, plus code-eval primitives (`Function`/
// `eval`) and ambient objects (`globalThis`/`Reflect`/`Proxy`) extractors never
// need.
const FORBIDDEN_GLOBALS = new Set([
  "fetch",
  "XMLHttpRequest",
  "Function",
  "eval",
  "process",
  "globalThis",
  "require",
  "Reflect",
  "Proxy",
]);

// Property names a DOM extractor should never read off an object, checked
// wherever a property is *reached* — `obj.NAME`, `obj["NAME"]`, and destructuring.
// `constructor`/`__proto__` reach constructors and prototypes,
// `getBuiltinModule`/`mainModule` are Node module internals, `Function`/`eval`
// are code-eval primitives, `fetch`/`XMLHttpRequest` are network primitives, and
// `globalThis`/`require`/`Reflect`/`Proxy` are ambient objects. These mirror
// FORBIDDEN_GLOBALS so the member/computed forms (e.g. `window.Reflect`) are
// covered too. `process` is intentionally omitted: it is a common data-field
// name, and unlike the others is not reachable as a member in the sandbox
// (`window.process` is undefined), so flagging it would be false positives only.
const FORBIDDEN_PROPERTIES = new Set([
  "constructor",
  "__proto__",
  "getBuiltinModule",
  "mainModule",
  "Function",
  "eval",
  "fetch",
  "XMLHttpRequest",
  "globalThis",
  "require",
  "Reflect",
  "Proxy",
]);

// A forbidden global name only matters as a *free reference*. Skip it when the
// identifier is instead a name being introduced or a property key: a member name
// (`x.fetch`), an object/class member (`{ fetch() {} }`), a declared binding
// (`const fetch = ...`, a parameter, a function/class name), or a destructuring
// target (`const { fetch } = x`). Otherwise a benign extractor that merely
// shadows the name would be rejected.
function isNameToken(id: ts.Identifier): boolean {
  const p = id.parent;
  if (!p) return false;
  if (
    (ts.isPropertyAccessExpression(p) && p.name === id) ||
    (ts.isPropertyAssignment(p) && p.name === id) ||
    (ts.isMethodDeclaration(p) && p.name === id) ||
    (ts.isGetAccessorDeclaration(p) && p.name === id) ||
    (ts.isSetAccessorDeclaration(p) && p.name === id) ||
    (ts.isPropertyDeclaration(p) && p.name === id)
  ) {
    return true;
  }
  return (
    (ts.isVariableDeclaration(p) && p.name === id) ||
    (ts.isParameter(p) && p.name === id) ||
    (ts.isFunctionDeclaration(p) && p.name === id) ||
    (ts.isFunctionExpression(p) && p.name === id) ||
    (ts.isClassDeclaration(p) && p.name === id) ||
    (ts.isClassExpression(p) && p.name === id) ||
    (ts.isBindingElement(p) && (p.name === id || p.propertyName === id))
  );
}

// The statically-known property name a name node reads: `NAME`, `"NAME"`, or a
// computed `["NAME"]` whose expression is a string literal. A name built from a
// variable (`[k]`) is not statically known — returns undefined (out of scope).
function staticPropertyName(nameNode: ts.Node): string | undefined {
  if (ts.isComputedPropertyName(nameNode)) {
    return ts.isStringLiteralLike(nameNode.expression)
      ? nameNode.expression.text
      : undefined;
  }
  return ts.isIdentifier(nameNode) || ts.isStringLiteralLike(nameNode)
    ? nameNode.text
    : undefined;
}

function detectForbiddenGlobals(
  source: ts.SourceFile,
  issues: GeneratedCodeIssue[],
): void {
  const seen = new Set<string>();

  const flag = (name: string, kind: "global" | "property" | "with"): void => {
    if (seen.has(name)) return;
    seen.add(name);
    const reason =
      kind === "global"
        ? `references disallowed global '${name}' (not available in the sandbox; will throw at runtime)`
        : kind === "with"
          ? "uses a `with` statement, which is not allowed in generated extractors"
          : `references disallowed property '${name}' (not permitted in generated extractors)`;
    issues.push({ field: "source", reason, excerpt: name });
  };

  const visit = (node: ts.Node): void => {
    // `with (x) { ... }` resolves bare identifiers against x's properties, which
    // would sidestep the property checks below; extractor code never needs it.
    if (ts.isWithStatement(node)) flag("with", "with");

    // Only a *free reference* to a forbidden global counts — not an identifier in
    // a name/declaration position (see isNameToken), so shadowing stays allowed.
    if (
      ts.isIdentifier(node) &&
      FORBIDDEN_GLOBALS.has(node.text) &&
      !isNameToken(node)
    ) {
      flag(node.text, "global");
    }

    // member access: `obj.constructor`, `obj.getBuiltinModule`, `obj.Function`
    if (
      ts.isPropertyAccessExpression(node) &&
      FORBIDDEN_PROPERTIES.has(node.name.text)
    ) {
      flag(node.name.text, "property");
    }

    // computed string access: `obj["constructor"]` — the form around the dot above.
    if (
      ts.isElementAccessExpression(node) &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      FORBIDDEN_PROPERTIES.has(node.argumentExpression.text)
    ) {
      flag(node.argumentExpression.text, "property");
    }

    // declaration destructuring: `const { constructor: C } = obj`, shorthand, and
    // computed `const { ["constructor"]: C } = obj` read the named property just
    // like member access. Only object-pattern, non-rest elements read a named
    // property — an array element binds by position and a rest element binds the
    // remainder, so neither is a property read; skip them so a local merely named
    // after a disallowed word isn't rejected.
    if (
      ts.isBindingElement(node) &&
      ts.isObjectBindingPattern(node.parent) &&
      !node.dotDotDotToken
    ) {
      const text = staticPropertyName(node.propertyName ?? node.name);
      if (text && FORBIDDEN_PROPERTIES.has(text)) flag(text, "property");
    }

    ts.forEachChild(node, visit);
  };

  visit(source);
}

export function validateGeneratedExtractor(code: string): GeneratedCodeIssue[] {
  const source = parseSource(code);
  const fn = findTopLevelExtractor(source);
  const issues: GeneratedCodeIssue[] = [];

  validateTopLevelShape(source, fn, issues);
  detectForbiddenGlobals(source, issues);

  return issues;
}

export function formatGeneratedCodeIssues(
  issues: GeneratedCodeIssue[],
): string {
  return issues
    .slice(0, 16)
    .map(issue => {
      const excerpt = issue.excerpt ? `; ${issue.excerpt}` : "";
      return `- ${issue.field}: ${issue.reason}${excerpt}`;
    })
    .join("\n");
}
