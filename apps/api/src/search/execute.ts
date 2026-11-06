import type { Logger } from "winston";
import {
  discoverTools,
  isAlexandriaSource,
  usOnlyToolsWarning,
} from "./alexandria";
import {
  discoverSkills,
  isSkillsSource,
  SKILLS_DISCOVERY_TIMEOUT_MS,
  type SkillDiscovery,
} from "./skill-cards";
import {
  AUTO_TOOLS_WAIT_MS,
  FUSED_FIT_THRESHOLD,
  inferToolIntent,
  verifyTools,
} from "./tool-intent";
import type { DiscoveredTool } from "../services/alexandria/contracts";
import { search } from "./v2";
import {
  SearchV2Response,
  SearchResultType,
  SearchResultCountsBySource,
  SearchResultCategoriesBySource,
  countSearchResultsBySource,
  collectSearchResultCategories,
} from "../lib/entities";
import {
  buildSearchQuery,
  getCategoryFromUrl,
  CategoryOption,
} from "../lib/search-query-builder";
import { ScrapeOptions, TeamFlags } from "../controllers/v2/types";
import {
  getItemsToScrape,
  scrapeSearchResults,
  mergeScrapedContent,
  calculateScrapeCredits,
} from "./scrape";
import { searchDeveloperCategory, wantsDeveloperCategory } from "./developer";
import { searchGovCategory, wantsGovCategory } from "./gov";
import { removeExplicitResults } from "./safe-search";
import {
  matchesQueryOperators,
  planOperatorQuery,
  siteHostnames,
} from "./operators";
import {
  highlightsEnvReady,
  runIndexedSearchHighlights,
  searchHighlightsMode,
} from "./highlights";
import { trackSearchResults, trackSearchRequest } from "../lib/tracking";
import type { BillingMetadata } from "../services/billing/types";
import type { ThreatProtectionPolicy } from "../lib/threat-protection/types";
import { checkUrlsAgainstThreatPolicy } from "../lib/threat-protection/request";
import { calculateThreatScanCredits } from "../lib/scrape-billing";
import { config } from "../config";
import { logger as rootLogger } from "../lib/logger";
import { isUsOnly } from "../lib/us-only";

interface SearchOptions {
  query: string;
  limit: number;
  tbs?: string;
  filter?: string;
  lang?: string;
  country?: string;
  location?: string;
  safe?: boolean;
  sources: Array<{ type: string }>;
  categories?: CategoryOption[];
  includeDomains?: string[];
  excludeDomains?: string[];
  enterprise?: ("default" | "anon" | "zdr")[];
  scrapeOptions?: ScrapeOptions;
  highlights?: boolean;
  domainTools?: boolean;
  toolDetail?: "compact" | "summary" | "full";
  /** Rewrite the query before tool discovery. */
  inferToolQuery?: boolean;
  /** Add compact tools to a search that did not ask for them, when the query needs them. */
  autoTools?: boolean;
  /** Rank rewrite-found tools together with raw-query tools instead of after them. */
  toolFusion?: boolean;
  timeout: number;
}

interface SearchContext {
  teamId: string;
  orgId?: string | null;
  origin: string;
  integration?: string | null;
  apiKeyId: number | null;
  flags: TeamFlags;
  requestId: string;
  jobId: string;
  apiVersion: string;
  bypassBilling?: boolean;
  zeroDataRetention?: boolean;
  billing?: BillingMetadata;
  agentIndexOnly?: boolean;
  keylessReserved?: boolean;
  /** Effective threat protection policy; blocked domains are removed from results entirely. */
  threatProtectionPolicy?: ThreatProtectionPolicy | null;
  /** Set when the request legitimately opted out of Safe Mode at the controller. */
  safeModeBypassed?: boolean;
}

interface SearchExecuteResult {
  /** Parts of the search a US-only team could not be served. */
  usOnlyWarning?: string;
  toolsWarning?: string;
  /** The tools were added automatically, not requested. */
  toolsAuto?: boolean;
  toolsUnavailable?: boolean;
  /** Skill-card lookup returned the Exchange envelope, including an empty one. */
  skillsDiscovered?: boolean;
  response: SearchV2Response;
  totalResultsCount: number;
  resultCountsBySource: SearchResultCountsBySource;
  resultCategories: SearchResultCategoriesBySource;
  indexResultsCount: number;
  searchCredits: number;
  scrapeCredits: number;
  totalCredits: number;
  shouldScrape: boolean;
}

