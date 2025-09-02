import { Document } from "../../../controllers/v1/types";
import { supabase_service } from "../../../services/supabase";
import { normalizeUrl } from "../../../lib/canonical-url";

export async function getCachedDocs(
  urls: string[],
  cacheKey: string,
): Promise<Document[]> {
  const normalizedUrls = urls.map(normalizeUrl);
  const { data, error } = await supabase_service
    .from("cached_scrapes")
    .select("doc")
    .in("url", normalizedUrls)
    .eq("cache_key", cacheKey);

  if (error) {
    console.error("Error fetching cached docs:", error);
    return [];
  }

  const uniqueDocs = new Map<string, Document>();
  data.forEach((res: any) => {
    const doc = JSON.parse(JSON.stringify(res.doc)) as Document;
    const docKey = `${doc.metadata.url}-${cacheKey}`;
    if (!uniqueDocs.has(docKey)) {
      uniqueDocs.set(docKey, doc);
    }
  });

  return Array.from(uniqueDocs.values());
}

export async function saveCachedDocs(
  docs: Document[],
  cacheKey: string,
): Promise<void> {
  for (const doc of docs) {
    if (!doc.metadata.url) {
      throw new Error("Document has no URL");
    }

    const normalizedUrl = normalizeUrl(doc.metadata.url);
    const { data, error } = await supabase_service
      .from("cached_scrapes")
      .select("url")
      .eq("url", normalizedUrl)
      .eq("cache_key", cacheKey);

    if (error) {
      console.error("Error checking existing cached doc:", error);
      continue;
    }

    if (data.length === 0) {
      const { error: upsertError } = await supabase_service
        .from("cached_scrapes")
        .upsert({
          url: normalizedUrl,
          doc: doc,
          cache_key: cacheKey,
        });

      if (upsertError) {
        console.error("Error saving cached doc:", upsertError);
      }
    }
  }
}
