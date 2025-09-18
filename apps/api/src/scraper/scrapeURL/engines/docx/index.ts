import { Meta } from "../..";
import { EngineScrapeResult } from "..";
import { downloadFile } from "../utils/downloadFile";
import mammoth from "mammoth";
import { unlink, stat } from "node:fs/promises";
import { EngineError, UnsupportedFileError } from "../../error";

export async function scrapeDOCX(meta: Meta): Promise<EngineScrapeResult> {
  const { response, tempFilePath } = await downloadFile(
    meta.id,
    meta.rewrittenUrl ?? meta.url,
    {
      headers: meta.options.headers,
      signal: meta.abort.asSignal(),
    },
  );

  try {
    // Check if operation should be aborted before processing
    meta.abort.throwIfAborted();
    
    // Validate file exists and get size
    const fileStats = await stat(tempFilePath);
    meta.logger.debug("Processing DOCX file", { 
      tempFilePath, 
      fileSize: fileStats.size,
      contentType: response.headers.get("content-type")
    });
    
    // Check file size (similar to PDF processor)
    const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB limit for DOCX
    if (fileStats.size > MAX_FILE_SIZE) {
      throw new UnsupportedFileError(`DOCX file size exceeds ${MAX_FILE_SIZE / (1024 * 1024)}MB`);
    }
    
    // Validate content type
    const contentType = response.headers.get("content-type");
    if (contentType && !contentType.includes("application/vnd.openxmlformats-officedocument.wordprocessingml.document")) {
      meta.logger.warn("Unexpected content type for DOCX file", { contentType });
    }
    
    // Configure mammoth with proper options for better error handling
    // Add timeout handling for mammoth processing
    const mammothPromise = mammoth.convertToHtml({ 
      path: tempFilePath 
    }, {
      // Include warnings in the result
      includeEmbeddedStyleMap: true,
      includeDefaultStyleMap: true,
      // Convert images to base64 data URLs
      convertImage: mammoth.images.imgElement(function(image) {
        return image.read("base64").then(function(imageBuffer) {
          return {
            src: "data:" + image.contentType + ";base64," + imageBuffer
          };
        });
      })
    });
    
    // Add timeout handling for mammoth processing
    const timeoutMs = meta.abort.scrapeTimeout() ?? 30000; // 30 second default timeout
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("DOCX processing timeout")), timeoutMs);
    });
    
    const result = await Promise.race([mammothPromise, timeoutPromise]) as Awaited<typeof mammothPromise>;
    
    // Log any warnings from mammoth
    if (result.messages && result.messages.length > 0) {
      meta.logger.warn("Mammoth conversion warnings", { 
        warnings: result.messages.map(msg => msg.message) 
      });
    }
    
    return {
      url: response.url,
      statusCode: response.status,
      html: result.value,
      proxyUsed: "basic",
    };
  } catch (error) {
    throw new EngineError("Failed to convert DOCX to HTML", { cause: error });
  } finally {
    // Always clean up the temporary file
    try {
      await unlink(tempFilePath);
      meta.logger.debug("Cleaned up temporary DOCX file", { tempFilePath });
    } catch (cleanupError) {
      meta.logger.warn("Failed to clean up temporary DOCX file", { 
        tempFilePath, 
        error: cleanupError 
      });
    }
  }
}

export function docxMaxReasonableTime(meta: Meta): number {
  return 15000;
}
