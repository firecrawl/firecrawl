// In-page capture of per-item modifier/option payloads for the menu format's `modifiers` option.
// Bundled at runtime by getMenuModifierScript() (see ../menuModifierScript.ts) and run as an
// executeJavascript action on a DoorDash/UberEats store page.
//
// Neither platform ships an item's modifiers in the store-page HTML; they load via a client-side
// POST on item-click (DoorDash graphql/itemPage, UberEats _p/api/getMenuItemV1). Strategy: one page
// load, then cheap same-session fetches:
//   1. Monkeypatch fetch and open one item so the app issues a real item-detail request; record its
//      URL + headers + body (the only way to obtain the exact auth headers without browser access).
//   2. Collect every item identifier from the store DOM.
//   3. Replay the recipe once per item (swapping the item id) with bounded concurrency, reusing the
//      session cookies/headers. No per-item browser interaction.
// Best-effort: any failure yields an empty items map rather than throwing.

const MAX_ITEMS = 150;
const CONCURRENCY = 8;
const RECIPE_WAIT_MS = 7000;
const OVERALL_BUDGET_MS = 30000;

interface CaptureResult {
  type: "menu-modifiers";
  value: {
    source: "doordash" | "ubereats" | null;
    items: Record<string, unknown>;
    error?: string;
  };
}

interface Recipe {
  url: string;
  headers: Record<string, string>;
  body: string;
}

const sleep = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms));

export async function captureMenuModifiers(): Promise<CaptureResult> {
  const out: CaptureResult = {
    type: "menu-modifiers",
    value: { source: null, items: {} },
  };
  try {
    const host = location.hostname;
    const isDD = /(^|\.)doordash\.com$/.test(host);
    const isUE = /(^|\.)ubereats\.com$/.test(host);
    if (!isDD && !isUE) return out;
    out.value.source = isDD ? "doordash" : "ubereats";

    // 1. Capture one real item-detail request by monkeypatching fetch.
    let recipe: Recipe | null = null;
    const origFetch = window.fetch.bind(window);
    const itemRe = isDD ? /\/graphql\/itemPage/ : /\/getMenuItemV1/;
    (window as unknown as { fetch: typeof fetch }).fetch = function (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> {
      try {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : (input as Request).url || "";
        const method = String(
          init?.method || (input as Request)?.method || "GET",
        ).toUpperCase();
        if (!recipe && itemRe.test(url) && method === "POST") {
          const headers: Record<string, string> = {};
          const h = init?.headers ?? (input as Request)?.headers;
          if (h) {
            if (typeof (h as Headers).forEach === "function") {
              (h as Headers).forEach((v: string, k: string) => {
                headers[k] = v;
              });
            } else if (Array.isArray(h)) {
              (h as [string, string][]).forEach(pair => {
                headers[pair[0]] = pair[1];
              });
            } else {
              Object.assign(headers, h);
            }
          }
          const body = init?.body ?? null;
          if (typeof body === "string") recipe = { url, headers, body };
        }
      } catch {
        /* ignore */
      }
      return origFetch(input, init);
    };

    // 2. Collect item identifiers, then open one item to fill the recipe.
    const targets: Record<string, string>[] = [];
    if (isDD) {
      const ids = new Set<string>();
      document.querySelectorAll('a[href*="itemId"]').forEach(a => {
        try {
          const v = new URL(
            (a as HTMLAnchorElement).href,
            location.origin,
          ).searchParams.get("itemId");
          if (v) ids.add(v);
        } catch {
          /* ignore */
        }
      });
      Array.from(ids)
        .slice(0, MAX_ITEMS)
        .forEach(id => targets.push({ id }));
    } else {
      const seen = new Set<string>();
      document.querySelectorAll('a[href*="modctx"]').forEach(a => {
        try {
          const raw = a.getAttribute("href") || "";
          const enc = raw.split("modctx=")[1];
          if (!enc) return;
          const ctx = JSON.parse(
            decodeURIComponent(decodeURIComponent(enc.split("&")[0])),
          ) as Record<string, string>;
          const uuid = ctx.itemUuid || ctx.menuItemUuid;
          if (uuid && !seen.has(uuid)) {
            seen.add(uuid);
            targets.push(ctx);
          }
        } catch {
          /* ignore */
        }
      });
      if (targets.length > MAX_ITEMS) targets.length = MAX_ITEMS;
    }

    const opener = document.querySelector(
      isDD ? 'a[href*="itemId"]' : 'a[href*="modctx"]',
    ) as HTMLElement | null;
    if (opener) {
      try {
        opener.click();
      } catch {
        /* ignore */
      }
    }
    const deadline = Date.now() + RECIPE_WAIT_MS;
    while (!recipe && Date.now() < deadline) await sleep(200);
    try {
      (window as unknown as { fetch: typeof fetch }).fetch = origFetch;
    } catch {
      /* ignore */
    }
    if (!recipe || targets.length === 0) return out;
    const cap: Recipe = recipe;

    // 3. Build a per-item body from the captured recipe.
    let template: Record<string, unknown>;
    try {
      template = JSON.parse(cap.body) as Record<string, unknown>;
    } catch {
      return out;
    }
    const buildReq = (
      t: Record<string, string>,
    ): { key: string; body: string } | null => {
      let v: Record<string, unknown>;
      try {
        v = JSON.parse(JSON.stringify(template)) as Record<string, unknown>;
      } catch {
        return null;
      }
      if (isDD) {
        const vars = v.variables as Record<string, unknown> | undefined;
        if (!vars) return null;
        vars.itemId = t.id;
        vars.cursorContext = null; // honor itemId over the baked-in cursor
        vars.shouldFetchPresetCarousels = false; // drop cross-sell carousels
        return { key: String(t.id), body: JSON.stringify(v) };
      }
      v.menuItemUuid = t.itemUuid || t.menuItemUuid;
      if (t.sectionUuid) v.sectionUuid = t.sectionUuid;
      if (t.subsectionUuid) v.subsectionUuid = t.subsectionUuid;
      return { key: String(v.menuItemUuid), body: JSON.stringify(v) };
    };

    // 4. Replay with bounded concurrency, reusing the session cookies/headers.
    const results: Record<string, unknown> = {};
    let idx = 0;
    const worker = async (): Promise<void> => {
      while (idx < targets.length) {
        const t = targets[idx++];
        const req = buildReq(t);
        if (!req || !req.key) continue;
        try {
          const r = await origFetch(cap.url, {
            method: "POST",
            headers: cap.headers,
            body: req.body,
            credentials: "include",
          });
          if (r.ok) results[req.key] = await r.json();
        } catch {
          /* ignore */
        }
      }
    };
    const pool: Promise<void>[] = [];
    for (let i = 0; i < Math.min(CONCURRENCY, targets.length); i++) {
      pool.push(worker());
    }
    await Promise.race([Promise.all(pool), sleep(OVERALL_BUDGET_MS)]);
    out.value.items = results;
  } catch (e) {
    out.value.error = String((e as Error)?.message ?? e);
  }
  return out;
}
