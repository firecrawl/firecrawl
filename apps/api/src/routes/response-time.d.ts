declare module "response-time" {
  import type { RequestHandler } from "express";

  interface ResponseTimeOptions {
    digits?: number;
    header?: string;
    suffix?: boolean;
  }

  function responseTime(options?: ResponseTimeOptions): RequestHandler;
  export = responseTime;
}
