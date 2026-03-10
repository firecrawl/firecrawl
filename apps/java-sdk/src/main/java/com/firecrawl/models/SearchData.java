package com.firecrawl.models;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import java.util.List;
import java.util.Map;

/**
 * Search results from the v2 search API.
 * The API returns an object with web, news, and images arrays.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public class SearchData {

    private List<Map<String, Object>> web;
    private List<Map<String, Object>> news;
    private List<Map<String, Object>> images;

    /** Web search results. */
    public List<Map<String, Object>> getWeb() { return web; }
    public void setWeb(List<Map<String, Object>> web) { this.web = web; }

    /** News search results. */
    public List<Map<String, Object>> getNews() { return news; }
    public void setNews(List<Map<String, Object>> news) { this.news = news; }

    /** Image search results. */
    public List<Map<String, Object>> getImages() { return images; }
    public void setImages(List<Map<String, Object>> images) { this.images = images; }

    @Override
    public String toString() {
        int webCount = web != null ? web.size() : 0;
        int newsCount = news != null ? news.size() : 0;
        int imageCount = images != null ? images.size() : 0;
        return "SearchData{web=" + webCount + ", news=" + newsCount + ", images=" + imageCount + "}";
    }
}
