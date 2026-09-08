import { useState, ChangeEvent, FormEvent, KeyboardEvent, useEffect } from "react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  CardFooter,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { handleNumberInputPageKey } from "@/lib/utils";

//! Hardcoded values (not recommended for production)
//! Highly recommended to move all Firecrawl API calls to the backend (e.g. Next.js API route)
const FIRECRAWL_API_URL = "https://api.firecrawl.dev"; // Replace with your actual API URL whether it is local or using Firecrawl Cloud
const FIRECRAWL_API_KEY = "fc-YOUR_API_KEY"; // Replace with your actual API key

interface FormData {
  url: string;
  crawlSubPages: boolean;
  search: string;
  limit: string;
  maxDepth: string;
  excludePaths: string;
  includePaths: string;
  extractMainContent: boolean;
}

interface CrawlerOptions {
  includes?: string[];
  excludes?: string[];
  maxDepth?: number;
  limit?: number;
  returnOnlyUrls: boolean;
}

interface ScrapeOptions {
  formats?: string[];
  onlyMainContent?: boolean;
}

interface PageOptions {
  onlyMainContent: boolean;
}

interface RequestBody {
  url: string;
  crawlerOptions?: CrawlerOptions;
  pageOptions?: PageOptions;
  search?: string;
  excludePaths?: string[];
  includePaths?: string[];
  maxDepth?: number;
  limit?: number;
  scrapeOptions?: ScrapeOptions;
  formats?: string[];
}

interface ScrapeResultMetadata {
  title: string;
  description: string;
  language: string;
  sourceURL: string;
  pageStatusCode: number;
  pageError?: string;
  [key: string]: string | number | undefined;
}

interface ScrapeResultData {
  markdown: string;
  content: string;
  html: string;
  rawHtml: string;
  metadata: ScrapeResultMetadata;
  llm_extraction: Record<string, unknown>;
  warning?: string;
}

interface ScrapeResult {
  success: boolean;
  data: ScrapeResultData;
}

