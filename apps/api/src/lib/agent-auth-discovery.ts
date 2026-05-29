import { Response } from "express";
import { config } from "../config";
import { isSelfHosted } from "./deployment";

export function getAgentAuthResourceMetadataUrl(): string {
  return config.AGENT_AUTH_RESOURCE_METADATA_URL;
}

export function shouldEmitAgentAuthDiscoveryHeader(): boolean {
  return !isSelfHosted();
}

export function applyAgentAuthDiscoveryHeader(res: Response): void {
  if (!shouldEmitAgentAuthDiscoveryHeader()) return;
  const url = getAgentAuthResourceMetadataUrl();
  res.setHeader("WWW-Authenticate", `Bearer resource_metadata="${url}"`);
}
