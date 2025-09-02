import { logger } from "../../../lib/logger";
import { areMergeable } from "./merge-null-val-objs";
import { transformArrayToObject } from "./transform-array-to-obj";

interface TransformedResult {
  transformed: { [key: string]: any[] } | any[];
  url: string;
}

/**
 * Tracks sources through the transformation, deduplication, and merging process
 */
export class SourceTracker {
  private transformedResults: TransformedResult[];
  private preDedupeSourceMap: Map<string, string[]>;

  constructor() {
    this.transformedResults = [];
    this.preDedupeSourceMap = new Map();
  }

  /**
   * Transform raw extraction results into a format that preserves source information
   */
  transformResults(
    extractionResults: { extract: any; url: string }[],
    schema: any,
    withTransform: boolean = true,
  ) {
    // Handle array outputs
    if (Array.isArray(extractionResults[0]?.extract)) {
      this.transformedResults = extractionResults.map(result => ({
        transformed: result.extract,
        url: result.url,
      }));

      if (withTransform) {
        // Combine all extracts to match original behavior
        const combinedExtracts = extractionResults.map(r => r.extract).flat();
        return combinedExtracts;
      }
      return this.transformedResults;
    }

    // Handle object outputs (original behavior)
    this.transformedResults = extractionResults.map(result => ({
      transformed: transformArrayToObject(schema, [result.extract]),
      url: result.url,
    }));

    if (withTransform) {
      // Then combine all extracts and transform them together to match original behavior
      const combinedExtracts = extractionResults.map(r => r.extract);
      return transformArrayToObject(schema, combinedExtracts);
    }
    return this.transformedResults;
  }

  /**
   * Track sources for each item before deduplication
   */
  trackPreDeduplicationSources(
    multiEntityResult: { [key: string]: any[] } | any[],
  ) {
    try {
      if (Array.isArray(multiEntityResult)) {
        // Handle array outputs
        multiEntityResult.forEach((item: any) => {
          const itemKey = JSON.stringify(item);
          const matchingSources = this.transformedResults
            .filter(
              result =>
                Array.isArray(result.transformed) &&
                result.transformed.some(
                  (resultItem: any) => JSON.stringify(resultItem) === itemKey,
                ),
            )
            .map(result => result.url);
          this.preDedupeSourceMap.set(itemKey, matchingSources);
        });
      } else {
        // Handle object outputs (original behavior)
        Object.keys(multiEntityResult).forEach(key => {
          multiEntityResult[key].forEach((item: any) => {
            const itemKey = JSON.stringify(item);
            const matchingSources = this.transformedResults
              .filter(result =>
                result.transformed[key]?.some(
                  (resultItem: any) => JSON.stringify(resultItem) === itemKey,
                ),
              )
              .map(result => result.url);
            this.preDedupeSourceMap.set(itemKey, matchingSources);
          });
        });
      }
    } catch (error) {
      logger.error(`Failed to track pre-deduplication sources`, { error });
    }
  }

  /**
   * Map sources to final deduplicated/merged items
   */
  mapSourcesToFinalItems(
    multiEntityResult: { [key: string]: any[] } | any[],
    multiEntityKeys: string[],
  ): Record<string, string[]> {
    try {
      const sources: Record<string, string[]> = {};

      if (Array.isArray(multiEntityResult)) {
        // Handle array outputs
        multiEntityResult.forEach((item: any, finalIndex: number) => {
          const sourceKey = `[${finalIndex}]`;
          const itemSources = new Set<string>();

          this.transformedResults.forEach(result => {
            if (Array.isArray(result.transformed)) {
              result.transformed.forEach((originalItem: any) => {
                if (areMergeable(item, originalItem)) {
                  itemSources.add(result.url);
                }
              });
            }
          });

          sources[sourceKey] = Array.from(itemSources);
        });
      } else {
        // Handle object outputs (original behavior)
        multiEntityKeys.forEach(key => {
          if (multiEntityResult[key] && Array.isArray(multiEntityResult[key])) {
            multiEntityResult[key].forEach((item: any, finalIndex: number) => {
              const sourceKey = `${key}[${finalIndex}]`;
              const itemSources = new Set<string>();

              this.transformedResults.forEach(result => {
                result.transformed[key]?.forEach((originalItem: any) => {
                  if (areMergeable(item, originalItem)) {
                    itemSources.add(result.url);
                  }
                });
              });

              sources[sourceKey] = Array.from(itemSources);
            });
          }
        });
      }

      return sources;
    } catch (error) {
      logger.error(`Failed to map sources to final items`, { error });
      return {};
    }
  }
}
