export enum Endpoint {
  Scrape = "scrape",
  Crawl = "crawl",
  Search = "search",
  Map = "map",
  Extract = "extract",
}

export enum AgentModel {
  FIRE_1 = "FIRE-1",
}

export enum FormatType {
  Markdown = "markdown",
  Summary = "summary",
  Json = "json",
  RawHtml = "rawHtml",
  Html = "html",
  Screenshot = "screenshot",
  ScreenshotFullPage = "screenshot@fullPage",
  Links = "links",
}

export enum SearchFormatType {
  Web = "web",
  Images = "images",
  News = "news",
}

type Prev = [never, 0, 1, 2, 3, 4, 5];

type Join<K, P> = K extends string | number
  ? P extends string | number
    ? `${K}.${P}`
    : never
  : never;

export type Paths<T, D extends number = 5> = [D] extends [never]
  ? never
  : T extends object
    ? {
        [K in keyof T]-?: K extends string | number
          ? T[K] extends object
            ? K | Join<K, Paths<T[K], Prev[D]>>
            : K
          : never;
      }[keyof T]
    : "";