const toolKey = (tool: DiscoveredTool) => `${tool.provider}/${tool.capability}`;

function addTool(tools: Map<string, DiscoveredTool>, tool: DiscoveredTool) {
  const key = toolKey(tool);
  const previous = tools.get(key);
  tools.set(
    key,
    previous && "matchedBy" in previous && "matchedBy" in tool
      ? {
          ...previous,
          matchedBy: [
            ...new Set([
              ...(previous.matchedBy ?? []),
              ...(tool.matchedBy ?? []),
            ]),
          ],
          matchedUrls: [
            ...new Set([
              ...(previous.matchedUrls ?? []),
              ...(tool.matchedUrls ?? []),
            ]),
          ],
        }
      : (previous ?? tool),
  );
}

const RRF_K = 60;

/**
 * Orders tools by reciprocal rank fusion; ties keep the earlier list's order.
 * Tools `keep` rejects are left out without moving the ranks of the rest.
 */
function fuseRankings(
  lists: DiscoveredTool[][],
  keep: (tool: DiscoveredTool) => boolean,
): DiscoveredTool[] {
  const tools = new Map<string, DiscoveredTool>();
  const scores = new Map<string, number>();
  for (const list of lists)
    list.forEach((tool, index) => {
      if (!keep(tool)) return;
      addTool(tools, tool);
      const key = toolKey(tool);
      scores.set(key, (scores.get(key) ?? 0) + 1 / (RRF_K + index + 1));
    });
  return [...tools.entries()]
    .sort(([a], [b]) => scores.get(b)! - scores.get(a)!)
    .map(([, tool]) => tool);
}