export default function FirecrawlComponentV1() {
  const [formData, setFormData] = useState<FormData>({
    url: "",
    crawlSubPages: false,
    search: "",
    limit: "",
    maxDepth: "",
    excludePaths: "",
    includePaths: "",
    extractMainContent: false,
  });
  const [loading, setLoading] = useState<boolean>(false);
  const [scrapingSelectedLoading, setScrapingSelectedLoading] =
    useState<boolean>(false);
  const [crawledUrls, setCrawledUrls] = useState<string[]>([]);
  const [selectedUrls, setSelectedUrls] = useState<string[]>([]);
  const [scrapeResults, setScrapeResults] = useState<
    Record<string, ScrapeResult>
  >({});
  const [isCollapsibleOpen, setIsCollapsibleOpen] = useState(true);
  const [crawlStatus, setCrawlStatus] = useState<{
    current: number;
    total: number | null;
  }>({ current: 0, total: null });
  const [elapsedTime, setElapsedTime] = useState<number>(0);
  const [showCrawlStatus, setShowCrawlStatus] = useState<boolean>(false);
  const [isScraping, setIsScraping] = useState<boolean>(false);
  const [currentPage, setCurrentPage] = useState<number>(1);
  const urlsPerPage = 10;

  useEffect(() => {
    let timer: NodeJS.Timeout;
    if (loading) {
      setShowCrawlStatus(true);
      timer = setInterval(() => {
        setElapsedTime((prevTime) => prevTime + 1);
      }, 1000);
    }
    return () => {
      if (timer) clearInterval(timer);
    };
  }, [loading]);

  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    const { name, value, type, checked } = e.target;
    setFormData((prevData) => {
      const newData = {
        ...prevData,
        [name]: type === "checkbox" ? checked : value,
      };

      // Automatically check "Crawl Sub-pages" if limit or search have content
      if (name === "limit" || name === "search") {
        newData.crawlSubPages = !!value || !!newData.limit || !!newData.search;
      }

      return newData;
    });
  };

  const handleNumberKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    handleNumberInputPageKey(e, (name, value) => {
      setFormData((prevData) => {
        const newData = {
          ...prevData,
          [name]: value,
        };

        if (name === "limit") {
          newData.crawlSubPages = !!value || !!newData.search;
        }

        return newData;
      });
    });
  };

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setLoading(true);
    setIsCollapsibleOpen(false);
    setElapsedTime(0);
    setCrawlStatus({ current: 0, total: null });
    setIsScraping(!formData.crawlSubPages);
    setCrawledUrls([]);
    setSelectedUrls([]);
    setScrapeResults({});
    setScrapingSelectedLoading(false);
    setShowCrawlStatus(false);

    try {
      const endpoint = `${FIRECRAWL_API_URL}/v1/${
        formData.crawlSubPages ? "map" : "scrape"
      }`;

      const requestBody: RequestBody = formData.crawlSubPages
        ? {
            url: formData.url,
            search: formData.search || undefined,
            limit: formData.limit ? parseInt(formData.limit) : undefined,
          }
        : {
            url: formData.url,
            formats: ["markdown"],
          };

      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${FIRECRAWL_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      if (formData.crawlSubPages) {
        if (data.success === true && Array.isArray(data.links)) {
          setCrawledUrls(data.links);
          setSelectedUrls(data.links);
          setCrawlStatus({
            current: data.links.length,
            total: data.links.length,
          });

          // Set scrape results with the links
          const linkResults: Record<string, ScrapeResult> = {};
          data.links.forEach((link: string) => {
            linkResults[link] = {
              success: true,
              data: {
                metadata: {
                  sourceURL: link,
                  title: "",
                  description: "",
                  language: "",
                  pageStatusCode: 200,
                },
                markdown: "",
                content: "",
                html: "",
                rawHtml: "",
                llm_extraction: {},
              },
            };
          });
        } else {
          console.error("Unexpected response format from map endpoint");
          console.log(data);
        }
      } else {
        setScrapeResults({ [formData.url]: data });
        setCrawlStatus({ current: 1, total: 1 });
      }
    } catch (error) {
      console.error("Error:", error);
      setScrapeResults({
        error: {
          success: false,
          data: {
            metadata: {
              pageError: "Error occurred while fetching data",
              title: "",
              description: "",
              language: "",
              sourceURL: "",
              pageStatusCode: 0,
            },
            markdown: "",
            content: "",
            html: "",
            rawHtml: "",
            llm_extraction: {},
          },
        },
      });
    } finally {
      setLoading(false);
    }
  };

  const handleScrapeSelected = async () => {
    setLoading(true);
    setElapsedTime(0);
    setCrawlStatus({ current: 0, total: selectedUrls.length });
    setIsScraping(true);
    setScrapingSelectedLoading(true);
    const newScrapeResults: Record<string, ScrapeResult> = {};

    for (const [index, url] of selectedUrls.entries()) {
      try {
        const response = await fetch(`${FIRECRAWL_API_URL}/v1/scrape`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${FIRECRAWL_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            url: url,
            formats: ["markdown"],
          }),
        });

        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data: ScrapeResult = await response.json();
        newScrapeResults[url] = data;
        setCrawlStatus((prev) => ({ ...prev, current: index + 1 }));
        setScrapeResults({ ...scrapeResults, ...newScrapeResults });
      } catch (error) {
        console.error(`Error scraping ${url}:`, error);
        newScrapeResults[url] = {
          success: false,
          data: {
            markdown: "",
            content: "",
            html: "",
            rawHtml: "",
            metadata: {
              title: "",
              description: "",
              language: "",
              sourceURL: url,
              pageStatusCode: 0,
              pageError: (error as Error).message,
            },
            llm_extraction: {},
          },
        };
      }
    }

    setLoading(false);
    setIsScraping(false);
  };

  const handlePageChange = (newPage: number) => {
    setCurrentPage(newPage);
  };

  const paginatedUrls = crawledUrls.slice(
    (currentPage - 1) * urlsPerPage,
    currentPage * urlsPerPage
  );

  return (
    <div className="max-w-2xl mx-auto p-4">
      <Card>
        <CardHeader className="flex items-start justify-between mb-0 pb-4">
          <CardTitle className="flex items-center justify-between w-full space-x-2">
            <span className="text-base">Extract web content (V1)</span>
            <a
              href="https://www.firecrawl.dev"
              className="text-xs text-gray-500 font-normal px-3 py-1 bg-zinc-100 rounded-xl hover:bg-zinc-200 transition-colors"
            >
              Powered by Firecrawl 🔥
            </a>
          </CardTitle>
          <div className="text-sm text-gray-500 w-11/12 items-center">
            Use this component to quickly give your users the ability to connect
            their AI apps to web data with Firecrawl. Learn more on the{" "}
            <a
              href="https://docs.firecrawl.dev/"
              className="text-sm text-blue-500"
            >
              Firecrawl docs!
            </a>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <form onSubmit={handleSubmit}>
            <div className="flex items-center space-x-2">
              <Input
                placeholder="https://www.firecrawl.dev/"
                className="flex-grow"
                name="url"
                value={formData.url}
                onChange={handleChange}
              />
              <Button type="submit" variant="default" disabled={loading}>
                {loading ? (
                  <div
                    role="status"
                    className="flex items-center justify-between space-x-2"
                  >
                    <svg
                      className="animate-spin  h-4 w-4 text-white"
                      xmlns="http://www.w3.org/2000/svg"
                      fill="none"
                      viewBox="0 0 24 24"
                    >
                      <circle
                        className="opacity-25"
                        cx="12"
                        cy="12"
                        r="10"
                        stroke="currentColor"
                        strokeWidth="4"
                      ></circle>
                      <path
                        className="opacity-75"
                        fill="currentColor"
                        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                      ></path>
                    </svg>
                    <span className="sr-only">Loading...</span>
                  </div>
                ) : (
                  "Run"
                )}
              </Button>
            </div>
            <Collapsible
              open={isCollapsibleOpen}
              onOpenChange={setIsCollapsibleOpen}
              className="mt-2"
            >
              <CollapsibleTrigger asChild>
                <Button variant="ghost" className="w-full justify-between pl-2">
                  Advanced Options
                  <ChevronDown className="h-4 w-4 opacity-50" />
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent className="space-y-4 mt-4 px-2">
                <div className="flex items-center space-x-2">
                  <Checkbox
                    id="crawlSubPages"
                    name="crawlSubPages"
                    checked={formData.crawlSubPages}
                    onCheckedChange={(checked: boolean) =>
                      setFormData((prev) => ({
                        ...prev,
                        crawlSubPages: checked,
                      }))
                    }
                  />
                  <label htmlFor="crawlSubPages" className="text-sm">
                    Crawl Sub-pages
                  </label>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label
                      htmlFor="search"
                      className="block text-left w-full pb-2"
                    >
                      Search for specific pages in crawl *
                    </Label>
                    <Input
                      id="search"
                      name="search"
                      placeholder="python sdk"
                      value={formData.search}
                      onChange={handleChange}
                    />
                  </div>
                  <div>
                    <Label
                      htmlFor="limit"
                      className="block text-left w-full pb-2"
                    >
                      Limit *
                    </Label>
                    <Input
                      id="limit"
                      name="limit"
                      type="number"
                      min={0}
                      placeholder="10"
                      value={formData.limit}
                      onChange={handleChange}
                      onKeyDown={handleNumberKeyDown}
                    />
                  </div>
                </div>
              </CollapsibleContent>
            </Collapsible>
          </form>
          {showCrawlStatus && (
            <div className="flex items-center justify-between mb-2 space-x-2 bg-gray-100 p-2 rounded-md">
              <div className="flex items-center space-x-2">
                {!isScraping &&
                  crawledUrls.length > 0 &&
                  !scrapingSelectedLoading && (
                    <>
                      <Checkbox
                        id="selectAll"
                        checked={selectedUrls.length === crawledUrls.length}
                        onCheckedChange={(checked) => {
                          if (checked) {
                            setSelectedUrls([...crawledUrls]);
                          } else {
                            setSelectedUrls([]);
                          }
                        }}
                      />
                      <label
                        htmlFor="selectAll"
                        className="text-sm cursor-pointer"
                      >
                        {selectedUrls.length === crawledUrls.length
                          ? `Unselect All (${selectedUrls.length})`
                          : `Select All (${selectedUrls.length})`}
                      </label>
                    </>
                  )}
              </div>
              <div className="text-sm text-gray-600">
                {isScraping
                  ? `Scraped ${crawlStatus.current} page(s) in ${elapsedTime}s`
                  : `Crawled ${crawlStatus.current} pages in ${elapsedTime}s`}
              </div>
            </div>
          )}

          {crawledUrls.length > 0 &&
            !scrapingSelectedLoading &&
            !isScraping && (
              <>
                <ul className="pl-2">
                  {paginatedUrls.map((url, index) => (
                    <li
                      key={index}
                      className="flex items-center space-x-2 my-2 text-sm"
                    >
                      <Checkbox
                        checked={selectedUrls.includes(url)}
                        onCheckedChange={() =>
                          setSelectedUrls((prev) =>
                            prev.includes(url)
                              ? prev.filter((u) => u !== url)
                              : [...prev, url]
                          )
                        }
                      />
                      <span className="flex items-center max-w-lg">
                        {url.length > 70 ? `${url.slice(0, 70)}...` : url}
                      </span>
                    </li>
                  ))}
                </ul>
                <div className="flex items-center justify-between mt-4">
                  <Button
                    variant="outline"
                    className="px-2"
                    onClick={() => handlePageChange(currentPage - 1)}
                    disabled={currentPage === 1}
                  >
                    <ChevronLeft className="h-5 w-5" />
                  </Button>
                  <span className="text-sm text-gray-500">
                    Page {currentPage} of{" "}
                    {Math.ceil(crawledUrls.length / urlsPerPage)}
                  </span>
                  <Button
                    variant="outline"
                    className="px-2"
                    onClick={() => handlePageChange(currentPage + 1)}
                    disabled={currentPage * urlsPerPage >= crawledUrls.length}
                  >
                    <ChevronRight className="h-5 w-5 " />
                  </Button>
                </div>
              </>
            )}
        </CardContent>
        <CardFooter className="w-full flex justify-center">
          {crawledUrls.length > 0 && !scrapingSelectedLoading && (
            <Button
              variant="default"
              className="w-full"
              onClick={handleScrapeSelected}
              disabled={loading || selectedUrls.length === 0}
            >
              Scrape Selected URLs
            </Button>
          )}
        </CardFooter>
      </Card>

      {Object.keys(scrapeResults).length > 0 && (
        <div className="mt-4">
          <h2 className="text-base font-bold ">Scrape Results</h2>
          <p className="text-sm text-gray-500">
            You can do whatever you want with the scrape results. Here is a
            basic showcase of the markdown.
          </p>
          <div className="flex flex-col gap-4 mt-4 w-full">
            {Object.entries(scrapeResults).map(([url, result]) => (
              <Card key={url} className="relative p-4 w-full">
                <CardTitle className="text-sm font-normal flex flex-col">
                  <span>{result.data.metadata.title}</span>
                  <span className="text-xs text-gray-500">
                    {url
                      .replace(/^(https?:\/\/)?(www\.)?/, "")
                      .replace(/\/$/, "")}
                  </span>
                </CardTitle>
                <CardContent className="relative px-0 pt-2 !text-xs w-full">
                  <div className=" overflow-y-auto h-32 bg-zinc-100 rounded-md p-2 w-full">
                    {result.success ? (
                      <>
                        <pre className="text-xs whitespace-pre-wrap">
                          {result.data.markdown.trim()}
                        </pre>
                      </>
                    ) : (
                      <>
                        <p className="text-red-500">
                          Failed to scrape this URL
                        </p>
                        <p className="text-zinc-500 font-mono">
                          {result.toString()}
                        </p>
                      </>
                    )}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
