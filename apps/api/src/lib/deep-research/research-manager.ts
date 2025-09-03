import { Logger } from "winston";
import {
  DeepResearchActivity,
  DeepResearchFinding,
  DeepResearchSource,
  updateDeepResearch,
} from "./deep-research-redis";
import {
  generateCompletions,
  trimToTokenLimit,
} from "../../scraper/scrapeURL/transformers/llmExtract";
import { ExtractOptions } from "../../controllers/v1/types";

import { getModel } from "../generic-ai";
import { CostTracking } from "../cost-tracking";
interface AnalysisResult {
  gaps: string[];
  nextSteps: string[];
  shouldContinue: boolean;
  nextSearchTopic?: string;
}

export class ResearchStateManager {
  private findings: DeepResearchFinding[] = [];
  private summaries: string[] = [];
  private nextSearchTopic: string = "";
  private urlToSearch: string = "";
  private currentDepth: number = 0;
  private failedAttempts: number = 0;
  private readonly maxFailedAttempts: number = 3;
  private completedSteps: number = 0;
  private readonly totalExpectedSteps: number;
  private seenUrls: Set<string> = new Set();
  private sources: DeepResearchSource[] = [];
  constructor(
    private readonly researchId: string,
    private readonly teamId: string,
    private readonly maxDepth: number,
    private readonly logger: Logger,
    private readonly topic: string,
  ) {
    this.totalExpectedSteps = maxDepth * 5; // 5 steps per depth level
    this.nextSearchTopic = topic;
  }

  hasSeenUrl(url: string): boolean {
    return this.seenUrls.has(url);
  }

  addSeenUrl(url: string): void {
    this.seenUrls.add(url);
  }

  getSeenUrls(): Set<string> {
    return this.seenUrls;
  }

  async addActivity(activities: DeepResearchActivity[]): Promise<void> {
    if (activities.some(activity => activity.status === "complete")) {
      this.completedSteps++;
    }

    await updateDeepResearch(this.researchId, {
      activities: activities,
      completedSteps: this.completedSteps,
    });
  }

  async addSources(sources: DeepResearchSource[]): Promise<void> {
    await updateDeepResearch(this.researchId, {
      sources: sources,
    });
  }

  async addFindings(findings: DeepResearchFinding[]): Promise<void> {
    // Only keep the most recent 50 findings
    // To avoid memory issues for now
    this.findings = [...this.findings, ...findings].slice(-50);
    await updateDeepResearch(this.researchId, {
      findings: findings,
    });
  }

  async addSummary(summary: string): Promise<void> {
    this.summaries.push(summary);
    await updateDeepResearch(this.researchId, {
      summaries: [summary],
    });
  }

  async incrementDepth(): Promise<void> {
    this.currentDepth++;
    await updateDeepResearch(this.researchId, {
      currentDepth: this.currentDepth,
    });
  }

  incrementFailedAttempts(): void {
    this.failedAttempts++;
  }

  getFindings(): DeepResearchFinding[] {
    return this.findings;
  }

  getSummaries(): string[] {
    return this.summaries;
  }

  getCurrentDepth(): number {
    return this.currentDepth;
  }

  hasReachedMaxDepth(): boolean {
    return this.currentDepth >= this.maxDepth;
  }

  hasReachedMaxFailedAttempts(): boolean {
    return this.failedAttempts >= this.maxFailedAttempts;
  }

  getProgress(): { completedSteps: number; totalSteps: number } {
    return {
      completedSteps: this.completedSteps,
      totalSteps: this.totalExpectedSteps,
    };
  }

  setNextSearchTopic(topic: string): void {
    this.nextSearchTopic = topic;
  }

  getNextSearchTopic(): string {
    return this.nextSearchTopic;
  }

  setUrlToSearch(url: string): void {
    this.urlToSearch = url;
  }

  getUrlToSearch(): string {
    return this.urlToSearch;
  }

  getSources(): DeepResearchSource[] {
    return this.sources;
  }
}

export class ResearchLLMService {
  constructor(private readonly logger: Logger) {}

