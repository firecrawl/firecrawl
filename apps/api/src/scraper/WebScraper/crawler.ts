import { AxiosError } from "axios";
import { load } from "cheerio"; // rustified
import { URL } from "url";
import { getLinksFromSitemap } from "./sitemap";
import robotsParser, { Robot } from "robots-parser";
import { getURLDepth } from "./utils/maxDepthUtils";
import { logger as _logger } from "../../lib/logger";
import { redisEvictConnection } from "../../services/redis";
import { extractLinks } from "@mendable/firecrawl-rs";
import {
  fetchRobotsTxt,
  createRobotsChecker,
  isUrlAllowedByRobots,
} from "../../lib/robots-txt";
import { ScrapeJobTimeoutError } from "../../lib/error";
import { ScrapeOptions } from "../../controllers/v2/types";
import { filterLinks, filterUrl } from "@mendable/firecrawl-rs";

export const SITEMAP_LIMIT = 100;

interface FilterResult {
  allowed: boolean;
  url?: string;
  denialReason?: string;
}

enum DenialReason {
  DEPTH_LIMIT = "URL exceeds maximum crawl depth",
  EXCLUDE_PATTERN = "URL matches exclude pattern",
  INCLUDE_PATTERN = "URL does not match required include pattern",
  ROBOTS_TXT = "URL blocked by robots.txt",
  FILE_TYPE = "URL points to a file type that is not crawled",
  URL_PARSE_ERROR = "URL could not be parsed",
  BACKWARD_CRAWLING = "URL cannot be crawled unless crawlEntireDomain is set to true",
  SOCIAL_MEDIA = "URL is a social media or email link",
  EXTERNAL_LINK = "External URL not allowed",
  SECTION_LINK = "URL contains section anchor (#)",
}

interface FilterLinksResult {
  links: string[];
  denialReasons: Map<string, string>;
}
export class WebCrawler {
  private jobId: string;
  private initialUrl: string;
  private baseUrl: string;
  private includes: string[];
  private excludes: string[];
  private maxCrawledLinks: number;
  private maxCrawledDepth: number;
  private visited: Set<string> = new Set();
  private crawledUrls: Map<string, string> = new Map();
  private limit: number;
  private robotsTxt: string;
  private robotsTxtUrl: string;
  public robots: Robot;
  private robotsCrawlDelay: number | null = null;
  private generateImgAltText: boolean;
  private allowBackwardCrawling: boolean;
  private allowExternalContentLinks: boolean;
  private allowSubdomains: boolean;
  private ignoreRobotsTxt: boolean;
  private regexOnFullURL: boolean;
  private logger: typeof _logger;
  private sitemapsHit: Set<string> = new Set();
  private maxDiscoveryDepth: number | undefined;
  private currentDiscoveryDepth: number;
  private zeroDataRetention: boolean;
  private location?: ScrapeOptions["location"];

  constructor({
    jobId,
    initialUrl,
    baseUrl,
    includes,
    excludes,
    maxCrawledLinks = 10000,
    limit = 10000,
    generateImgAltText = false,
    maxCrawledDepth = 10,
    allowBackwardCrawling = false,
    allowExternalContentLinks = false,
    allowSubdomains = false,
    ignoreRobotsTxt = false,
    regexOnFullURL = false,
    maxDiscoveryDepth,
    currentDiscoveryDepth,
    zeroDataRetention,
    location,
  }: {
    jobId: string;
    initialUrl: string;
    baseUrl?: string;
    includes?: string[];
    excludes?: string[];
    maxCrawledLinks?: number;
    limit?: number;
    generateImgAltText?: boolean;
    maxCrawledDepth?: number;
    allowBackwardCrawling?: boolean;
    allowExternalContentLinks?: boolean;
    allowSubdomains?: boolean;
    ignoreRobotsTxt?: boolean;
    regexOnFullURL?: boolean;
    maxDiscoveryDepth?: number;
    currentDiscoveryDepth?: number;
    zeroDataRetention?: boolean;
    location?: ScrapeOptions["location"];
  }) {
    this.jobId = jobId;
    this.initialUrl = initialUrl;
    this.baseUrl = baseUrl ?? new URL(initialUrl).origin;
    this.includes = Array.isArray(includes) ? includes : [];
    this.excludes = Array.isArray(excludes) ? excludes : [];
    this.limit = limit;
    this.robotsTxt = "";
    this.robotsTxtUrl = `${this.baseUrl}${this.baseUrl.endsWith("/") ? "" : "/"}robots.txt`;
    this.robots = robotsParser(this.robotsTxtUrl, this.robotsTxt);
    // Deprecated, use limit instead
    this.maxCrawledLinks = maxCrawledLinks ?? limit;
    this.maxCrawledDepth = maxCrawledDepth ?? 10;
    this.generateImgAltText = generateImgAltText ?? false;
    this.allowBackwardCrawling = allowBackwardCrawling ?? false;
    this.allowExternalContentLinks = allowExternalContentLinks ?? false;
    this.allowSubdomains = allowSubdomains ?? false;
    this.ignoreRobotsTxt = ignoreRobotsTxt ?? false;
    this.regexOnFullURL = regexOnFullURL ?? false;
    this.zeroDataRetention = zeroDataRetention ?? false;
    this.logger = _logger.child({
      crawlId: this.jobId,
      module: "WebCrawler",
      zeroDataRetention: this.zeroDataRetention,
    });
    this.maxDiscoveryDepth = maxDiscoveryDepth;
    this.currentDiscoveryDepth = currentDiscoveryDepth ?? 0;
    this.location = location;
  }

