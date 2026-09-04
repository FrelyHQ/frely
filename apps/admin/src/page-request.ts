import { isNotFound, isRedirect } from "@tanstack/react-router";

export interface AdminPageRequest {
  params: Record<string, string>;
  search: Record<string, string | string[] | undefined>;
}

export function adminPageRequest(
  params: Record<string, unknown>,
  search: Record<string, unknown>,
): AdminPageRequest {
  const safeParams: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string") safeParams[key] = value;
  }
  const safeSearch: Record<string, string | string[] | undefined> = {};
  for (const [key, value] of Object.entries(search)) {
    if (typeof value === "string") safeSearch[key] = value;
    else if (Array.isArray(value) && value.every((item) => typeof item === "string")) safeSearch[key] = value;
  }
  return { params: safeParams, search: safeSearch };
}

export function validateAdminPageInput(data: unknown): AdminPageRequest {
  const input = isRecord(data) ? data : {};
  return adminPageRequest(
    isRecord(input.params) ? input.params : {},
    isRecord(input.search) ? input.search : {},
  );
}

export function validateAdminSearch(search: Record<string, unknown>) {
  return adminPageRequest({}, search).search;
}

export async function runAdminPageLoader<T>(load: () => Promise<T>): Promise<T> {
  try {
    return await load();
  } catch (error) {
    if (isRedirect(error) || isNotFound(error)) throw error;
    process.stdout.write(`${JSON.stringify({ event: "admin.page.failed", code: "internal_server_error" })}\n`);
    throw new Error("internal_server_error");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
