import { Document } from "../controllers/v2/types";
import { SearchV2Response } from "../lib/entities";

export function transformToV1Response(
  searchResponse: SearchV2Response,
): Document[] {
  const documents: Document[] = [];

  if (searchResponse.web && searchResponse.web.length > 0) {
    for (const item of searchResponse.web) {
      documents.push({
        ...item,
        url: item.url,
        title: item.title,
        description: item.description,
      } as Document);
    }
  }

  if (searchResponse.news && searchResponse.news.length > 0) {
    for (const item of searchResponse.news) {
      if (item.url) {
        documents.push({
          ...item,
          url: item.url,
          title: item.title || "",
          description: item.snippet || "",
        } as Document);
      }
    }
  }

  if (searchResponse.images && searchResponse.images.length > 0) {
    for (const item of searchResponse.images) {
      if (item.url) {
        documents.push({
          ...item,
          url: item.url,
          title: item.title || "",
          description: "",
        } as Document);
      }
    }
  }

  return documents;
}

export function filterDocumentsWithContent(documents: Document[]): Document[] {
  return documents.filter(
    doc => doc.serpResults || (doc.markdown && doc.markdown.trim().length > 0),
  );
}
