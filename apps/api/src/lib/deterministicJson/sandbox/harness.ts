// Runs as the body of `async (input, host, require) => { ... }` in the
// code-sandbox jail. The jail image provides the extractor runtime.
export const EXTRACTOR_HARNESS = String.raw`
return require("/opt/extractor-runtime.cjs")(input, host);
`;
