import { describe, test, expect, jest } from "@jest/globals";
import { interact, stopInteraction } from "../../../v2/methods/scrape";
import { SdkError } from "../../../v2/types";

describe("JS SDK v2 scrape-browser methods", () => {
  test("interact posts to scrape interact endpoint", async () => {
    const post = jest.fn(async () => ({
      status: 200,
      data: {
        success: true,
        stdout: "ok",
        exitCode: 0,
      },
    }));

    const http = { post } as any;
    const response = await interact(http, "job-123", {
      code: "console.log('ok')",
    });

    expect(post).toHaveBeenCalledWith(
      "/v2/scrape/job-123/interact",
      { code: "console.log('ok')", language: "node" },
      {},
    );
    expect(response.success).toBe(true);
    expect(response.exitCode).toBe(0);
  });

  test("interact with prompt posts prompt to endpoint", async () => {
    const post = jest.fn(async () => ({
      status: 200,
      data: {
        success: true,
        output: "Clicked the button",
        liveViewUrl: "https://live.example.com/view",
        interactiveLiveViewUrl: "https://live.example.com/interactive",
        stdout: "",
        exitCode: 0,
      },
    }));

    const http = { post } as any;
    const response = await interact(http, "job-456", {
      prompt: "Click the login button",
    });

    expect(post).toHaveBeenCalledWith(
      "/v2/scrape/job-456/interact",
      { prompt: "Click the login button", language: "node" },
      {},
    );
    expect(response.success).toBe(true);
    expect(response.output).toBe("Clicked the button");
    expect(response.liveViewUrl).toBe("https://live.example.com/view");
    expect(response.interactiveLiveViewUrl).toBe(
      "https://live.example.com/interactive",
    );
  });

  test("interact throws when neither code nor prompt provided", async () => {
    const http = { post: jest.fn() } as any;
    await expect(interact(http, "job-123", {})).rejects.toThrow(
      "Either 'code' or 'prompt' must be provided",
    );
  });

  test("interact throws on non-200 response", async () => {
    const post = jest.fn(async () => ({
      status: 400,
      data: {
        success: false,
        error: "Invalid job ID format",
      },
    }));

    const http = { post } as any;
    await expect(
      interact(http, "bad-id", { code: "console.log('ok')" }),
    ).rejects.toBeInstanceOf(SdkError);
  });

  test("stopInteraction calls delete endpoint", async () => {
    const del = jest.fn(async () => ({
      status: 200,
      data: {
        success: true,
      },
    }));

    const http = { delete: del } as any;
    const response = await stopInteraction(http, "job-123");

    expect(del).toHaveBeenCalledWith("/v2/scrape/job-123/interact");
    expect(response.success).toBe(true);
  });

  test("stopInteraction throws on non-200 response", async () => {
    const del = jest.fn(async () => ({
      status: 404,
      data: {
        success: false,
        error: "Browser session not found.",
      },
    }));

    const http = { delete: del } as any;
    await expect(stopInteraction(http, "job-123")).rejects.toBeInstanceOf(
      SdkError,
    );
  });

  test("interact converts seconds-based body timeout to ms axios timeout", async () => {
    const post = jest.fn(async () => ({
      status: 200,
      data: { success: true, stdout: "ok", exitCode: 0 },
    }));

    const http = { post } as any;
    await interact(http, "job-123", {
      code: "console.log('ok')",
      timeout: 150,
    });

    expect(post).toHaveBeenCalledWith(
      "/v2/scrape/job-123/interact",
      { code: "console.log('ok')", language: "node", timeout: 150 },
      { timeoutMs: 155000 },
    );
  });
});
