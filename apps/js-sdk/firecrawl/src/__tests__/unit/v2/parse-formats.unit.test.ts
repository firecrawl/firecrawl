import { describe, test, expect } from "@jest/globals";
import axios, { type AxiosAdapter } from "axios";
import { Firecrawl } from "../../../index";
import { SdkError } from "../../../v2/types";

const API_URL = "https://api.firecrawl.dev";
const API_KEY = "fc-test";

function makeClient(status: number, data: unknown) {
  const client = new Firecrawl({ apiKey: API_KEY, apiUrl: API_URL });
  const sent: Array<{ url: string; method?: string; authorization: unknown }> = [];
  const adapter: AxiosAdapter = async config => {
    sent.push({ url: axios.getUri(config), method: config.method, authorization: config.headers.Authorization });
    const response = { data, status, statusText: "", headers: {}, config };
    if (status >= 400) {
      throw new axios.AxiosError(`Request failed with status code ${status}`, "ERR_BAD_RESPONSE", config, null, response);
    }
    return response;
  };
  (client as any).http.instance.defaults.adapter = adapter;
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

    expect(sent).toEqual([{ url: `${API_URL}/v2/parse/formats`, method: "get", authorization: `Bearer ${API_KEY}` }]);
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