  async generateSearchQueries(
    topic: string,
    findings: DeepResearchFinding[] = [],
    costTracking: CostTracking,
    metadata: { teamId: string; functionId?: string; deepResearchId?: string },
  ): Promise<{ query: string; researchGoal: string }[]> {
    const { extract } = await generateCompletions({
      logger: this.logger.child({
        method: "generateSearchQueries",
      }),
      options: {
        systemPrompt:
          "You are an expert research agent that generates search queries (SERP) to explore topics deeply and thoroughly. Do not generate repeated queries. Today's date is " +
          new Date().toISOString().split("T")[0],
        schema: {
          type: "object",
          properties: {
            queries: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  query: {
                    type: "string",
                    description: "The search query to use",
                  },
                  researchGoal: {
                    type: "string",
                    description:
                      "The specific goal this query aims to achieve and how it advances the research",
                  },
                },
              },
            },
          },
        },
        prompt: `Generate a list of 3-5 search queries to deeply research this topic: "${topic}"
          ${findings.length > 0 ? `\nBased on these previous findings, generate more specific queries:\n${trimToTokenLimit(findings.map(f => `- ${f.text}`).join("\n"), 10000).text}` : ""}
          
          Each query should be specific and focused on a particular aspect.
          Build upon previous findings when available.
          Be specific and go deep, not wide - always following the original topic.
          Every search query is a new SERP query so make sure the whole context is added without overwhelming the search engine.
          The first SERP query you generate should be a very concise, simple version of the topic. `,
      },
      markdown: "",
      costTrackingOptions: {
        costTracking,
        metadata: {
          module: "deep-research",
          method: "generateSearchQueries",
        },
      },
      metadata: {
        ...metadata,
        functionId: metadata.functionId
          ? metadata.functionId + "/generateSearchQueries"
          : "generateSearchQueries",
      },
    });

    return extract.queries;
  }

  async analyzeAndPlan(
    findings: DeepResearchFinding[],
    currentTopic: string,
    timeRemaining: number,
    systemPrompt: string,
    costTracking: CostTracking,
    metadata: { teamId: string; functionId?: string; deepResearchId?: string },
  ): Promise<AnalysisResult | null> {
    try {
      const timeRemainingMinutes =
        Math.round((timeRemaining / 1000 / 60) * 10) / 10;

      const { extract } = await generateCompletions({
        logger: this.logger.child({
          method: "analyzeAndPlan",
        }),
        options: {
          systemPrompt:
            systemPrompt +
            "You are an expert research agent that is analyzing findings. Your goal is to synthesize information and identify gaps for further research. Today's date is " +
            new Date().toISOString().split("T")[0],
          schema: {
            type: "object",
            properties: {
              analysis: {
                type: "object",
                properties: {
                  gaps: { type: "array", items: { type: "string" } },
                  nextSteps: { type: "array", items: { type: "string" } },
                  shouldContinue: { type: "boolean" },
                  nextSearchTopic: { type: "string" },
                },
                required: ["gaps", "nextSteps", "shouldContinue"],
              },
            },
          },
          prompt: trimToTokenLimit(
            `You are researching: ${currentTopic}
              You have ${timeRemainingMinutes} minutes remaining to complete the research but you don't need to use all of it.
              Current findings: ${findings.map(f => `[From ${f.source}]: ${f.text}`).join("\n")}
              What has been learned? What gaps remain, if any? What specific aspects should be investigated next if any?
              If you need to search for more information inside the same topic pick a sub-topic by including a nextSearchTopic -which should be highly related to the original topic/users'query.
              Important: If less than 1 minute remains, set shouldContinue to false to allow time for final synthesis.
              If I have enough information, set shouldContinue to false.`,
            120000,
          ).text,
        },
        markdown: "",
        costTrackingOptions: {
          costTracking,
          metadata: {
            module: "deep-research",
            method: "analyzeAndPlan",
          },
        },
        metadata: {
          ...metadata,
          functionId: metadata.functionId
            ? metadata.functionId + "/analyzeAndPlan"
            : "analyzeAndPlan",
        },
      });

      return extract.analysis;
    } catch (error) {
      this.logger.error("Analysis error", { error });
      return null;
    }
  }

  async generateFinalAnalysis(
    topic: string,
    findings: DeepResearchFinding[],
    summaries: string[],
    analysisPrompt: string,
    costTracking: CostTracking,
    metadata: { teamId: string; functionId?: string; deepResearchId?: string },
    formats?: string[],
    jsonOptions?: ExtractOptions,
  ): Promise<any> {
    if (!formats) {
      formats = ["markdown"];
    }
    if (!jsonOptions) {
      jsonOptions = undefined;
    }

    const { extract } = await generateCompletions({
      logger: this.logger.child({
        method: "generateFinalAnalysis",
      }),
      mode: formats.includes("json") ? "object" : "no-object",
      options: {
        mode: "llm",
        ...(formats.includes("json") && {
          ...jsonOptions,
        }),
        systemPrompt: formats.includes("json")
          ? "You are an expert research analyst who creates comprehensive, structured analysis following the provided JSON schema exactly."
          : "You are an expert research analyst who creates comprehensive, well-structured reports.  Don't begin the report by saying 'Here is the report', nor 'Below is the report', nor something similar. ALWAYS start with a great title that reflects the research topic and findings. Your reports are detailed, properly formatted in Markdown, and include clear sections with citations. Today's date is " +
            new Date().toISOString().split("T")[0],
        prompt: trimToTokenLimit(
          analysisPrompt
            ? `${analysisPrompt}\n\nResearch data:\n${findings.map(f => `[From ${f.source}]: ${f.text}`).join("\n")}`
            : formats.includes("json")
              ? `Analyze the following research data on "${topic}" and structure the output according to the provided schema: Schema: ${JSON.stringify(jsonOptions?.schema)}\n\nFindings:\n\n${findings.map(f => `[From ${f.source}]: ${f.text}`).join("\n")}`
              : `Create a comprehensive research report on "${topic}" based on the collected findings and analysis.
  
                Research data:
                ${findings.map(f => `[From ${f.source}]: ${f.text}`).join("\n")}
    
                Requirements:
                - Format the report in Markdown with proper headers and sections
                - Include specific citations to sources where appropriate
                - Provide detailed analysis in each section
                - Make it comprehensive and thorough (aim for 4+ pages worth of content)
                - Include all relevant findings and insights from the research
                - Cite sources
                - Cite sources throughout the report
                - Use bullet points and lists where appropriate for readability
                - Don't begin the report by saying "Here is the report", nor "Below is the report", nor something similar.
                - ALWAYS Start with a great title that reflects the research topic and findings - concise and to the point. That's the first thing you should output.
                
                Begin!`,
          100000,
        ).text,
      },
      markdown: "",
      model: getModel("o3-mini"),
      costTrackingOptions: {
        costTracking,
        metadata: {
          module: "deep-research",
          method: "generateFinalAnalysis",
        },
      },
      metadata: {
        ...metadata,
        functionId: metadata.functionId
          ? metadata.functionId + "/generateFinalAnalysis"
          : "generateFinalAnalysis",
      },
    });

    return extract;
  }
}
