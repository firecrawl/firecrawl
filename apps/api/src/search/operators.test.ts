import { describe, expect, it } from "vitest";
import {
  matchesQueryOperators,
  parseQueryOperators,
  planOperatorQuery,
  siteHostnames,
} from "./operators";

describe("parseQueryOperators", () => {
  it("reads site:, -site:, inurl:, intitle: and quoted values", () => {
    expect(
      parseQueryOperators(
        '"Acme" intitle:"Acme Corp" inurl:earnings -inurl:video site:news.example -site:jobs.news.example',
      ),
    ).toEqual({
      sites: ["news.example"],
      excludedSites: ["jobs.news.example"],
      inurl: ["earnings"],
      intitle: ["acme corp"],
      excludedInurl: ["video"],
      excludedIntitle: [],
    });
  });

  it("reads site: inside an OR group and ignores allintitle:", () => {
    const operators = parseQueryOperators(
      "(site:a.com OR site:https://b.com/docs/) allintitle:foo",
    );
    expect(operators.sites).toEqual(["a.com", "b.com/docs"]);
    expect(operators.intitle).toEqual([]);
  });
});

describe("planOperatorQuery", () => {
  it("ignores operator-like text inside quoted phrases", () => {
    const plan = planOperatorQuery('"Acme inurl:earnings" site:news.example');
    expect(plan.operators.inurl).toEqual([]);
    expect(plan.relaxed).toBe(false);
    expect(plan.query).toBe('"Acme inurl:earnings" site:news.example');
  });

  it("enforces nothing when OR joins anything but site: operators", () => {
    for (const query of [
      "(site:news.example OR intitle:Acme)",
      "Acme site:news.example OR earnings",
    ]) {
      const plan = planOperatorQuery(query);
      expect(plan.query).toBe(query);
      expect(plan.relaxed).toBe(false);
      expect(plan.operators.sites).toEqual([]);
      expect(
        matchesQueryOperators({ url: "https://other.example/" }, plan),
      ).toBe(true);
    }
  });

  it("keeps an OR chain of site: operators", () => {
    expect(
      planOperatorQuery(
        "Acme (site:a.example OR site:b.example OR site:c.example)",
      ).operators.sites,
    ).toEqual(["a.example", "b.example", "c.example"]);
  });

  it("keeps the closing parenthesis of a dropped negated operator", () => {
    expect(
      planOperatorQuery("site:news.example (Acme -inurl:video)").query,
    ).toBe("site:news.example (Acme )");
  });

  it("normalizes unicode site: hosts to ASCII", () => {
    const plan = planOperatorQuery("Acme site:bücher.example");
    expect(plan.operators.sites).toEqual(["xn--bcher-kva.example"]);
    expect(
      matchesQueryOperators({ url: "https://www.bücher.example/a" }, plan),
    ).toBe(true);
  });

  it("keeps a query without the site: plus inurl:/intitle: combination", () => {
    for (const query of [
      "earnings Contoso site:finance.example",
      "inurl:earnings Contoso",
      "intitle:Acme",
    ]) {
      const plan = planOperatorQuery(query);
      expect(plan.query).toBe(query);
      expect(plan.relaxed).toBe(false);
    }
  });

  it("sends inurl: with site: as a plain term", () => {
    const plan = planOperatorQuery(
      "inurl:earnings Contoso site:finance.example",
    );
    expect(plan.relaxed).toBe(true);
    expect(plan.query).toBe("earnings Contoso site:finance.example");
  });

  it("sends intitle: with site: as a plain term and enforces negated filters on results", () => {
    const plan = planOperatorQuery(
      '"Acme" intitle:Acme -intitle:Stadium site:news.example',
    );
    expect(plan.query).toBe('"Acme" Acme site:news.example');
    expect(
      matchesQueryOperators(
        { url: "https://www.news.example/a", title: "Acme results" },
        plan,
      ),
    ).toBe(true);
    expect(
      matchesQueryOperators(
        { url: "https://www.news.example/b", title: "Acme Stadium opens" },
        plan,
      ),
    ).toBe(false);
  });
});

describe("siteHostnames", () => {
  it("drops paths and duplicates", () => {
    expect(siteHostnames(["a.com/blog", "a.com", "b.com"])).toEqual([
      "a.com",
      "b.com",
    ]);
  });
});

describe("matchesQueryOperators", () => {
  const financePlan = planOperatorQuery(
    "inurl:earnings Contoso site:finance.example",
  );

  it("enforces site: and the relaxed inurl: on the returned URL", () => {
    expect(
      matchesQueryOperators(
        {
          url: "https://www.finance.example/2026/07/29/contoso-ctso-q4-earnings-report-2026.html",
        },
        financePlan,
      ),
    ).toBe(true);
    expect(
      matchesQueryOperators(
        { url: "https://www.finance.example/quotes/CTSO" },
        financePlan,
      ),
    ).toBe(false);
    expect(
      matchesQueryOperators(
        { url: "https://www.stocks.example/stocks/xnas/ctso/earnings" },
        financePlan,
      ),
    ).toBe(false);
  });

  it("enforces the relaxed intitle: on the title", () => {
    const plan = planOperatorQuery('"Acme" intitle:Acme site:news.example');
    expect(
      matchesQueryOperators(
        {
          url: "https://www.news.example/aktuell/wirtschaft/a.html",
          title: "Acme: Quarterly results - News",
        },
        plan,
      ),
    ).toBe(true);
    expect(
      matchesQueryOperators(
        {
          url: "https://www.news.example/aktuell/sport/b.html",
          title: "Local team wins again - News",
        },
        plan,
      ),
    ).toBe(false);
  });

  it("enforces site: alone, including paths and -site:", () => {
    const plan = planOperatorQuery(
      "Acme site:news.example/aktuell -site:blogs.news.example",
    );
    expect(plan.relaxed).toBe(false);
    expect(
      matchesQueryOperators(
        { url: "https://www.news.example/aktuell/x.html" },
        plan,
      ),
    ).toBe(true);
    expect(
      matchesQueryOperators(
        { url: "https://www.news.example/agenturmeldungen/x.html" },
        plan,
      ),
    ).toBe(false);
    expect(
      matchesQueryOperators(
        { url: "https://blogs.news.example/aktuell/x.html" },
        plan,
      ),
    ).toBe(false);
    expect(
      matchesQueryOperators({ url: "https://forum.example/r/x" }, plan),
    ).toBe(false);
    expect(
      matchesQueryOperators({ url: "https://notnews.example/aktuell/x" }, plan),
    ).toBe(false);
  });

  it("leaves results alone when the query has no site: operator", () => {
    const plan = planOperatorQuery("inurl:earnings Contoso");
    expect(
      matchesQueryOperators(
        { url: "https://quotes.example/quote/CTSO/" },
        plan,
      ),
    ).toBe(true);
  });
});
