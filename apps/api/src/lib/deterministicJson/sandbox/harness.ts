// Runs as the body of `async (input, host, require) => { ... }` in the
// code-sandbox jail. input is { code, html, url }: build a jsdom Document, run the
// generated extract(doc, askLlm) in jsdom's VM context, and bridge askLlm back to
// the API worker over host().
export const EXTRACTOR_HARNESS = String.raw`
const { JSDOM, VirtualConsole } = require("jsdom");
const vm = require("node:vm");

const dom = new JSDOM(input.html, {
  url: input.url || "https://example.invalid/",
  runScripts: "outside-only", // page scripts don't run; ours can.
  pretendToBeVisual: true,     // enables getComputedStyle, requestAnimationFrame.
  virtualConsole: new VirtualConsole(),
});

// jsdom doesn't implement innerText (it needs layout). Models reach for it
// constantly; alias it to textContent so those reads don't crash.
const proto = dom.window.HTMLElement.prototype;
if (!Object.getOwnPropertyDescriptor(proto, "innerText")) {
  Object.defineProperty(proto, "innerText", {
    get() { return this.textContent; },
    set(value) { this.textContent = value == null ? "" : String(value); },
    configurable: true,
  });
}

const context = dom.getInternalVMContext();

// Bridge askLlm back through the sandbox host-callback to the API worker.
dom.window.askLlm = (prompt, schema) =>
  Promise.resolve()
    .then(() => host("askLlm", { prompt: String(prompt == null ? "" : prompt), schema: schema == null ? null : schema }))
    .catch(() => null);

// Stringify inside the context so the result crosses the realm boundary as a
// plain primitive, and a non-JSON return (DOM node, circular ref) throws here.
const wrapped =
  "(async () => {\n" + input.code + "\n" +
  "  const __value = await extract(document, askLlm);\n" +
  "  return JSON.stringify(__value === undefined ? null : __value);\n" +
  "})()";

const json = await new vm.Script(wrapped).runInContext(context);
return JSON.parse(typeof json === "string" ? json : "null");
`;
