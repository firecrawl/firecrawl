import { createLogger, format, transports } from "winston";

import { config } from "../config";
import { processRole } from "../service/service";
import { isJsonObject } from "./json-types";
import { configDotenv } from "dotenv";
configDotenv();

interface SerializedLogError {
  name: string;
  message: string;
  stack: string | undefined;
  cause: unknown;
}

function serializeLogError(error: Error): SerializedLogError {
  const serialized: SerializedLogError = {
    name: error.name,
    message: error.message,
    stack: error.stack,
    cause: error.cause,
  };
  for (const key of Object.keys(error)) {
    if (
      key === "name" ||
      key === "message" ||
      key === "stack" ||
      key === "cause"
    ) {
      continue;
    }
    const descriptor = Object.getOwnPropertyDescriptor(error, key);
    if (descriptor && descriptor.enumerable) {
      const prop: unknown = descriptor.value;
      Object.defineProperty(serialized, key, {
        value: prop,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }
  return serialized;
}

function logErrorReplacer(_key: string, value: unknown) {
  if (value instanceof Error) {
    return serializeLogError(value);
  }
  return value;
}

const logFormat = format.printf(info => {
  const metadata: unknown = info.metadata;
  const moduleName =
    isJsonObject(metadata) && typeof metadata.module === "string"
      ? metadata.module
      : "";
  const methodName =
    isJsonObject(metadata) && typeof metadata.method === "string"
      ? metadata.method
      : "";
  const details =
    info.level.includes("error") || info.level.includes("warn")
      ? JSON.stringify(info.metadata, logErrorReplacer)
      : "";
  return `${info.timestamp} ${info.level} [${moduleName}:${methodName}]: ${info.message} ${details}`;
});

// Filter function to prevent logging when zeroDataRetention is true
const zeroDataRetentionFilter = format(info => {
  const metadata: unknown = info.metadata;
  if (
    (isJsonObject(metadata) && metadata.zeroDataRetention === true) ||
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
            format: format.combine(zeroDataRetentionFilter, format.json()),
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
