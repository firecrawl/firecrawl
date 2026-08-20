package com.firecrawl.models;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

/**
 * Layout and OCR confidence scores for a PDF layout block.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public class PdfBlockConfidence {

    private Double layout;
    private Double ocr;

    public Double getLayout() { return layout; }
    public Double getOcr() { return ocr; }

    @Override
    public String toString() {
        return "PdfBlockConfidence{layout=" + layout + ", ocr=" + ocr + "}";
    }
}
