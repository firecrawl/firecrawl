import type { TeamFlags } from "../controllers/v2/types";
import { isUsOnly } from "./us-only";

/** Whether the team's PDF and image parsing must run on reserved processing capacity. Any value but `true` reads as unrestricted. */
export function isReservedCapacity(flags: TeamFlags | undefined): boolean {
  return flags?.reservedCapacity === true;
}

/**
 * Whether the team's PDF and image parsing carries a restriction the PDF
 * service must honor and confirm (US-only or reserved capacity). Such work
 * runs only on the PDF service: no other parsing engine, and no background
 * work the service would run without the restriction.
 */
export function isProcessingRestricted(flags: TeamFlags | undefined): boolean {
  return isUsOnly(flags) || isReservedCapacity(flags);
}
