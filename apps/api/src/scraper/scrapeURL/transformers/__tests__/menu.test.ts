import { fetchMenu } from "../menu";
import { config } from "../../../../config";

describe("fetchMenu", () => {
  const originalFetch = global.fetch;
  const originalServiceUrl = config.MENU_EXTRACTION_SERVICE_URL;

  afterEach(() => {
    global.fetch = originalFetch;
    config.MENU_EXTRACTION_SERVICE_URL = originalServiceUrl;
    vi.clearAllMocks();
  });

  function baseMeta(
    formats: any[] = [{ type: "menu" }],
    teamFlags: any = { menuBeta: true },
  ) {
    return {
      url: "https://shop.test/menu",
      rewrittenUrl: "https://shop.test/menu",
      options: { formats },
      internalOptions: { teamFlags },
      logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
    } as any;
  }

  it("skips silently when the team lacks the menuBeta flag", async () => {
    config.MENU_EXTRACTION_SERVICE_URL = "https://menu.internal";
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as any;
    const document: any = {
      rawHtml: "<html></html>",
      metadata: { url: "https://shop.test/menu" },
    };

    // menuBeta not enabled -> no engine call, no menu, no warning (fail closed)
    const out = await fetchMenu(baseMeta([{ type: "menu" }], {}), document);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(out.menu).toBeUndefined();
    expect(out.warning).toBeUndefined();
  });

  it("warns and yields no menu when the service is not configured", async () => {
    config.MENU_EXTRACTION_SERVICE_URL = undefined;
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as any;
    const document: any = {
      rawHtml: "<html></html>",
      metadata: { url: "https://shop.test/menu" },
    };

    const out = await fetchMenu(baseMeta(), document);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(out.menu).toBeUndefined();
    expect(out.warning).toMatch(/not available/i);
  });

  it("posts rawHtml to the service and sets document.menu", async () => {
    config.MENU_EXTRACTION_SERVICE_URL = "https://menu.internal";
    const menu = {
      isMenu: true,
      confidence: 0.9,
      merchant: { name: "Test Diner" },
      sections: [],
      sourceUrl: "https://shop.test/menu",
    };
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) => ({
      ok: true,
      json: async () => ({ menu }),
    }));
    global.fetch = fetchSpy as any;
    const document: any = {
      rawHtml: "<html>jsonld</html>",
      metadata: { url: "https://shop.test/menu", title: "Test Diner Menu" },
    };

    const out = await fetchMenu(baseMeta(), document);

    expect(out.menu).toEqual(menu);
    const [calledUrl, init] = fetchSpy.mock.calls[0];
    expect(calledUrl).toBe("https://menu.internal/v1/scrape-menu");
    expect(init!.method).toBe("POST");
    expect(JSON.parse(init!.body as string)).toEqual({
      html: "<html>jsonld</html>",
      url: "https://shop.test/menu",
      title: "Test Diner Menu",
    });
  });

  it("warns (no menu) when the service reports no menu", async () => {
    config.MENU_EXTRACTION_SERVICE_URL = "https://menu.internal";
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ menu: null }),
    })) as any;
    const document: any = {
      rawHtml: "<p>about</p>",
      metadata: { url: "https://shop.test/about" },
    };

    const out = await fetchMenu(baseMeta(), document);

    expect(out.menu).toBeUndefined();
    expect(out.warning).toMatch(/no menu found/i);
  });

  it("throws when the service returns a non-JSON 200 response", async () => {
    config.MENU_EXTRACTION_SERVICE_URL = "https://menu.internal";
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => {
        throw new SyntaxError("Unexpected token < in JSON");
      },
    })) as any;
    const document: any = {
      rawHtml: "<html></html>",
      metadata: { url: "https://shop.test/menu" },
    };

    await expect(fetchMenu(baseMeta(), document)).rejects.toThrow(
      /Menu extraction failed/i,
    );
    expect(document.menu).toBeUndefined();
    expect(document.warning).toBeUndefined();
  });

  it("throws when the service 200 response omits the menu key", async () => {
    config.MENU_EXTRACTION_SERVICE_URL = "https://menu.internal";
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ unexpected: "shape" }),
    })) as any;
    const document: any = {
      rawHtml: "<html></html>",
      metadata: { url: "https://shop.test/menu" },
    };

    await expect(fetchMenu(baseMeta(), document)).rejects.toThrow(
      /unexpected response/i,
    );
    expect(document.menu).toBeUndefined();
    expect(document.warning).toBeUndefined();
  });

  it("early-returns when the menu format isn't requested", async () => {
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as any;
    const document: any = { rawHtml: "<html></html>", metadata: {} };

    const out = await fetchMenu(baseMeta([{ type: "markdown" }]), document);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(out.menu).toBeUndefined();
    expect(out.warning).toBeUndefined();
  });
});
