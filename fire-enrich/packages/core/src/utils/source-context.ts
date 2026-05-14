export interface SourceContext {
  url: string;
  snippet: string;
  confidence: number;
}

export function findRelevantSnippet(
  content: string,
  value: string | number | boolean | string[],
  fieldName: string,
  contextWindow: number = 200
): string {
  if (typeof value === 'boolean' || !content || !value || Array.isArray(value)) {
    return '';
  }
  
  const searchValue = String(value).toLowerCase();
  const contentLower = content.toLowerCase();
  
  // For numeric values, be more strict
  let index = -1;
  
  if (typeof value === 'number') {
    // For numbers, look for exact matches with word boundaries
    const numberPatterns = [
      searchValue, // exact number
      searchValue.replace(/000$/g, 'k'), // 1000 -> 1k
      searchValue.replace(/000000$/g, 'm'), // 1000000 -> 1m
      Number(value).toLocaleString(), // 1000 -> 1,000
    ];
    
    for (const pattern of numberPatterns) {
      // Use regex to ensure we're not matching part of a larger number
      const regex = new RegExp(`\\b${pattern}\\b`, 'i');
      const match = content.match(regex);
      if (match && match.index !== undefined) {
        index = match.index;
        break;
      }
    }
  } else {
    // For strings, try exact match first
    index = contentLower.indexOf(searchValue);
    
    // If no exact match, try to find partial matches for longer values
    if (index === -1 && searchValue.length > 20) {
      const words = searchValue.split(/\s+/).filter(w => w.length > 3);
      for (const word of words) {
        const wordIndex = contentLower.indexOf(word);
        if (wordIndex !== -1) {
          index = wordIndex;
          break;
        }
      }
    }
  }
  
  // Don't fall back to field name search - only return snippets that contain the actual value
  if (index === -1) {
    return '';
  }
  
  // Extract snippet with context
  const start = Math.max(0, index - contextWindow);
  const end = Math.min(content.length, index + searchValue.length + contextWindow);
  
  let snippet = content.substring(start, end);
  
  // Add ellipsis if truncated
  if (start > 0) snippet = '...' + snippet;
  if (end < content.length) snippet = snippet + '...';
  
  // Clean up whitespace
  snippet = snippet.replace(/\s+/g, ' ').trim();
  
  return snippet;
}

export function highlightValue(snippet: string, value: string): string {
  if (!snippet || !value) return snippet;
  
  const escapedValue = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`(${escapedValue})`, 'gi');
  
  return snippet.replace(regex, '**$1**');
}

export function validateSnippetContainsValue(
  snippet: string,
  value: string | number | boolean | string[] | null | undefined
): boolean {
  if (!snippet || value === null || value === undefined) {
    return false;
  }
  
  const snippetLower = snippet.toLowerCase();
  
  // Handle arrays
  if (Array.isArray(value)) {
    // For arrays, at least one element should be in the snippet
    return value.some(item => {
      const itemStr = String(item).toLowerCase();
      return itemStr.length > 2 && snippetLower.includes(itemStr);
    });
  }
  
  // Handle booleans
  if (typeof value === 'boolean') {
    return snippetLower.includes(value.toString());
  }
  
  // Handle numbers
  if (typeof value === 'number') {
    // Check for exact number
    if (snippetLower.includes(value.toString())) {
      return true;
    }
    
    // Check for formatted variations
    const variations = [
      value.toString(),
      value.toLocaleString(), // 1000 -> 1,000
      value >= 1000 ? (value / 1000).toString() + 'k' : '', // 1000 -> 1k
      value >= 1000000 ? (value / 1000000).toString() + 'm' : '', // 1000000 -> 1m
    ].filter(Boolean);
    
    return variations.some(variant => {
      const regex = new RegExp(`\\b${variant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
      return regex.test(snippet);
    });
  }
  
  // Handle strings
  const valueStr = String(value).toLowerCase();
  
  // Skip very short values to avoid false positives
  if (valueStr.length < 3) {
    return snippetLower.includes(valueStr);
  }
  
  // For longer strings, check if significant parts are present
  if (valueStr.length > 20) {
    // Extract key words (longer than 3 chars)
    const words = valueStr.split(/\s+/).filter(w => w.length > 3);
    // Require at least 50% of key words to be present
    const matchCount = words.filter(word => snippetLower.includes(word)).length;
    return matchCount >= Math.ceil(words.length * 0.5);
  }
  
  // For medium strings, require the full value
  return snippetLower.includes(valueStr);
}