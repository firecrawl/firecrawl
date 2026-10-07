package com.firecrawl.models;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.List;
import java.util.Objects;

/**
 * Exchange (Alexandria data provider) settings for an agent run. Every field is
 * optional and forwarded as-is; the server owns the defaults and limits.
 *
 * <p>Usage:
 * <pre>{@code
 * AgentExchangeOptions exchange = AgentExchangeOptions.builder()
 *     .enabled(true)
 *     .toolkits(List.of("provider-slug"))
 *     .build();
 * }</pre>
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public class AgentExchangeOptions {

    private Boolean enabled;
    private List<String> toolkits;
    private Integer maxCalls;
    private Boolean requireApproval;
    private Approve approve;
    private Decline decline;
    private String onTermsRequired;

    private AgentExchangeOptions() {}

    public Boolean getEnabled() { return enabled; }
    public List<String> getToolkits() { return toolkits; }
    public Integer getMaxCalls() { return maxCalls; }
    public Boolean getRequireApproval() { return requireApproval; }
    public Approve getApprove() { return approve; }
    public Decline getDecline() { return decline; }
    public String getOnTermsRequired() { return onTermsRequired; }

    public static Builder builder() { return new Builder(); }

    /** Accepts the previous turn's pending approval. */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public static final class Approve {
        private final String approvalId;
        private final List<String> callIds;
        private final Boolean always;

        public Approve(String approvalId) { this(approvalId, null, null); }

        /**
         * @param callIds the calls to run; null runs all of them. Ignored on a terms approval.
         * @param always  stop asking for approval for the rest of the thread. Ignored on a terms approval.
         */
        public Approve(String approvalId, List<String> callIds, Boolean always) {
            this.approvalId = Objects.requireNonNull(approvalId, "approvalId");
            this.callIds = callIds;
            this.always = always;
        }

        public String getApprovalId() { return approvalId; }
        public List<String> getCallIds() { return callIds; }
        public Boolean getAlways() { return always; }
    }

    /** Refuses the previous turn's pending approval. */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public static final class Decline {
        private final String approvalId;

        public Decline(String approvalId) { this.approvalId = Objects.requireNonNull(approvalId, "approvalId"); }

        public String getApprovalId() { return approvalId; }
    }

    public static final class Builder {
        private Boolean enabled;
        private List<String> toolkits;
        private Integer maxCalls;
        private Boolean requireApproval;
        private Approve approve;
        private Decline decline;
        private String onTermsRequired;

        private Builder() {}

        /** Use Exchange providers on this run. The server defaults it to true once exchange is set. */
        public Builder enabled(Boolean enabled) { this.enabled = enabled; return this; }
        /** Provider slugs to use, at most 5. Empty or omitted allows every provider the team can use. */
        public Builder toolkits(List<String> toolkits) { this.toolkits = toolkits; return this; }
        /** Maximum provider calls per turn. */
        public Builder maxCalls(Integer maxCalls) { this.maxCalls = maxCalls; return this; }
        /** End the turn with a pending approval before a paid provider call. Needs mode "chat". */
        public Builder requireApproval(Boolean requireApproval) { this.requireApproval = requireApproval; return this; }
        /** Accept the previous turn's pending approval. Needs threadId. */
        public Builder approve(Approve approve) { this.approve = approve; return this; }
        /** Refuse the previous turn's pending approval. Needs threadId. */
        public Builder decline(Decline decline) { this.decline = decline; return this; }
        /** When a provider needs terms the team has not accepted: "skip" (server default) or "ask". */
        public Builder onTermsRequired(String onTermsRequired) { this.onTermsRequired = onTermsRequired; return this; }

        public AgentExchangeOptions build() {
            AgentExchangeOptions o = new AgentExchangeOptions();
            o.enabled = this.enabled;
            o.toolkits = this.toolkits;
            o.maxCalls = this.maxCalls;
            o.requireApproval = this.requireApproval;
            o.approve = this.approve;
            o.decline = this.decline;
            o.onTermsRequired = this.onTermsRequired;
            return o;
        }
    }
}
