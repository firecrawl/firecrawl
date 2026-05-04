package com.firecrawl.models;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import java.util.List;

@JsonIgnoreProperties(ignoreUnknown = true)
public class MonitorCheckDetail extends MonitorCheck {
    private List<MonitorCheckPage> pages;
    private int pageLimit;
    private int pageOffset;

    public List<MonitorCheckPage> getPages() { return pages; }
    public int getPageLimit() { return pageLimit; }
    public int getPageOffset() { return pageOffset; }
}
