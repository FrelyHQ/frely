import { ConsoleApiError, readConsoleApiResponse } from "@frely/console-ui/api-error";
import type { PasswordChangeInput, PasswordChangeResult } from "@frely/console-ui/password-change";

export async function changeWebPassword(input: PasswordChangeInput): Promise<PasswordChangeResult> {
  return changePassword("/api/user/security/password", input);
}

async function changePassword(url: string, input: PasswordChangeInput): Promise<PasswordChangeResult> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input)
  });
  try {
    return await readConsoleApiResponse(response, "Password change failed", parsePasswordChangeResult);
  } catch (error) {
    if (error instanceof ConsoleApiError && error.status === 429) {
      const retryAfterSeconds = Number(response.headers.get("retry-after"));
      if (Number.isSafeInteger(retryAfterSeconds) && retryAfterSeconds > 0) {
        Object.assign(error, { retryAfterSeconds });
      }
    }
    throw error;
  }
}

function parsePasswordChangeResult(value: unknown): PasswordChangeResult {
  if (
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && (value as Record<string, unknown>).changed === true
    && (value as Record<string, unknown>).otherSessionsRevoked === true
    && Object.keys(value).length === 2
  ) {
    return { changed: true, otherSessionsRevoked: true };
  }
  throw new Error("Invalid password-change response");
}
