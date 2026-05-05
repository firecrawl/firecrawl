package com.firecrawl.models;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import java.util.List;

@JsonIgnoreProperties(ignoreUnknown = true)
public class MonitorCheckDetail extends MonitorCheck {
    private List<MonitorCheckPage> pages;
    private String next;

    public List<MonitorCheckPage> getPages() { return pages; }
    public void setPages(List<MonitorCheckPage> pages) { this.pages = pages; }
    public String getNext() { return next; }
    public void setNext(String next) { this.next = next; }
}
