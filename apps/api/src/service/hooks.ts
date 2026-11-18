/*
 * Hook points: places where the service lets zero or more handlers take part
 * in what it is doing. A hook point is one of three kinds.
 *
 *   observe    The caller does not wait and cannot fail. A handler error is
 *              reported and goes no further.
 *   await      The caller waits for the handlers one after another. A handler
 *              error reaches the caller, which is how a handler stops the work.
 *   transform  Like await, and each handler may return a replacement for the
 *              value it was given.
 *
 * The kind belongs to the hook point, and the method that calls a point must
 * match it or the call does not compile.
 */
export interface Observe<Payload> {
  kind: "observe";
  payload: Payload;
}
export interface Await<Payload> {
  kind: "await";
  payload: Payload;
}
export interface Transform<Value, Info> {
  kind: "transform";
  value: Value;
  info: Info;
}

/**
 * The service's hook points, by name. A point is added here together with the
 * code that calls it.
 */
export interface HookPoints {}

type Point = Observe<any> | Await<any> | Transform<any, any>;
type PointMap<Points> = { [Name in keyof Points]: Point };
type NamesOfKind<Points, Kind extends Point["kind"]> = {
  [Name in keyof Points]: Points[Name] extends { kind: Kind } ? Name : never;
}[keyof Points];
type PayloadOf<P> = P extends Observe<infer Payload> | Await<infer Payload>
  ? Payload
  : never;
type ValueOf<P> = P extends Transform<infer Value, any> ? Value : never;
type InfoOf<P> = P extends Transform<any, infer Info> ? Info : never;

type HandlerOf<P> =
  P extends Transform<infer Value, infer Info>
    ? (value: Value, info: Info) => Value | void | Promise<Value | void>
    : (payload: PayloadOf<P>) => void | Promise<void>;

/** One handler or several per hook point. */
export type HandlersOf<Points> = {
  [Name in keyof Points]?: HandlerOf<Points[Name]> | HandlerOf<Points[Name]>[];
};

/** How a hook point is called. The method must match the point's kind. */
export interface HooksOf<Points> {
  observe<Name extends NamesOfKind<Points, "observe">>(
    name: Name,
    payload: PayloadOf<Points[Name]>,
  ): void;
  run<Name extends NamesOfKind<Points, "await">>(
    name: Name,
    payload: PayloadOf<Points[Name]>,
  ): Promise<void>;
  /** With no handler this returns the value itself, with no promise. */
  transform<Name extends NamesOfKind<Points, "transform">>(
    name: Name,
    value: ValueOf<Points[Name]>,
    info: InfoOf<Points[Name]>,
  ): ValueOf<Points[Name]> | Promise<ValueOf<Points[Name]>>;
}

export type HookHandlers = HandlersOf<HookPoints>;
export type Hooks = HooksOf<HookPoints>;

type AnyHandler = (first: unknown, second?: unknown) => unknown;

/**
 * Builds the dispatcher for a list of handler sets. Handlers of one hook point
 * run in the order of the list, and within one set in the order it gives them.
 * The sets are read once, here, and the dispatcher is frozen.
 */
export function buildHooks<Points extends PointMap<Points>>(
  sets: HandlersOf<Points>[],
  report: (hook: string, error: unknown) => void,
): HooksOf<Points> {
  const table = new Map<PropertyKey, AnyHandler[]>();
  for (const set of sets) {
    for (const [name, listed] of Object.entries(set)) {
      const handlers = Array.isArray(listed) ? listed : listed ? [listed] : [];
      if (handlers.length === 0) continue;
      table.set(name, [...(table.get(name) ?? []), ...handlers]);
    }
  }

  const hooks: HooksOf<Points> = {
    observe(name, payload) {
      // The caller cannot fail, so a reporter that throws stops here as well.
      // After a rejected handler it would otherwise be an unhandled rejection.
      const reportFailure = (error: unknown) => {
        try {
          report(String(name), error);
        } catch {
          // Nothing is left to report it to.
        }
      };
      for (const handler of table.get(name) ?? []) {
        try {
          Promise.resolve(handler(payload)).catch(reportFailure);
        } catch (error) {
          reportFailure(error);
        }
      }
    },
    async run(name, payload) {
      for (const handler of table.get(name) ?? []) {
        await handler(payload);
      }
    },
    transform(name, value, info) {
      const handlers = table.get(name);
      if (!handlers) return value;
      return (async () => {
        let current: unknown = value;
        for (const handler of handlers) {
          const next = await handler(current, info);
          if (next !== undefined) current = next;
        }
        return current as typeof value;
      })();
    },
  };
  return Object.freeze(hooks);
}
