import { Response } from "express";
import {
  applyAgentAuthDiscoveryHeader,
  getAgentAuthResourceMetadataUrl,
  shouldEmitAgentAuthDiscoveryHeader,
} from "./agent-auth-discovery";
import { config } from "../config";

const CANONICAL_PRM_URL =
  "https://www.firecrawl.dev/.well-known/oauth-protected-resource";

describe("agent-auth-discovery", () => {
  it("defaults AGENT_AUTH_RESOURCE_METADATA_URL to canonical PRM", () => {
    expect(config.AGENT_AUTH_RESOURCE_METADATA_URL).toBe(CANONICAL_PRM_URL);
    expect(getAgentAuthResourceMetadataUrl()).toBe(CANONICAL_PRM_URL);
  });

  it("sets WWW-Authenticate when cloud auth is enabled", () => {
    const previous = config.USE_DB_AUTHENTICATION;
    config.USE_DB_AUTHENTICATION = true;

    const headers: Record<string, string> = {};
    const res = {
      setHeader(name: string, value: string) {
        headers[name] = value;
      },
    } as unknown as Response;

    try {
      applyAgentAuthDiscoveryHeader(res);
      expect(headers["WWW-Authenticate"]).toBe(
        `Bearer resource_metadata="${CANONICAL_PRM_URL}"`,
      );
      expect(shouldEmitAgentAuthDiscoveryHeader()).toBe(true);
    } finally {
      config.USE_DB_AUTHENTICATION = previous;
    }
  });

  it("skips WWW-Authenticate on self-hosted", () => {
    const previous = config.USE_DB_AUTHENTICATION;
    config.USE_DB_AUTHENTICATION = false;

    const headers: Record<string, string> = {};
    const res = {
      setHeader(name: string, value: string) {
        headers[name] = value;
      },
    } as unknown as Response;

    try {
      applyAgentAuthDiscoveryHeader(res);
      expect(headers["WWW-Authenticate"]).toBeUndefined();
      expect(shouldEmitAgentAuthDiscoveryHeader()).toBe(false);
    } finally {
      config.USE_DB_AUTHENTICATION = previous;
    }
  });
});
