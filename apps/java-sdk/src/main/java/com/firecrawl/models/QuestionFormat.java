package com.firecrawl.models;

import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * Question format for asking a question about page content.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public class QuestionFormat {

    private final String type = "question";
    private String question;

    private QuestionFormat() {}

    public String getType() { return type; }
    public String getQuestion() { return question; }

    public static Builder builder() { return new Builder(); }

    public static final class Builder {
        private String question;

        private Builder() {}

        /** Question to answer from the page content. */
        public Builder question(String question) { this.question = question; return this; }

        public QuestionFormat build() {
            QuestionFormat f = new QuestionFormat();
            f.question = this.question;
            return f;
        }
    }
}
