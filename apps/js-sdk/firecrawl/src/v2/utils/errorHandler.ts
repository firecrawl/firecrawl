import { type AxiosError, type AxiosResponse } from "axios";
import { SdkError } from "../types";

export function throwForBadResponse(resp: AxiosResponse, action: string): never {
  const status = resp.status;
  const body = resp.data || {};
  const msg = body?.error || body?.message || `Request failed (${status}) while trying to ${action}`;
  throw new SdkError(msg, status, undefined, body?.details);
}

export function normalizeAxiosError(err: AxiosError, action: string): never {
  const status = err.response?.status;
  const body: any = err.response?.data;
  const message = body?.error || err.message || `Request failed${status ? ` (${status})` : ""} while trying to ${action}`;
  const code = (body?.code as string) || err.code;
  throw new SdkError(message, status, code, body?.details ?? body);
}

