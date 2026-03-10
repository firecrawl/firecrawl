package com.firecrawl.models;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

/**
 * Current credit usage information.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public class CreditUsage {

    private int remainingCredits;
    private Integer planCredits;
    private String billingPeriodStart;
    private String billingPeriodEnd;

    public int getRemainingCredits() { return remainingCredits; }
    public Integer getPlanCredits() { return planCredits; }
    public String getBillingPeriodStart() { return billingPeriodStart; }
    public String getBillingPeriodEnd() { return billingPeriodEnd; }

    @Override
    public String toString() {
        return "CreditUsage{remaining=" + remainingCredits + ", plan=" + planCredits + "}";
    }
}