  public async filterLinks(
    sitemapLinks: string[],
    limit: number,
    maxDepth: number,
    fromMap: boolean = false,
  ): Promise<FilterLinksResult> {
    const denialReasons = new Map<string, string>();

    if (this.currentDiscoveryDepth === this.maxDiscoveryDepth) {
      this.logger.debug("Max discovery depth hit, filtering off all links", {
        currentDiscoveryDepth: this.currentDiscoveryDepth,
        maxDiscoveryDepth: this.maxDiscoveryDepth,
      });
      sitemapLinks.forEach(link => {
        denialReasons.set(link, "Maximum discovery depth reached");
      });
      return { links: [], denialReasons };
    }

    // If the initial URL is a sitemap.xml, skip filtering
    if (this.initialUrl.endsWith("sitemap.xml") && fromMap) {
      return { links: sitemapLinks.slice(0, limit), denialReasons };
    }

    try {
      const res = await filterLinks({
        links: sitemapLinks,
        limit: isFinite(limit) ? limit : undefined,
        maxDepth: maxDepth,
        baseUrl: this.baseUrl,
        initialUrl: this.initialUrl,
        regexOnFullUrl: this.regexOnFullURL,
        excludes: this.excludes,
        includes: this.includes,
        allowBackwardCrawling: this.allowBackwardCrawling,
        ignoreRobotsTxt: this.ignoreRobotsTxt,
        robotsTxt: this.robotsTxt,
        allowExternalContentLinks: this.allowExternalContentLinks,
        allowSubdomains: this.allowSubdomains,
      });

      const fancyDenialReasons = new Map<string, string>();
      Object.entries(res.denialReasons).forEach(([key, value]) => {
        fancyDenialReasons.set(key, DenialReason[value]);
      });

      if (process.env.FIRECRAWL_DEBUG_FILTER_LINKS) {
        for (const link of res.links) {
          this.logger.debug(`${link} OK`);
        }

        for (const [link, reason] of fancyDenialReasons) {
          this.logger.debug(`${link} ${reason}`);
        }
      }

      return {
        links: res.links,
        denialReasons: fancyDenialReasons,
      };
    } catch (error) {
      this.logger.error("Error filtering links in Rust, falling back to JS", {
        error,
        method: "filterLinks",
      });
    }

    const filteredLinks = sitemapLinks
      .filter(link => {
        let url: URL;
        try {
          url = new URL(link.trim(), this.baseUrl);
        } catch (error) {
          this.logger.debug(`Error processing link: ${link}`, {
            link,
            error,
            method: "filterLinks",
          });
          return false;
        }
        const path = url.pathname;

        const depth = getURLDepth(url.toString());

        // Check if the link exceeds the maximum depth allowed
        if (depth > maxDepth) {
          if (process.env.FIRECRAWL_DEBUG_FILTER_LINKS) {
            this.logger.debug(`${link} DEPTH FAIL`);
          }
          denialReasons.set(link, DenialReason.DEPTH_LIMIT);
          return false;
        }

        const excincPath = this.regexOnFullURL ? link : path;

        // Check if the link should be excluded
        if (this.excludes.length > 0 && this.excludes[0] !== "") {
          if (
            this.excludes.some(excludePattern =>
              new RegExp(excludePattern).test(excincPath),
            )
          ) {
            if (process.env.FIRECRAWL_DEBUG_FILTER_LINKS) {
              this.logger.debug(`${link} EXCLUDE FAIL`);
            }
            denialReasons.set(link, DenialReason.EXCLUDE_PATTERN);
            return false;
          }
        }

        // Check if the link matches the include patterns, if any are specified
        if (this.includes.length > 0 && this.includes[0] !== "") {
          if (
            !this.includes.some(includePattern =>
              new RegExp(includePattern).test(excincPath),
            )
          ) {
            if (process.env.FIRECRAWL_DEBUG_FILTER_LINKS) {
              this.logger.debug(`${link} INCLUDE FAIL`);
            }
            denialReasons.set(link, DenialReason.INCLUDE_PATTERN);
            return false;
          }
        }

        // Normalize the initial URL and the link to account for www and non-www versions
        const normalizedInitialUrl = new URL(this.initialUrl);
        let normalizedLink;
        try {
          normalizedLink = new URL(link);
        } catch (_) {
          if (process.env.FIRECRAWL_DEBUG_FILTER_LINKS) {
            this.logger.debug(`${link} URL PARSE FAIL`);
          }
          return false;
        }
        const initialHostname = normalizedInitialUrl.hostname.replace(
          /^www\./,
          "",
        );
        const linkHostname = normalizedLink.hostname.replace(/^www\./, "");

        // Ensure the protocol and hostname match, and the path starts with the initial URL's path
        // commented to able to handling external link on allowExternalContentLinks
        // if (linkHostname !== initialHostname) {
        //   return false;
        // }

        if (!this.allowBackwardCrawling) {
          if (
            !normalizedLink.pathname.startsWith(normalizedInitialUrl.pathname)
          ) {
            if (process.env.FIRECRAWL_DEBUG_FILTER_LINKS) {
              this.logger.debug(
                `${link} BACKWARDS FAIL ${normalizedLink.pathname} ${normalizedInitialUrl.pathname}`,
              );
            }
            denialReasons.set(link, DenialReason.BACKWARD_CRAWLING);
            return false;
          }
        }

        const isAllowed = this.ignoreRobotsTxt
          ? true
          : ((this.robots.isAllowed(link, "FireCrawlAgent") ||
              this.robots.isAllowed(link, "FirecrawlAgent")) ??
            true);
        // Check if the link is disallowed by robots.txt
        if (!isAllowed) {
          this.logger.debug(`Link disallowed by robots.txt: ${link}`, {
            method: "filterLinks",
            link,
          });
          if (process.env.FIRECRAWL_DEBUG_FILTER_LINKS) {
            this.logger.debug(`${link} ROBOTS FAIL`);
          }
          denialReasons.set(link, DenialReason.ROBOTS_TXT);
          return false;
        }

        if (this.isFile(link)) {
          if (process.env.FIRECRAWL_DEBUG_FILTER_LINKS) {
            this.logger.debug(`${link} FILE FAIL`);
          }
          denialReasons.set(link, DenialReason.FILE_TYPE);
          return false;
        }

        if (process.env.FIRECRAWL_DEBUG_FILTER_LINKS) {
          this.logger.debug(`${link} OK`);
        }
        return true;
      })
      .slice(0, limit);

    return { links: filteredLinks, denialReasons };
  }

