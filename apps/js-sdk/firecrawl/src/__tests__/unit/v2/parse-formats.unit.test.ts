import { describe, test, expect } from "vitest";
import { Firecrawl } from "../../../index";
import { SdkError } from "../../../v2/types";
import { mockFetch } from "../helpers/mockFetch";

const API_URL = "https://api.firecrawl.dev";
const API_KEY = "fc-test";

function makeClient(status: number, data: unknown) {
  const client = new Firecrawl({ apiKey: API_KEY, apiUrl: API_URL });
  const sent = mockFetch(() => ({ status, data }));
  return { client, sent };
}

describe("v2.getParseFormats unit", () => {
  test("GETs /v2/parse/formats with auth and unwraps data.formats", async () => {
    const { client, sent } = makeClient(200, {
      success: true,
      data: {
        formats: [
          { format: "pdf", kind: "document", extensions: [".pdf"], mimeTypes: ["application/pdf"], available: true },
          { format: "png", kind: "image", extensions: [".png"], mimeTypes: ["image/png"], available: false },
        ],
      },
    });

    const formats = await client.getParseFormats();

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ url: `${API_URL}/v2/parse/formats`, method: "get" });
    expect(sent[0]!.headers.authorization).toBe(`Bearer ${API_KEY}`);
    expect(formats).toHaveLength(2);
    expect(formats[0]).toEqual({ format: "pdf", kind: "document", extensions: [".pdf"], mimeTypes: ["application/pdf"], available: true });
    expect(formats[1]!.kind).toBe("image");
    expect(formats[1]!.mimeTypes).toEqual(["image/png"]);
    expect(formats[1]!.available).toBe(false);
  });

  test("tolerates unknown kinds and extra fields", async () => {
    const { client } = makeClient(200, {
      success: true,
      data: {
        formats: [
          { format: "mp3", kind: "audio", extensions: [".mp3"], mimeTypes: ["audio/mpeg"], available: true, maxSizeMb: 50 },
        ],
      },
    });

    const [format] = await client.getParseFormats();

    expect(format!.format).toBe("mp3");
    expect(format!.kind).toBe("audio");
    expect(format!.mimeTypes).toEqual(["audio/mpeg"]);
  });

  test("returns an empty list when formats is missing", async () => {
    const { client } = makeClient(200, { success: true, data: {} });

    await expect(client.getParseFormats()).resolves.toEqual([]);
  });

  test.each([401, 500])("throws SdkError on %i", async status => {
    const { client } = makeClient(status, { success: false, error: "Unauthorized" });

    const err = await client.getParseFormats().catch(e => e);

    expect(err).toBeInstanceOf(SdkError);
    expect(err.status).toBe(status);
    expect(err.message).toBe("Unauthorized");
  });

  test("throws SdkError when success is false", async () => {
    const { client } = makeClient(200, { success: false, error: "nope" });

    await expect(client.getParseFormats()).rejects.toBeInstanceOf(SdkError);
  });
});
