interface ComparisonResult {
  overall: {
    rustLen: number;
    muLen: number;
    lenRatio: number;
    rustNumberCount: number;
    muNumberCount: number;
    numberPreservationRatio: number;
    rustTableCount: number;
    muTableCount: number;
    overallMatch: "good" | "acceptable" | "poor";
  };
}

/** Extract all numbers (integers and decimals) from text as a Set of strings. */
export function extractNumbers(text: string): Set<string> {
  const matches = text.match(/\d+(?:\.\d+)?/g);
  return new Set(matches ?? []);
}

/** Count markdown tables by matching full header-separator rows. */
export function countTables(md: string): number {
  const matches = md.match(/^\s*(?:\|\s*:?-+:?\s*)+\|\s*$/gm);
  return matches?.length ?? 0;
}

export function comparePdfOutputs(
  rustMd: string,
  muMd: string,
): ComparisonResult {
  const rustLen = rustMd.length;
  const muLen = muMd.length;
  const lenRatio = muLen > 0 ? rustLen / muLen : rustLen > 0 ? 0 : 1;

  const rustNumbers = extractNumbers(rustMd);
  const muNumbers = extractNumbers(muMd);
  const rustNumberCount = rustNumbers.size;
  const muNumberCount = muNumbers.size;

  let numberPreservationRatio: number;
  if (muNumberCount === 0) {
    numberPreservationRatio = rustNumberCount === 0 ? 1 : 0;
  } else {
    let preserved = 0;
    for (const n of muNumbers) {
      if (rustNumbers.has(n)) preserved++;
    }
    numberPreservationRatio = preserved / muNumberCount;
  }

  const rustTableCount = countTables(rustMd);
  const muTableCount = countTables(muMd);

  let overallMatch: "good" | "acceptable" | "poor";
  if (lenRatio >= 0.8 && numberPreservationRatio >= 0.9) {
    overallMatch = "good";
  } else if (lenRatio >= 0.5 && numberPreservationRatio >= 0.7) {
    overallMatch = "acceptable";
  } else {
    overallMatch = "poor";
  }

  return {
    overall: {
      rustLen,
      muLen,
      lenRatio: Math.round(lenRatio * 1000) / 1000,
      rustNumberCount,
      muNumberCount,
      numberPreservationRatio:
        Math.round(numberPreservationRatio * 1000) / 1000,
      rustTableCount,
      muTableCount,
      overallMatch,
    },
  };
}