  public async getRobotsTxt(
    skipTlsVerification = false,
    abort?: AbortSignal,
  ): Promise<string> {
    try {
      this.logger.debug("Attempting to fetch robots.txt", {
        method: "getRobotsTxt",
        initialUrl: this.initialUrl,
        skipTlsVerification,
      });

      const { content: robotsTxt, url } = await fetchRobotsTxt(
        {
          url: this.robotsTxtUrl,
          zeroDataRetention: this.zeroDataRetention,
          location: this.location,
        },
        this.jobId,
        this.logger,
        abort,
      );

      this.logger.debug("Successfully fetched robots.txt", {
        method: "getRobotsTxt",
        initialUrl: this.initialUrl,
        robotsTxtLength: robotsTxt.length,
        hasContent: robotsTxt.length > 0,
        finalUrl: url,
      });

      return robotsTxt;
    } catch (error) {
      this.logger.debug("Failed to fetch robots.txt", {
        method: "getRobotsTxt",
        initialUrl: this.initialUrl,
        error: error.message,
      });
      throw error;
    }
  }

  public importRobotsTxt(txt: string) {
    this.robotsTxt = txt;
    const checker = createRobotsChecker(this.initialUrl, txt);
    this.robots = checker.robots;
    this.robotsTxtUrl = checker.robotsTxtUrl;
    const delay =
      this.robots.getCrawlDelay("FireCrawlAgent") ||
      this.robots.getCrawlDelay("FirecrawlAgent");
    this.robotsCrawlDelay = delay !== undefined ? delay : null;

    const sitemaps = this.robots.getSitemaps();
    this.logger.debug("Processed robots.txt", {
      method: "importRobotsTxt",
      robotsTxtUrl: this.robotsTxtUrl,
      robotsTxtLength: txt.length,
      sitemapsFound: sitemaps.length,
      sitemaps: sitemaps,
      crawlDelay: this.robotsCrawlDelay,
    });
  }

