declare module "xml2js" {
  export type Xml2JsPrimitive = string | number | boolean | null;
  export type Xml2JsValue =
    | Xml2JsPrimitive
    | ReadonlyArray<Xml2JsValue | undefined>
    | { readonly [key: string]: Xml2JsValue | undefined };

  export function parseStringPromise(xml: string): Promise<Xml2JsValue>;
}
