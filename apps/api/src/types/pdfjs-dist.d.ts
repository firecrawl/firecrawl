// pdfjs-dist's Node-side types reference `@napi-rs/canvas` for PDF rendering,
// which we don't install (optional dep, ignored — see package.json's
// `pnpm.ignoredOptionalDependencies`). We only call `getTextContent`, never
// rasterize, so an empty Canvas type is enough to satisfy the compiler.
declare module "@napi-rs/canvas" {
  // eslint-disable-next-line @typescript-eslint/no-empty-interface
  export interface Canvas {}
}