  public getRobotsCrawlDelay(): number | null {
    return this.robotsCrawlDelay;
  }

  public async tryGetSitemap(
    urlsHandler: (urls: string[]) => unknown,
    fromMap: boolean = false,
    onlySitemap: boolean = false,
    timeout: number = 120000,
    abort?: AbortSignal,
    mock?: string,
  ): Promise<number> {
    this.logger.debug(`Fetching sitemap links from ${this.initialUrl}`, {
      method: "tryGetSitemap",
    });
    let leftOfLimit = this.limit;

    const normalizeUrl = (url: string) => {
      url = url.replace(/^https?:\/\//, "").replace(/^www\./, "");
      if (url.endsWith("/")) {
        url = url.slice(0, -1);
      }
      return url;
    };

    const _urlsHandler = async (urls: string[]) => {
      this.logger.debug("urlsHandler invoked");
      if (fromMap && onlySitemap) {
        return await urlsHandler(urls);
      } else {
        let filteredLinksResult = await this.filterLinks(
          [...new Set(urls)],
          leftOfLimit,
          this.maxCrawledDepth,
          fromMap,
        );
        let filteredLinks = filteredLinksResult.links;
        leftOfLimit -= filteredLinks.length;
        const pipeline = redisEvictConnection.pipeline();

        const normalizedUrls = filteredLinks.map(url => normalizeUrl(url));
        normalizedUrls.forEach(normalizedUrl => {
          pipeline.sadd("sitemap:" + this.jobId + ":links", normalizedUrl);
        });

        const results = await pipeline.exec();

        const uniqueURLs = filteredLinks.filter(
          (_, index) =>
            results &&
            results[index] &&
            !results[index][0] &&
            results[index][1] === 1,
        );

        await redisEvictConnection.expire(
          "sitemap:" + this.jobId + ":links",
          3600,
          "NX",
        );

        if (uniqueURLs.length > 0) {
          return await urlsHandler(uniqueURLs);
        }
      }
    };

    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error("Sitemap fetch timeout")), timeout);
    });

    // Allow sitemaps to be cached for 48 hours if they are requested from /map
    // - mogery
    const maxAge = fromMap && !onlySitemap ? 48 * 60 * 60 * 1000 : 0;

    try {
      const robotsSitemaps = this.robots.getSitemaps();
      this.logger.debug("Attempting to fetch sitemap links", {
        method: "tryGetSitemap",
        initialUrl: this.initialUrl,
        robotsSitemapsCount: robotsSitemaps.length,
        robotsSitemaps: robotsSitemaps,
        hasRobotsTxt: this.robotsTxt.length > 0,
      });

      let count = (await Promise.race([
        Promise.all([
          this.tryFetchSitemapLinks(
            this.initialUrl,
            _urlsHandler,
            abort,
            mock,
            maxAge,
          ),
          ...robotsSitemaps.map(x =>
            this.tryFetchSitemapLinks(x, _urlsHandler, abort, mock, maxAge),
          ),
        ]).then(results => results.reduce((a, x) => a + x, 0)),
        timeoutPromise,
      ])) as number;

      if (count > 0) {
        if (
          await redisEvictConnection.sadd(
            "sitemap:" + this.jobId + ":links",
            normalizeUrl(this.initialUrl),
          )
        ) {
          urlsHandler([this.initialUrl]);
        }
        count++;
      }

      await redisEvictConnection.expire(
        "sitemap:" + this.jobId + ":links",
        3600,
        "NX",
      );

      return count;
    } catch (error) {
      if (error.message === "Sitemap fetch timeout") {
        this.logger.warn("Sitemap fetch timed out", {
          method: "tryGetSitemap",
          timeout,
        });
        return 0;
      }
      this.logger.error("Error fetching sitemap", {
        method: "tryGetSitemap",
        error,
      });
      return 0;
    }
  }

  public async filterURL(href: string, url: string): Promise<FilterResult> {
    return await filterUrl({
      href: href,
      url: url,
      baseUrl: this.baseUrl,
      excludes: this.excludes,
      ignoreRobotsTxt: this.ignoreRobotsTxt,
      robotsTxt: this.robotsTxt,
      allowExternalContentLinks: this.allowExternalContentLinks,
      allowSubdomains: this.allowSubdomains,
    });
  }

  private async extractLinksFromHTMLRust(html: string, url: string) {
    const links = await extractLinks(html);
    const filteredLinks: string[] = [];
    for (const link of links) {
      const filterResult = await this.filterURL(link, url);
      if (filterResult.allowed && filterResult.url) {
        filteredLinks.push(filterResult.url);
      }
    }
    return filteredLinks;
  }

  private async extractLinksFromHTMLCheerio(html: string, url: string) {
    let links: string[] = [];

    const $ = load(html);
    for (let i = 0; i < $("a").length; i++) {
      const element = $("a")[i];
      let href = $(element).attr("href");
      if (href) {
        if (href.match(/^https?:\/[^\/]/)) {
          href = href.replace(/^https?:\//, "$&/");
        }
        const filterResult = await this.filterURL(href, url);
        if (filterResult.allowed && filterResult.url) {
          links.push(filterResult.url);
        }
      }
    }

    // Extract links from iframes with inline src
    for (let i = 0; i < $("iframe").length; i++) {
      const element = $("iframe")[i];
      const src = $(element).attr("src");
      if (src && src.startsWith("data:text/html")) {
        const iframeHtml = decodeURIComponent(src.split(",")[1]);
        const iframeLinks = await this.extractLinksFromHTMLCheerio(
          iframeHtml,
          url,
        );
        links = links.concat(iframeLinks);
      }
    }

    return links;
  }

  public async extractLinksFromHTML(html: string, url: string) {
    try {
      return [
        ...new Set(
          (await this.extractLinksFromHTMLRust(html, url))
            .map(x => {
              try {
                return new URL(x, url).href;
              } catch (e) {
                return null;
              }
            })
            .filter(x => x !== null) as string[],
        ),
      ];
    } catch (error) {
      this.logger.warn(
        "Failed to call html-transformer! Falling back to cheerio...",
        {
          error,
          module: "scrapeURL",
          method: "extractMetadata",
        },
      );
    }

    return await this.extractLinksFromHTMLCheerio(html, url);
  }

  private isRobotsAllowed(
    url: string,
    ignoreRobotsTxt: boolean = false,
  ): boolean {
    return ignoreRobotsTxt ? true : isUrlAllowedByRobots(url, this.robots);
  }

  public isFile(url: string): boolean {
    const fileExtensions = [
      ".png",
      ".jpg",
      ".jpeg",
      ".gif",
      ".css",
      ".js",
      ".ico",
      ".svg",
      ".tiff",
      // ".pdf",
      ".zip",
      ".exe",
      ".dmg",
      ".mp4",
      ".mp3",
      ".wav",
      ".pptx",
      // ".docx",
      ".xlsx",
      // ".xml",
      ".avi",
      ".flv",
      ".woff",
      ".ttf",
      ".woff2",
      ".webp",
      ".inc",
    ];

    try {
      const urlWithoutQuery = url.split("?")[0].toLowerCase();
      return fileExtensions.some(ext => urlWithoutQuery.endsWith(ext));
    } catch (error) {
      this.logger.error(`Error processing URL in isFile`, {
        method: "isFile",
        error,
      });
      return false;
    }
  }

  private async tryFetchSitemapLinks(
    url: string,
    urlsHandler: (urls: string[]) => unknown,
    abort?: AbortSignal,
    mock?: string,
    maxAge?: number,
  ): Promise<number> {
    const sitemapUrl =
      url.toLowerCase().endsWith(".xml") ||
      url.toLowerCase().endsWith(".xml.gz")
        ? url
        : `${url}${url.endsWith("/") ? "" : "/"}sitemap.xml`;

    this.logger.debug("Trying to fetch sitemap links", {
      method: "tryFetchSitemapLinks",
      originalUrl: url,
      sitemapUrl,
      isXmlUrl: url.endsWith(".xml"),
      isGzUrl: url.endsWith(".xml.gz"),
    });

    let sitemapCount: number = 0;

    // Try to get sitemap from the provided URL first
    try {
      sitemapCount = await getLinksFromSitemap(
        {
          sitemapUrl,
          urlsHandler,
          mode: "fire-engine",
          maxAge,
          zeroDataRetention: this.zeroDataRetention,
          location: this.location,
        },
        this.logger,
        this.jobId,
        this.sitemapsHit,
        abort,
        mock,
      );
    } catch (error) {
      if (error instanceof ScrapeJobTimeoutError) {
        throw error;
      } else {
        this.logger.debug(`Failed to fetch sitemap from ${sitemapUrl}`, {
          method: "tryFetchSitemapLinks",
          sitemapUrl,
          error,
        });
      }
    }

    // If this is a subdomain, also try to get sitemap from the main domain
    try {
      const urlObj = new URL(url);
      const hostname = urlObj.hostname;
      const domainParts = hostname.split(".");

      // Check if this is a subdomain (has more than 2 parts and not www)
      if (domainParts.length > 2 && domainParts[0] !== "www") {
        // Get the main domain by taking the last two parts
        const mainDomain = domainParts.slice(-2).join(".");
        const mainDomainUrl = `${urlObj.protocol}//${mainDomain}`;
        const mainDomainSitemapUrl = `${mainDomainUrl}/sitemap.xml`;

        try {
          // Get all links from the main domain's sitemap
          sitemapCount += await getLinksFromSitemap(
            {
              sitemapUrl: mainDomainSitemapUrl,
              urlsHandler(urls) {
                return urlsHandler(
                  urls.filter(link => {
                    try {
                      const linkUrl = new URL(link);
                      return linkUrl.hostname.endsWith(hostname);
                    } catch {}
                  }),
                );
              },
              mode: "fire-engine",
              maxAge,
              zeroDataRetention: this.zeroDataRetention,
              location: this.location,
            },
            this.logger,
            this.jobId,
            this.sitemapsHit,
            abort,
            mock,
          );
        } catch (error) {
          if (error instanceof ScrapeJobTimeoutError) {
            throw error;
          } else {
            this.logger.debug(
              `Failed to fetch main domain sitemap from ${mainDomainSitemapUrl}`,
              { method: "tryFetchSitemapLinks", mainDomainSitemapUrl, error },
            );
          }
        }
      }
    } catch (error) {
      if (error instanceof ScrapeJobTimeoutError) {
        throw error;
      } else {
        this.logger.debug(`Error processing main domain sitemap`, {
          method: "tryFetchSitemapLinks",
          url,
          error,
        });
      }
    }

    // If no sitemap found yet, try the baseUrl as a last resort
    if (sitemapCount === 0) {
      const baseUrlSitemap = `${this.baseUrl}/sitemap.xml`;
      try {
        sitemapCount += await getLinksFromSitemap(
          {
            sitemapUrl: baseUrlSitemap,
            urlsHandler,
            mode: "fire-engine",
            maxAge,
            zeroDataRetention: this.zeroDataRetention,
            location: this.location,
          },
          this.logger,
          this.jobId,
          this.sitemapsHit,
          abort,
          mock,
        );
      } catch (error) {
        if (error instanceof ScrapeJobTimeoutError) {
          throw error;
        } else {
          this.logger.debug(`Failed to fetch sitemap from ${baseUrlSitemap}`, {
            method: "tryFetchSitemapLinks",
            sitemapUrl: baseUrlSitemap,
            error,
          });
          if (error instanceof AxiosError && error.response?.status === 404) {
            // ignore 404
          } else {
            sitemapCount += await getLinksFromSitemap(
              {
                sitemapUrl: baseUrlSitemap,
                urlsHandler,
                mode: "fire-engine",
                maxAge,
                zeroDataRetention: this.zeroDataRetention,
                location: this.location,
              },
              this.logger,
              this.jobId,
              this.sitemapsHit,
              abort,
              mock,
            );
          }
        }
      }
    }

    if (this.sitemapsHit.size >= SITEMAP_LIMIT) {
      this.logger.warn("Sitemap limit hit!", {
        crawlId: this.jobId,
        url: this.baseUrl,
      });
    }

    this.logger.debug("Finished trying to fetch sitemap links", {
      method: "tryFetchSitemapLinks",
      originalUrl: url,
      sitemapUrl,
      linksFound: sitemapCount,
      totalSitemapsHit: this.sitemapsHit.size,
    });

    return sitemapCount;
  }
}