export async function executeSearch(
  options: SearchOptions,
  context: SearchContext,
  logger: Logger,
): Promise<SearchExecuteResult> {
  const { query, limit, sources, categories, scrapeOptions } = options;
  const {
    teamId,
    orgId,
    origin,
    apiKeyId,
    flags,
    requestId,
    bypassBilling,
    zeroDataRetention,
    billing,
  } = context;

  const num_results_buffer = Math.floor(limit * 2);
  const usOnly = isUsOnly(flags);
  const usOnlyWarnings: string[] = [];

  logger.info("Searching for results");

  const wantsTools = sources.some(isAlexandriaSource);
  const wantsSkills = sources.some(isSkillsSource);
  const toolsAllowed =
    !zeroDataRetention &&
    !options.enterprise?.some(mode => mode === "zdr" || mode === "anon");
  const missedSkills: SkillDiscovery = { skills: [], succeeded: false };
  const skillsPromise =
    toolsAllowed && wantsSkills && query.trim()
      ? discoverSkills(
          {
            teamId,
            query,
            timeoutMs: Math.min(options.timeout, SKILLS_DISCOVERY_TIMEOUT_MS),
            usOnly,
          },
          logger,
        ).catch(error => {
          logger.warn("Skill discovery failed", { error });
          return missedSkills;
        })
      : null;
  const toolIntent =
    toolsAllowed &&
    (wantsTools ? options.inferToolQuery : options.autoTools) &&
    query.trim()
      ? inferToolIntent(query, logger)
      : null;
  const fuseTools = wantsTools && options.toolFusion === true;
  // Tools found only through the rewrite or inferred domains are added after Jev confirms they fit the query.
  const extraDiscovery = toolIntent
    ? toolIntent
        .then(async intent => {
          if (!wantsTools && !intent.needsTools) return null;
          const found = await discoverTools(
            {
              toolDetail: options.toolDetail ?? "compact",
              teamId,
              connectors: flags?.exchangeRetrieve === true,
              usOnly,
              limit,
              queries: wantsTools
                ? intent.toolQueries
                : [query, ...intent.toolQueries],
              urls:
                options.domainTools === false
                  ? []
                  : intent.domains.map(domain => `https://${domain}/`),
              timeoutMs: Math.min(options.timeout, 3000),
            },
            logger,
          );
          return {
            // Only fused semantic matches get the lower bar; domain matches keep the default.
            items: fuseTools
              ? (
                  await Promise.all([
                    verifyTools(
                      query,
                      found.items.slice(0, found.semanticMatches),
                      logger,
                      FUSED_FIT_THRESHOLD,
                    ),
                    found.items.length > found.semanticMatches
                      ? verifyTools(
                          query,
                          found.items.slice(found.semanticMatches),
                          logger,
                        )
                      : [],
                  ])
                ).flat()
              : await verifyTools(query, found.items, logger),
            found: found.items,
            semanticMatches: found.semanticMatches,
            usOnlyExcluded: found.usOnlyExcluded ?? 0,
          };
        })
        .catch(() => null)
    : null;
  let resolveToolUrls: (urls: string[]) => void = () => {};
  const baseDiscovery =
    toolsAllowed && (wantsTools || options.domainTools)
      ? discoverTools(
          {
            toolDetail: options.toolDetail ?? "compact",
            teamId,
            connectors: flags?.exchangeRetrieve === true,
            usOnly,
            limit,
            queries: wantsTools ? [query] : undefined,
            urls:
              options.domainTools === false
                ? []
                : new Promise<string[]>(resolve => {
                    resolveToolUrls = resolve;
                  }),
            timeoutMs: options.timeout,
          },
          logger,
        )
      : null;
  const searchTypes = [
    ...new Set(
      sources
        .filter(
          source => !isAlexandriaSource(source) && !isSkillsSource(source),
        )
        .map(source => source.type as SearchResultType),
    ),
  ];
  const operatorPlan = planOperatorQuery(query);
  const { operators } = operatorPlan;
  const nonEmpty = (list: string[]) => (list.length > 0 ? list : undefined);
  const { query: searchQuery, categoryMap } = buildSearchQuery(
    operatorPlan.query,
    categories,
    {
      includeDomains: options.includeDomains,
      excludeDomains: options.excludeDomains,
    },
  );

  // The developer and gov categories are each exclusive (schema-enforced) and
  // are served from their own index instead of the web SERP.
  const indexCategorySearch = wantsDeveloperCategory(categories)
    ? searchDeveloperCategory
    : wantsGovCategory(categories)
      ? searchGovCategory
      : null;
  const indexResultsPromise = indexCategorySearch
    ? indexCategorySearch(
        {
          query,
          limit,
          teamId,
          timeout: options.timeout,
          zeroDataRetention:
            zeroDataRetention === true ||
            options.enterprise?.some(
              mode => mode === "zdr" || mode === "anon",
            ) === true,
          ...(usOnly ? { usOnly, warnings: usOnlyWarnings } : {}),
        },
        logger,
      )
    : null;

  const searchResponse =
    ((wantsTools || wantsSkills) && !searchTypes.length) ||
    indexResultsPromise !== null
      ? ({} as SearchV2Response)
      : ((await search({
          query: searchQuery,
          logger,
          requestId: context.requestId,
          advanced: false,
          num_results: operatorPlan.relaxed
            ? Math.max(num_results_buffer, Math.min(limit * 5, 100))
            : num_results_buffer,
          tbs: options.tbs,
          filter: options.filter,
          lang: options.lang,
          country: options.country,
          location: options.location,
          safe: options.safe,
          type: searchTypes,
          enterprise: options.enterprise,
          includeDomains: options.includeDomains?.length
            ? options.includeDomains
            : nonEmpty(siteHostnames(operators.sites)),
          excludeDomains: nonEmpty([
            ...(options.excludeDomains ?? []),
            ...operators.excludedSites.filter(site => !site.includes("/")),
          ]),
          usOnly,
        })) as SearchV2Response);
  const keepOperatorMatches = <
    T extends { url?: string; title?: string; position?: number },
  >(
    results: T[] | undefined,
  ): T[] | undefined => {
    const kept = results?.filter(result =>
      matchesQueryOperators(result, operatorPlan),
    );
    return kept?.length === results?.length
      ? results
      : kept?.map((result, index) => ({ ...result, position: index + 1 }));
  };
  searchResponse.web = keepOperatorMatches(searchResponse.web);
  searchResponse.news = keepOperatorMatches(searchResponse.news);
  searchResponse.images = keepOperatorMatches(searchResponse.images);
  let indexResults =
    keepOperatorMatches(
      indexResultsPromise ? await indexResultsPromise : undefined,
    ) ?? [];

  // Threat protection: remove blocked results entirely — before
  // slicing/counting, before scraping, and before returning. Checks are
  // URL-level and deduped within this request; scan fees bill +2 per unique
  // scanned URL (see calculateThreatScanCredits), charged as part of the
  // search credits below.
  let threatScanCredits = 0;
  const threatPolicy = context.threatProtectionPolicy;
  if (threatPolicy && threatPolicy.mode !== "off") {
    const urlsToCheck = [
      ...(searchResponse.web ?? []).map(x => x.url),
      ...(searchResponse.news ?? []).map(x => x.url),
      ...(searchResponse.images ?? []).map(x => x.url),
      ...indexResults.map(x => x.url),
    ].filter((x): x is string => !!x);

    if (urlsToCheck.length > 0) {
      const { decisionsByUrl } = await checkUrlsAgainstThreatPolicy(
        urlsToCheck,
        threatPolicy,
        { teamId },
      );
      threatScanCredits = calculateThreatScanCredits(decisionsByUrl.values());
      const isAllowed = (url: string | undefined | null): boolean => {
        if (!url) return true;
        const decision = decisionsByUrl.get(url);
        return decision === undefined || decision.allowed;
      };
      if (searchResponse.web) {
        searchResponse.web = searchResponse.web.filter(x => isAllowed(x.url));
      }
      if (searchResponse.news) {
        searchResponse.news = searchResponse.news.filter(x => isAllowed(x.url));
      }
      if (searchResponse.images) {
        searchResponse.images = searchResponse.images.filter(x =>
          isAllowed(x.url),
        );
      }
      indexResults = indexResults.filter(x => isAllowed(x.url));
    }
  }

  // The filter shares results with TypeSafe, so zero data retention and
  // anonymous requests skip it.
  if (
    options.safe &&
    !zeroDataRetention &&
    !options.enterprise?.some(mode => mode === "zdr" || mode === "anon")
  ) {
    // Index results skip the SERP and its provider-side safe search, so they
    // are filtered from a response of their own before they are counted,
    // scraped or returned.
    const safeTarget: SearchV2Response = indexCategorySearch
      ? { web: indexResults }
      : searchResponse;
    await removeExplicitResults(safeTarget, limit, logger, teamId);
    if (safeTarget !== searchResponse) {
      indexResults = safeTarget.web ?? [];
    }
  }

  if (searchResponse.web && searchResponse.web.length > 0) {
    searchResponse.web = searchResponse.web.map(result => ({
      ...result,
      category: getCategoryFromUrl(result.url, categoryMap),
    }));
  }

  if (searchResponse.news && searchResponse.news.length > 0) {
    searchResponse.news = searchResponse.news.map(result => ({
      ...result,
      category: result.url
        ? getCategoryFromUrl(result.url, categoryMap)
        : undefined,
    }));
  }

  let totalResultsCount = 0;

  if (searchResponse.web && searchResponse.web.length > 0) {
    if (searchResponse.web.length > limit) {
      searchResponse.web = searchResponse.web.slice(0, limit);
    }
    totalResultsCount += searchResponse.web.length;
  }

  if (searchResponse.images && searchResponse.images.length > 0) {
    if (searchResponse.images.length > limit) {
      searchResponse.images = searchResponse.images.slice(0, limit);
    }
    totalResultsCount += searchResponse.images.length;
  }

  if (searchResponse.news && searchResponse.news.length > 0) {
    if (searchResponse.news.length > limit) {
      searchResponse.news = searchResponse.news.slice(0, limit);
    }
    totalResultsCount += searchResponse.news.length;
  }

  const indexResultsCount = indexResults.length;
  totalResultsCount += indexResultsCount;
  let toolsWarning: string | undefined;
  let toolsUnavailable = false;
  let toolsAuto = false;

  const waitForExtra = async (alongside?: Promise<unknown>) => {
    if (!extraDiscovery) return null;
    let timer: NodeJS.Timeout | undefined;
    let settled = false;
    const delay = (ms: number) =>
      new Promise<void>(resolve => {
        if (settled) return resolve();
        timer = setTimeout(resolve, ms);
        timer.unref();
      });
    // Fused tools are worth waiting for past the raw lookup; appended ones are not.
    const deadline = fuseTools
      ? Promise.resolve(alongside).then(() =>
          delay(config.ALEXANDRIA_TOOL_FUSION_WAIT_MS),
        )
      : Promise.all([delay(AUTO_TOOLS_WAIT_MS), alongside]);
    try {
      return await Promise.race([extraDiscovery, deadline.then(() => null)]);
    } finally {
      settled = true;
      clearTimeout(timer);
    }
  };

  if (baseDiscovery) {
    resolveToolUrls(
      [
        ...(searchResponse.web ?? []),
        ...(searchResponse.news ?? []),
        ...indexResults,
      ].flatMap(item => (item.url ? [item.url] : [])),
    );
    const [discovery, extra] = await Promise.all([
      baseDiscovery,
      waitForExtra(baseDiscovery),
    ]);
    const merged = new Map<string, DiscoveredTool>();
    if (fuseTools && extra) {
      // Semantic matches are fused; domain-only matches follow, as they do unfused.
      const fits = new Set(extra.items.map(toolKey));
      const baseSemantic = discovery.items.slice(0, discovery.semanticMatches);
      const baseKeys = new Set(baseSemantic.map(toolKey));
      for (const tool of [
        ...fuseRankings(
          [baseSemantic, extra.found.slice(0, extra.semanticMatches)],
          tool => baseKeys.has(toolKey(tool)) || fits.has(toolKey(tool)),
        ),
        ...discovery.items.slice(baseSemantic.length),
        ...extra.found
          .slice(extra.semanticMatches)
          .filter(tool => fits.has(toolKey(tool))),
      ])
        addTool(merged, tool);
    } else {
      for (const tool of [...discovery.items, ...(extra?.items ?? [])])
        addTool(merged, tool);
    }
    searchResponse.tools = [...merged.values()];
    // Both legs can hide the same tools, so the larger count is reported.
    const usOnlyExcluded = Math.max(
      discovery.usOnlyExcluded ?? 0,
      extra?.usOnlyExcluded ?? 0,
    );
    toolsWarning =
      [
        discovery.warning,
        usOnlyExcluded > 0 ? usOnlyToolsWarning(usOnlyExcluded) : undefined,
      ]
        .filter(Boolean)
        .join(" ") || undefined;
    toolsUnavailable = discovery.unavailable === true && !extra?.items.length;
  } else if (extraDiscovery) {
    const extra = await waitForExtra();
    if (extra?.items.length) {
      searchResponse.tools = extra.items;
      toolsAuto = true;
    }
    if (extra?.usOnlyExcluded) {
      toolsWarning = usOnlyToolsWarning(extra.usOnlyExcluded);
    }
  }

  const isZDR = options.enterprise?.includes("zdr");
  const creditsPerTenResults = isZDR ? 10 : 2;
  // Gov index results are free; developer index results bill like web results.
  const billableResultsCount =
    indexCategorySearch === searchGovCategory
      ? totalResultsCount - indexResultsCount
      : totalResultsCount;
  // Threat protection scan fees ride on the search credits: they are part of
  // serving the search itself (every result domain is scanned before
  // filtering), so they bill against the same feature and show up in the
  // request's creditsUsed.
  const searchCredits =
    Math.ceil(billableResultsCount / 10) * creditsPerTenResults +
    threatScanCredits;
  let scrapeCredits = 0;

  const shouldScrape =
    scrapeOptions?.formats && scrapeOptions.formats.length > 0;

  if (shouldScrape && scrapeOptions) {
    // Index results only become the web group at the end, so they are
    // scraped from a response of their own.
    const scrapeTarget: SearchV2Response = indexCategorySearch
      ? { web: indexResults }
      : searchResponse;
    const itemsToScrape = getItemsToScrape(scrapeTarget, flags, {
      team_id: teamId,
      org_id: orgId ?? null,
      origin,
    });

    if (itemsToScrape.length > 0) {
      const scrapeOpts = {
        teamId,
        orgId: orgId ?? null,
        origin,
        timeout: options.timeout,
        scrapeOptions,
        bypassBilling: bypassBilling ?? false,
        apiKeyId,
        zeroDataRetention,
        requestId,
        billing,
        agentIndexOnly: context.agentIndexOnly,
        keylessReserved: context.keylessReserved,
        threatProtectionPolicy: threatPolicy ?? null,
        safeModeBypassed: context.safeModeBypassed ?? false,
      };

      const allDocsWithCostTracking = await scrapeSearchResults(
        itemsToScrape.map(i => i.scrapeInput),
        scrapeOpts,
        logger,
        flags,
      );

      mergeScrapedContent(scrapeTarget, itemsToScrape, allDocsWithCostTracking);
      if (scrapeTarget !== searchResponse) {
        indexResults = scrapeTarget.web ?? [];
      }
      scrapeCredits = calculateScrapeCredits(allDocsWithCostTracking);
    }
  }

  // Every eligible request runs the same index-backed highlight path. MCP/CLI,
  // explicit opt-ins, and rollout-selected cohorts await and apply the result;
  // everyone else runs it in shadow without delaying or mutating the response.
  // Runs after scraping (mergeScrapedContent rebuilds the result objects, so
  // highlight mutations must come last to survive). Uses the user's original
  // query, not the domain-filtered upstream query.
  if (zeroDataRetention !== true && !isZDR && highlightsEnvReady()) {
    const mode = searchHighlightsMode({
      requested: options.highlights,
      origin: context.origin,
      integration: context.integration,
      cohortKey:
        context.apiKeyId !== null
          ? `api-key:${context.apiKeyId}`
          : `team:${context.teamId}`,
      rolloutPercent: config.HIGHLIGHT_ROLLOUT_PERCENT,
    });
    const highlightRun = runIndexedSearchHighlights(
      searchResponse,
      query,
      logger,
      {
        mode,
        requestId: context.requestId,
        teamId: context.teamId,
      },
    );

    if (mode === "apply") {
      await highlightRun;
    } else {
      void highlightRun.catch(error => {
        rootLogger.warn("Search highlights shadow failed", {
          canonicalLog: "search/highlights",
          mode,
          requestId: context.requestId,
          teamId: context.teamId,
          errorType: error instanceof Error ? error.name : "unknown",
        });
      });
    }
  }

  if (indexResultsPromise !== null) {
    // An index category is exclusive, so these are the only results: they ARE
    // the web group. Threat filtering above may have removed entries, so
    // renumber the survivors.
    searchResponse.web = indexResults.map((result, index) => ({
      ...result,
      position: index + 1,
    }));
  }

  let skillsDiscovered = false;
  if (skillsPromise) {
    const found = await skillsPromise;
    searchResponse.skills = found.skills;
    skillsDiscovered = found.succeeded;
  }

  const scrapeFormats = scrapeOptions?.formats
    ? scrapeOptions.formats.map((f: any) =>
        typeof f === "string" ? f : f.type,
      )
    : [];

  trackSearchRequest({
    searchId: context.jobId,
    requestId: context.requestId,
    teamId,
    query,
    origin,
    kind: billing?.endpoint ?? "search",
    apiVersion: context.apiVersion,
    lang: options.lang,
    country: options.country,
    sources: searchTypes,
    numResults: totalResultsCount,
    searchCredits,
    scrapeCredits,
    totalCredits: searchCredits + scrapeCredits,
    hasScrapeFormats: shouldScrape ?? false,
    scrapeFormats,
    isSuccessful: true,
    timeTaken: 0, // filled by caller if needed
    zeroDataRetention: zeroDataRetention ?? false,
  }).catch(err =>
    logger.warn("Search request tracking failed", { error: err }),
  );

  trackSearchResults({
    searchId: context.jobId,
    teamId,
    response: searchResponse,
    zeroDataRetention: zeroDataRetention ?? false,
    hasScrapeFormats: shouldScrape ?? false,
  }).catch(err => logger.warn("Search tracking failed", { error: err }));

  return {
    response: searchResponse,
    ...(usOnlyWarnings.length > 0
      ? { usOnlyWarning: usOnlyWarnings.join(" ") }
      : {}),
    toolsWarning,
    toolsUnavailable,
    toolsAuto,
    skillsDiscovered,
    totalResultsCount,
    // Counted from the final response — after scraping and highlights — so it
    // matches exactly what the client can address by position.
    resultCountsBySource: countSearchResultsBySource(searchResponse),
    // Read from the same final response, so a category is keyed by the position
    // the client sees. Index hits replace the web group above and are
    // renumbered there, so their positions here are the renumbered ones.
    resultCategories: collectSearchResultCategories(searchResponse),
    indexResultsCount,
    searchCredits,
    scrapeCredits,
    totalCredits: searchCredits + scrapeCredits,
    shouldScrape: shouldScrape ?? false,
  };
}
