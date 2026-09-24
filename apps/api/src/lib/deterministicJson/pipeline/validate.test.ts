import {
  validateGeneratedExtractor,
  type GeneratedCodeIssue,
} from "./validate";

const reasons = (issues: GeneratedCodeIssue[]): string =>
  issues.map(i => `${i.reason} ${i.excerpt}`).join("\n");

describe("validateGeneratedExtractor — disallowed reference rejection", () => {
  it("rejects constructor access on a value", () => {
    const code = `async function extract(doc, askLlm) {
      const C = askLlm.constructor;
      return { x: typeof C };
    }`;
    const issues = validateGeneratedExtractor(code);
    expect(issues.length).toBeGreaterThan(0);
    expect(reasons(issues)).toContain("constructor");
  });

  it("rejects chained constructor access", () => {
    const code = `async function extract(doc, askLlm) {
      const C = document.constructor.constructor;
      return { x: typeof C };
    }`;
    expect(validateGeneratedExtractor(code).length).toBeGreaterThan(0);
  });

  it('rejects computed-string constructor access ["constructor"]', () => {
    const code = `async function extract(doc, askLlm) {
      const C = askLlm["constructor"];
      return { x: typeof C };
    }`;
    const issues = validateGeneratedExtractor(code);
    expect(issues.length).toBeGreaterThan(0);
    expect(reasons(issues)).toContain("constructor");
  });

  it("rejects Node module-internal property access", () => {
    const code = `async function extract(doc, askLlm) {
      const a = doc.getBuiltinModule;
      const b = doc.mainModule;
      return { a: typeof a, b: typeof b };
    }`;
    const issues = validateGeneratedExtractor(code);
    expect(reasons(issues)).toContain("getBuiltinModule");
    expect(reasons(issues)).toContain("mainModule");
  });

  it.each(["Function", "eval", "process", "globalThis"])(
    "rejects the disallowed global %s",
    token => {
      const code = `async function extract(doc, askLlm) {
        const x = ${token};
        return { x: typeof x };
      }`;
      const issues = validateGeneratedExtractor(code);
      expect(reasons(issues)).toContain(token);
    },
  );

  it("accepts a normal DOM extractor unchanged", () => {
    const code = `async function extract(doc, askLlm) {
      const heading = doc.querySelector("h1");
      if (!heading) throw new Error("missing heading");
      const title = heading.textContent.trim();
      const links = [...doc.querySelectorAll("a")].map(a => a.getAttribute("href"));
      const summary = await askLlm("Summarize the page", { type: "string" });
      return { title, links, summary };
    }`;
    expect(validateGeneratedExtractor(code)).toEqual([]);
  });

  it("does not flag an object-literal key named constructor", () => {
    // The check keys off property *reads* (member/computed/destructuring), not
    // object-literal keys — building `{ constructor: v }` is ordinary data.
    const code = `async function extract(doc, askLlm) {
      const value = doc.querySelector("main")?.textContent ?? "";
      return { constructor: value };
    }`;
    expect(validateGeneratedExtractor(code)).toEqual([]);
  });

  it("rejects destructuring a disallowed property", () => {
    const code = `async function extract(doc, askLlm) {
      const { constructor: C } = askLlm;
      return { x: typeof C };
    }`;
    expect(reasons(validateGeneratedExtractor(code))).toContain("constructor");
  });

  it("rejects shorthand destructuring of a disallowed property", () => {
    const code = `async function extract(doc, askLlm) {
      const { constructor } = askLlm;
      return { x: typeof constructor };
    }`;
    expect(reasons(validateGeneratedExtractor(code))).toContain("constructor");
  });

  it("rejects a with statement", () => {
    const code = `async function extract(doc, askLlm) {
      with (doc) { return { x: 1 }; }
    }`;
    expect(reasons(validateGeneratedExtractor(code))).toContain("with");
  });

  it.each([
    ["window.Function", `return typeof window.Function;`],
    ["self.eval", `return typeof self.eval;`],
    ["this.Function", `return typeof this.Function;`],
    ["window.XMLHttpRequest", `return typeof window.XMLHttpRequest;`],
  ])("rejects a disallowed name reached via %s", (token, body) => {
    const code = `async function extract(doc, askLlm) { ${body} }`;
    const issues = validateGeneratedExtractor(code);
    expect(issues.length).toBeGreaterThan(0);
    expect(reasons(issues)).toContain(token.split(".")[1]);
  });

  it("rejects computed-string destructuring of a disallowed property", () => {
    const code = `async function extract(doc, askLlm) {
      const { ["constructor"]: C } = askLlm;
      return { x: typeof C };
    }`;
    expect(reasons(validateGeneratedExtractor(code))).toContain("constructor");
  });

  it.each([
    ["member", `return typeof window.fetch;`],
    ["computed", `return typeof window["fetch"];`],
  ])("rejects fetch reached off a global object (%s)", (_kind, body) => {
    const code = `async function extract(doc, askLlm) { ${body} }`;
    expect(reasons(validateGeneratedExtractor(code))).toContain("fetch");
  });

  it.each([
    [
      "an unused parameter",
      `async function extract(doc, process) {
      return { title: doc.title };
    }`,
    ],
    [
      "an object method name",
      `async function extract(doc, askLlm) {
      const o = { process() { return doc.title; } };
      return { x: o.process() };
    }`,
    ],
    [
      "an array-binding element",
      `async function extract(doc, askLlm) {
      const [fetch, constructor] = [doc.title, doc.URL];
      return { title: doc.title };
    }`,
    ],
    [
      "an object rest binding",
      `async function extract(doc, askLlm) {
      const { title, ...fetch } = doc;
      return { title };
    }`,
    ],
  ])("does not flag a forbidden name shadowed as %s", (_kind, code) => {
    // Only free references are flagged; a name introduced in a binding/member
    // position is not (a *use* of such a local would still be conservatively
    // flagged — static checks can't resolve scope).
    expect(validateGeneratedExtractor(code)).toEqual([]);
  });

  it("does not flag a value object literal with a disallowed key", () => {
    // `return { constructor: v }` builds data — an object-literal key is never a
    // property read — so it stays allowed.
    const code = `async function extract(doc, askLlm) {
      return { constructor: doc.title };
    }`;
    expect(validateGeneratedExtractor(code)).toEqual([]);
  });

  it.each([
    ["Reflect", `return typeof window.Reflect;`],
    ["Proxy", `return typeof window["Proxy"];`],
    ["require", `const { require: r } = globalThis; return { x: typeof r };`],
  ])(
    "rejects the ambient name %s reached off a global object",
    (name, body) => {
      const code = `async function extract(doc, askLlm) { ${body} }`;
      expect(reasons(validateGeneratedExtractor(code))).toContain(name);
    },
  );

  it.each([
    [
      "reflection via a string argument",
      `const F = Object.getOwnPropertyDescriptor(window, "constructor").value;
       return { x: typeof F };`,
    ],
    ["a data field named process", `return { p: doc.body.process ?? null };`],
    [
      "assignment-pattern destructuring",
      `let C; ({ constructor: C } = doc); return { x: typeof C };`,
    ],
    [
      "for-of destructuring",
      `let C; for ({ constructor: C } of [doc]) {} return { x: typeof C };`,
    ],
  ])("does not flag %s (out of scope by design)", (_k, body) => {
    const code = `async function extract(doc, askLlm) { ${body} }`;
    expect(validateGeneratedExtractor(code)).toEqual([]);
  });

  it("does not catch computed access through a variable (documented limitation)", () => {
    // Computed access through a variable is out of scope for this static check —
    // resolving `k` would need dataflow. Pinned so the gap is known, not a miss.
    const code = `async function extract(doc, askLlm) {
      const k = "constructor";
      const C = askLlm[k];
      return { x: typeof C };
    }`;
    expect(validateGeneratedExtractor(code)).toEqual([]);
  });
});
