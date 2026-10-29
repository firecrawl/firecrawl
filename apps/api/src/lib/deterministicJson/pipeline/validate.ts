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

// Crude check for forbidden runtime references. The generated code runs inside
// jsdom's VM context (see sandbox/harness.ts), which has no access to certain
// globals like fetch or XMLHttpRequest.
const FORBIDDEN_GLOBALS = new Set(["fetch", "XMLHttpRequest"]);

function detectForbiddenGlobals(
  source: ts.SourceFile,
  issues: GeneratedCodeIssue[],
): void {
  const seen = new Set<string>();

  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && FORBIDDEN_GLOBALS.has(node.text)) {
      // Skip identifiers that are property names of access expressions
      // (`foo.fetch` doesn't reference the global fetch) or local bindings.
      const parent = node.parent;
      const isPropertyName =
        parent &&
        ((ts.isPropertyAccessExpression(parent) && parent.name === node) ||
          (ts.isPropertyAssignment(parent) && parent.name === node) ||
          (ts.isBindingElement(parent) && parent.propertyName === node));
      if (!isPropertyName && !seen.has(node.text)) {
        seen.add(node.text);
        issues.push({
          field: "source",
          reason: `references forbidden global '${node.text}' (not available in the sandbox; will throw at runtime)`,
          excerpt: node.text,
        });
      }
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
