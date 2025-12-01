import { createDefaultEsmPreset, type JestConfigWithTsJest } from "ts-jest";

const config: JestConfigWithTsJest = {
  ...createDefaultEsmPreset(),
  verbose: true,
  testPathIgnorePatterns: ["<rootDir>/dist/"],
  forceExit: true,
  detectOpenHandles: true,
  openHandlesTimeout: 120000,
  watchAll: false,
  reporters: [
    "default",
    [
      "jest-junit",
      {
        outputDirectory: "<rootDir>/test-results",
        outputName: "junit.xml",
        addFileAttribute: true,
        suiteNameTemplate: "{filepath}",
      },
    ],
  ],
};

export default config;
