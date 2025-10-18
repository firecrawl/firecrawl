import type { Config } from "jest";

const config: Config = {
  verbose: true,
  preset: "ts-jest",
  testEnvironment: "node",
  testPathIgnorePatterns: ["<rootDir>/dist/"],
  forceExit: true,
  // detectOpenHandles: true, // temp disabled due to rust lib
  openHandlesTimeout: 120000,
  watchAll: false,
};

export default config;
