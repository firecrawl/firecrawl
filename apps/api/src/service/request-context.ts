/*
 * Who sent a request, and the terms the request runs under.
 *
 * Both are interfaces, so code built on the service can add its own fields
 * to them by declaration merging. The service reads only the fields written
 * here, and no code in this directory builds either value.
 */

/** Everything the service itself reads about the sender of a request. */
export interface BaseCaller {
  teamId: string;
}

/** The sender of a request, as authentication identified it. `req.caller` holds it. */
export interface Caller extends BaseCaller {}

/** Everything the service itself reads about the terms a request runs under. */
export interface BaseRequestContext {
  teamId: string;
  /** Nothing of this request's content may be stored or logged. */
  zeroDataRetention: boolean;
  /**
   * Settings a request can be accepted with. Nothing sets them yet, so the
   * code they are for does not read them yet. When it does, an absent flag
   * is off and an absent value means the service's default.
   */
  checkRobotsOnScrape?: boolean;
  robotsUserAgent?: string;
  crawlTtlHours?: number;
  skipCountryCheck?: boolean;
}

/**
 * The one value that travels with a request: on `req.ctx`, on the payload of
 * every job the request creates and on its crawl record. It is set once, when
 * the request is accepted. Work the service starts by itself has one too, set
 * once when that work starts.
 *
 * It crosses the queue, so it is plain JSON: a key holding `undefined` is gone
 * on the other side. Code that copies it copies it whole, keys it does not
 * know included.
 */
export interface RequestContext extends BaseRequestContext {}

declare global {
  namespace Express {
    interface Request {
      caller?: Caller;
      ctx?: RequestContext;
    }
  }
}
