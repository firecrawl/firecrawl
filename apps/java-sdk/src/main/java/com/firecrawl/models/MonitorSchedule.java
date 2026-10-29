package com.firecrawl.models;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

@JsonIgnoreProperties(ignoreUnknown = true)
public class MonitorSchedule {
    private String cron;
    private String timezone;

    public String getCron() { return cron; }
    public String getTimezone() { return timezone; }
}
