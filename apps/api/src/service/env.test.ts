import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { assertEnv, defineEnv, describeEnv } from "./env";
import type { createService, run, service, Worker } from "./service";

interface EnvModule {
  defineEnv: typeof defineEnv;
  assertEnv: typeof assertEnv;
  describeEnv: typeof describeEnv;
}

interface ServiceModule {
  createService: typeof createService;
  run: typeof run;
  service: typeof service;
}

// The owners are kept for the process, so every test loads the files afresh.
let env: EnvModule;
let serviceModule: ServiceModule;

beforeEach(async () => {
  vi.resetModules();
  env = await import("./env.js");
  serviceModule = await import("./service.js");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const messageOf = (fn: () => void): string => {
  try {
    fn();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "did not throw";
};

const worker = (): Worker => ({ run: vi.fn() });
const build = (api: Worker) =>
  serviceModule.createService(
    { modules: {} },
    {
      core: { name: "core", workers: { api } },
      logger: { error: vi.fn() },
    },
  );

const mail = () =>
  z.object({
    MAIL_HOST: z.string(),
    MAIL_PORT: z.coerce.number().int().default(25),
    MAIL_SECURE: z.stringbool().optional(),
  });

// A check across two variables: copies need a host to go to.
const copies = () =>
  z
    .object({
      COPY_ENABLED: z.stringbool().default(false),
      COPY_HOST: z.string().optional(),
      COPY_PORT: z.coerce.number().int().default(25),
    })
    .superRefine((value, context) => {
      if (value.COPY_ENABLED && !value.COPY_HOST) {
        context.addIssue({
          code: "custom",
          path: ["COPY_ENABLED"],
          message: "COPY_ENABLED needs COPY_HOST",
        });
      }
    });

describe("defineEnv", () => {
  it("returns the parsed values of the variables the owner declares", () => {
    vi.stubEnv("MAIL_HOST", "mail.test");
    vi.stubEnv("MAIL_SECURE", "true");
    vi.stubEnv("MAIL_UNDECLARED", "ignored");

    expect(env.defineEnv("mail", mail())).toEqual({
      MAIL_HOST: "mail.test",
      MAIL_PORT: 25,
      MAIL_SECURE: true,
    });
  });

  it("reads only the variables the schema declares, whatever it does with other keys", () => {
    vi.stubEnv("MAIL_HOST", "mail.test");
    vi.stubEnv("MAIL_UNDECLARED", "ignored");

    expect(
      env.defineEnv("strict", z.strictObject({ MAIL_HOST: z.string() })),
    ).toEqual({ MAIL_HOST: "mail.test" });
    expect(
      env.defineEnv("loose", z.looseObject({ MAIL_HOST: z.string() })),
    ).toEqual({ MAIL_HOST: "mail.test" });
  });

  it("gives a variable that is set and empty to its schema, which decides what it means", () => {
    vi.stubEnv("MAIL_HOST", "");
    vi.stubEnv("MAIL_FROM", "");
    const unsetWhenEmpty = z.preprocess(
      value => (value === "" ? undefined : value),
      z.string().default("postmaster"),
    );

    expect(
      env.defineEnv(
        "mail",
        z.object({
          MAIL_HOST: z.string().default("localhost"),
          MAIL_FROM: unsetWhenEmpty,
        }),
      ),
    ).toEqual({ MAIL_HOST: "", MAIL_FROM: "postmaster" });
  });

  it("returns values that can be assigned", () => {
    vi.stubEnv("MAIL_HOST", "mail.test");
    const values = env.defineEnv("mail", mail());

    values.MAIL_HOST = "other.test";

    expect(values.MAIL_HOST).toBe("other.test");
  });

  it("does not throw on a problem, and throws when a variable of that owner is read", () => {
    vi.stubEnv("MAIL_HOST", undefined);
    vi.stubEnv("MAIL_PORT", "smtp");

    const values = env.defineEnv("mail", mail());

    expect(Object.keys(values)).toEqual([
      "MAIL_HOST",
      "MAIL_PORT",
      "MAIL_SECURE",
    ]);
    expect(
      messageOf(() => {
        void values.MAIL_SECURE;
      }),
    ).toBe(
      [
        "Invalid environment:",
        "  mail: MAIL_HOST: Invalid input: expected string, received undefined",
        "  mail: MAIL_PORT: Invalid input: expected number, received NaN",
      ].join("\n"),
    );
  });

  it("reports a check across variables that does not hold", () => {
    vi.stubEnv("COPY_ENABLED", "true");
    vi.stubEnv("COPY_HOST", undefined);

    env.defineEnv("copies", copies());

    expect(messageOf(() => env.assertEnv())).toBe(
      "Invalid environment:\n  copies: COPY_ENABLED: COPY_ENABLED needs COPY_HOST",
    );
  });

  it("returns the values when a check across variables holds", () => {
    vi.stubEnv("COPY_ENABLED", "true");
    vi.stubEnv("COPY_HOST", "copy.test");

    expect(env.defineEnv("copies", copies())).toEqual({
      COPY_ENABLED: true,
      COPY_HOST: "copy.test",
      COPY_PORT: 25,
    });
    expect(() => env.assertEnv()).not.toThrow();
  });

  it("runs a check across variables only once each of them has parsed", () => {
    vi.stubEnv("COPY_ENABLED", "true");
    vi.stubEnv("COPY_HOST", undefined);
    vi.stubEnv("COPY_PORT", "smtp");

    env.defineEnv("copies", copies());

    expect(messageOf(() => env.assertEnv())).toBe(
      "Invalid environment:\n  copies: COPY_PORT: Invalid input: expected number, received NaN",
    );
  });

  it("adds a later definition of the same owner to the earlier one", () => {
    vi.stubEnv("MAIL_HOST", "mail.test");
    vi.stubEnv("MAIL_USER", "postmaster");
    env.defineEnv("mail", mail());

    expect(env.defineEnv("mail", z.object({ MAIL_USER: z.string() }))).toEqual({
      MAIL_USER: "postmaster",
    });
    expect(() => env.assertEnv()).not.toThrow();
    expect(env.describeEnv()).toEqual({
      mail: ["MAIL_HOST", "MAIL_PORT", "MAIL_SECURE", "MAIL_USER"],
    });
  });

  it("keeps the problems of an earlier definition when a later one of the same owner fits", () => {
    vi.stubEnv("MAIL_HOST", undefined);
    const earlier = env.defineEnv("mail", mail());

    vi.stubEnv("MAIL_HOST", "mail.test");
    env.defineEnv("mail", z.object({ MAIL_HOST: z.string() }));

    const problems =
      "Invalid environment:\n  mail: MAIL_HOST: Invalid input: expected string, received undefined";
    expect(messageOf(() => env.assertEnv())).toBe(problems);
    expect(
      messageOf(() => {
        void earlier.MAIL_HOST;
      }),
    ).toBe(problems);
  });

  it("reports a problem that two definitions of one owner share once", () => {
    vi.stubEnv("MAIL_HOST", undefined);
    env.defineEnv("mail", mail());
    env.defineEnv("mail", z.object({ MAIL_HOST: z.string() }));

    expect(messageOf(() => env.assertEnv())).toBe(
      "Invalid environment:\n  mail: MAIL_HOST: Invalid input: expected string, received undefined",
    );
  });

  it("throws the problems itself once assertEnv has run", () => {
    env.assertEnv();
    vi.stubEnv("MAIL_HOST", undefined);

    expect(
      messageOf(() => {
        env.defineEnv("mail", mail());
      }),
    ).toBe(
      "Invalid environment:\n  mail: MAIL_HOST: Invalid input: expected string, received undefined",
    );
  });
});

describe("assertEnv", () => {
  it("passes when no owner is defined and when every owner fits", () => {
    expect(() => env.assertEnv()).not.toThrow();

    vi.stubEnv("MAIL_HOST", "mail.test");
    env.defineEnv("mail", mail());

    expect(() => env.assertEnv()).not.toThrow();
  });

  it("reports the problems of every owner at once, by owner name", () => {
    vi.stubEnv("MAIL_HOST", undefined);
    vi.stubEnv("MAIL_PORT", "smtp");
    vi.stubEnv("COPY_ENABLED", "true");
    vi.stubEnv("COPY_HOST", undefined);
    vi.stubEnv("QUEUE_URL", "amqp://queue.test");
    env.defineEnv("mail", mail());
    env.defineEnv("queue", z.object({ QUEUE_URL: z.url() }));
    env.defineEnv("copies", copies());

    expect(messageOf(() => env.assertEnv())).toBe(
      [
        "Invalid environment:",
        "  copies: COPY_ENABLED: COPY_ENABLED needs COPY_HOST",
        "  mail: MAIL_HOST: Invalid input: expected string, received undefined",
        "  mail: MAIL_PORT: Invalid input: expected number, received NaN",
      ].join("\n"),
    );
  });
});

describe("the service and the environment", () => {
  it("describe() lists the variables of each owner, in a fixed order", () => {
    vi.stubEnv("MAIL_HOST", "mail.test");
    vi.stubEnv("QUEUE_URL", "amqp://queue.test");
    env.defineEnv("queue", z.object({ QUEUE_URL: z.url() }));
    env.defineEnv("mail", mail());

    const described = build(worker()).describe().env;

    expect(described).toEqual({
      mail: ["MAIL_HOST", "MAIL_PORT", "MAIL_SECURE"],
      queue: ["QUEUE_URL"],
    });
    expect(Object.keys(described)).toEqual(["mail", "queue"]);
  });

  it("describe() returns a copy that does not change what a later call lists", () => {
    vi.stubEnv("MAIL_HOST", "mail.test");
    env.defineEnv("mail", mail());
    const service = build(worker());

    service.describe().env.mail.push("MAIL_EXTRA");

    expect(service.describe().env).toEqual({
      mail: ["MAIL_HOST", "MAIL_PORT", "MAIL_SECURE"],
    });
  });

  it("run() starts no role and installs nothing while an owner has a problem", () => {
    vi.stubEnv("MAIL_HOST", undefined);
    env.defineEnv("mail", mail());
    const api = worker();

    expect(
      messageOf(() => {
        void serviceModule.run(build(api), "api", "/app/main.js");
      }),
    ).toBe(
      "Invalid environment:\n  mail: MAIL_HOST: Invalid input: expected string, received undefined",
    );
    expect(api.run).not.toHaveBeenCalled();
    expect(() => serviceModule.service.workers).toThrow(
      "No service is installed",
    );
  });

  it("run() starts the role when every owner fits", async () => {
    vi.stubEnv("MAIL_HOST", "mail.test");
    env.defineEnv("mail", mail());
    const api = worker();

    await serviceModule.run(build(api), "api", "/app/main.js");

    expect(api.run).toHaveBeenCalledWith({ entry: "/app/main.js" });
  });
});
