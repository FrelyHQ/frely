import { isNotFound, isRedirect } from "@tanstack/react-router";

export interface WebPageRequest {
  params: Record<string, string>;
  search: Record<string, string | string[] | undefined>;
}

export function webPageRequest(
  params: Record<string, unknown>,
  search: Record<string, unknown>,
): WebPageRequest {
  const safeParams: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string") safeParams[key] = value;
  }
  const safeSearch: Record<string, string | string[] | undefined> = {};
  for (const [key, value] of Object.entries(search)) {
    if (typeof value === "string") safeSearch[key] = value;
    else if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
      safeSearch[key] = value;
    }
  }
  return { params: safeParams, search: safeSearch };
}

export function validateWebPageInput(data: unknown): WebPageRequest {
  const input = isRecord(data) ? data : {};
  return webPageRequest(
    isRecord(input.params) ? input.params : {},
    isRecord(input.search) ? input.search : {},
  );
}

export function validateWebSearch(search: Record<string, unknown>) {
  return webPageRequest({}, search).search;
}

export async function runWebPageLoader<T>(load: () => Promise<T>): Promise<T> {
  try {
    return await load();
  } catch (error) {
    if (isRedirect(error) || isNotFound(error)) throw error;
    process.stdout.write(`${JSON.stringify({ event: "web.page.failed", code: "internal_server_error" })}\n`);
    throw new Error("internal_server_error");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
