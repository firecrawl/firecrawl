package com.firecrawl.models;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

/**
 * Response from executing code in a browser session.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public class BrowserExecuteResponse {

    private boolean success;
    private String stdout;
    private String result;
    private String stderr;
    private Integer exitCode;
    private Boolean killed;
    private String error;

    public boolean isSuccess() { return success; }
    public String getStdout() { return stdout; }
    public String getResult() { return result; }
    public String getStderr() { return stderr; }
    public Integer getExitCode() { return exitCode; }
    public Boolean getKilled() { return killed; }
    public String getError() { return error; }

    @Override
    public String toString() {
        return "BrowserExecuteResponse{success=" + success + ", exitCode=" + exitCode + "}";
    }
}
