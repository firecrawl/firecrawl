describe("OpenAI Compatibility Mode", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.resetModules();
  });

  it("uses openai.responses by default when compatibility mode is off", () => {
    jest.isolateModules(() => {
      const { getModel } = require("../lib/generic-ai");
      const model = getModel("gpt-4o", "openai");
      expect(model.provider).toBe("openai.responses");
    });
  });

  it("uses openai.chat when compatibility mode is enabled", () => {
    jest.isolateModules(() => {
      process.env.OPENAI_COMPATIBLE_MODE = "true";
      const { getModel } = require("../lib/generic-ai");
      const model = getModel("gpt-4o", "openai");
      expect(model.provider).toBe("openai.chat");
    });
  });

  it("preserves o3-mini forced chat completions regardless of compatibility mode", () => {
    jest.isolateModules(() => {
      process.env.OPENAI_COMPATIBLE_MODE = "false";
      const { getModel } = require("../lib/generic-ai");
      const model = getModel("o3-mini", "openai");
      expect(model.provider).toBe("openai.chat");
    });
  });

  it("passes structuredOutputs false to engpicker in compatibility mode", async () => {
    process.env.OPENAI_COMPATIBLE_MODE = "true";

    const generateObject = jest.fn().mockResolvedValue({
      object: { is_successful: true },
    });
    const scrapeURL = jest.fn().mockResolvedValue({
      success: true,
      document: { markdown: "real page content" },
    });

    jest.doMock("ai", () => ({
      generateObject,
    }));
    jest.doMock("../scraper/scrapeURL", () => ({
      scrapeURL,
    }));
    jest.doMock("@mendable/firecrawl-rs", () => ({
      computeEngpickerVerdict: jest.fn(),
    }));

    const { evaluateURL } = require("../lib/engpicker");
    const logger = {
      info: jest.fn(),
      warn: jest.fn(),
      child: jest.fn(),
    } as any;

    const result = await evaluateURL(
      "job-1",
      "https://example.com",
      "fire-engine;chrome-cdp",
      false,
      logger,
    );

    expect(result.result).toBe(true);
    expect(generateObject).toHaveBeenCalledWith(
      expect.objectContaining({
        providerOptions: {
          openai: {
            structuredOutputs: false,
          },
        },
      }),
    );
  });

  it("degrades engpicker evaluation failures to unsuccessful instead of throwing", async () => {
    process.env.OPENAI_COMPATIBLE_MODE = "true";

    const generateObject = jest
      .fn()
      .mockRejectedValue(new Error("json_object parse failure"));
    const scrapeURL = jest.fn().mockResolvedValue({
      success: true,
      document: { markdown: "real page content" },
    });

    jest.doMock("ai", () => ({
      generateObject,
    }));
    jest.doMock("../scraper/scrapeURL", () => ({
      scrapeURL,
    }));
    jest.doMock("@mendable/firecrawl-rs", () => ({
      computeEngpickerVerdict: jest.fn(),
    }));

    const { evaluateURL } = require("../lib/engpicker");
    const logger = {
      info: jest.fn(),
      warn: jest.fn(),
      child: jest.fn(),
    } as any;

    await expect(
      evaluateURL(
        "job-2",
        "https://example.com",
        "fire-engine;chrome-cdp",
        false,
        logger,
      ),
    ).resolves.toEqual({
      engine: "fire-engine;chrome-cdp",
      stealth: false,
      markdown: "real page content",
      result: false,
    });

    expect(logger.warn).toHaveBeenCalled();
  });
});
