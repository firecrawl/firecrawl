import { createLogger, format, transports } from "winston";
import { z } from "zod";

import { config } from "../config";
import { processRole } from "../service/service";
import { configDotenv } from "dotenv";
configDotenv();

interface SerializedLogError {
  name: string;
  message: string;
  stack: string | undefined;
  cause: unknown;
}

const moduleMetaSchema = z.object({
  module: z.string(),
});

const methodMetaSchema = z.object({
  method: z.string(),
});

const zeroDataRetentionMetaSchema = z.object({
  zeroDataRetention: z.literal(true),
});

function serializeLogError(error: Error): SerializedLogError {
  const { name, message, stack, cause } = error;
  const serialized: SerializedLogError = { name, message, stack, cause };
  // Copy own enumerable properties (invoking accessors) without overwriting core Error fields.
  Object.assign(serialized, error, { name, message, stack, cause });
  return serialized;
}

function logErrorReplacer(_key: string, value: unknown) {
  if (value instanceof Error) {
    return serializeLogError(value);
  }
  return value;
}

const logFormat = format.printf(info => {
  const parsedModule = moduleMetaSchema.safeParse(info.metadata);
  const parsedMethod = methodMetaSchema.safeParse(info.metadata);
  const moduleName = parsedModule.success ? parsedModule.data.module : "";
  const methodName = parsedMethod.success ? parsedMethod.data.method : "";
  const details =
    info.level.includes("error") || info.level.includes("warn")
      ? JSON.stringify(info.metadata, logErrorReplacer)
      : "";
  return `${info.timestamp} ${info.level} [${moduleName}:${methodName}]: ${info.message} ${details}`;
});

// Filter function to prevent logging when zeroDataRetention is true
const zeroDataRetentionFilter = format(info => {
  if (
    zeroDataRetentionMetaSchema.safeParse(info.metadata).success ||
    info.zeroDataRetention === true
  ) {
    return false; // Don't log this message
  }
  return info;
})();

/** The role this process was started as, or the file it was started from. */
const startedAs = processRole() ?? process.argv[1];

export const logger = createLogger({
  level: config.LOGGING_LEVEL?.toLowerCase() ?? "debug",
  format: format.json({
    replacer: logErrorReplacer,
  }),
  transports: [
    ...(config.FIRECRAWL_LOG_TO_FILE
      ? [
          new transports.File({
            filename:
              "firecrawl-" +
              (startedAs.includes("worker") ? "worker" : "app") +
              ".log",
            format: format.combine(
              zeroDataRetentionFilter,
              format.json({ replacer: logErrorReplacer }),
            ),
            maxsize: 10 * 1024 * 1024,
            maxFiles: 3,
            tailable: true,
          }),
        ]
      : []),
    new transports.Console({
      format: format.combine(
        zeroDataRetentionFilter,
        format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
        format.metadata({
          fillExcept: ["message", "level", "timestamp"],
        }),
        ...((config.ENV === "production" &&
          config.SENTRY_ENVIRONMENT === "dev") ||
        config.ENV !== "production"
          ? [format.colorize(), logFormat]
          : []),
      ),
    }),
  ],
});
