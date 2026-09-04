import { describe, expect, test } from "vitest";
import {
  ConsoleApiError,
  readConsoleApiResponse,
  toConsoleUiError,
} from "./api-error.js";

describe("Console API contract and UI error model", () => {
  test("validates successful payloads at the application boundary", async () => {
    const parse = (value: unknown) => {
      if (!value || typeof value !== "object" || !("id" in value) || typeof value.id !== "string") {
        throw new Error("invalid");
      }
      return { id: value.id };
    };
    await expect(readConsoleApiResponse(
      new Response(JSON.stringify({ id: "resource_1" }), { status: 200 }),
      "Load failed",
      parse,
    )).resolves.toEqual({ id: "resource_1" });
    await expect(readConsoleApiResponse(
      new Response(JSON.stringify({ id: 1 }), { status: 200 }),
      "Load failed",
      parse,
    )).rejects.toMatchObject({
      status: 502,
      code: "invalid_response_contract",
      message: "Load failed: invalid response contract",
    });
  });

  test("keeps diagnostic fields while exposing stable UI semantics", () => {
    expect(toConsoleUiError(new ConsoleApiError("Denied", {
      status: 403,
      code: "team_permission_denied",
      requestId: "request_1",
      fieldErrors: { teamId: "Forbidden" },
    }), "Fallback")).toEqual({
      kind: "forbidden",
      message: "Denied",
      retryable: false,
      status: 403,
      code: "team_permission_denied",
      requestId: "request_1",
      fieldErrors: { teamId: "Forbidden" },
    });
    expect(toConsoleUiError(new ConsoleApiError("Try again", {
      status: 503,
      code: "temporarily_unavailable",
    }), "Fallback")).toMatchObject({ kind: "transient", retryable: true });
  });
});
