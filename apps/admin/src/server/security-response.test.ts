import { describe, expect, test } from "vitest";
import { withAdminSecurityHeaders } from "./security-response";

describe("Admin response security contract", () => {
  test("keeps dynamic responses private and binds the scoped request id", () => {
    const response = withAdminSecurityHeaders(new Response("owner"), {
      production: false,
      requestId: "req_shared",
    });

    expect(response.headers.get("cache-control"))
      .toBe("private, no-cache, no-store, max-age=0, must-revalidate");
    expect(response.headers.get("x-request-id")).toBe("req_shared");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });

  test("preserves an explicit route cache policy", () => {
    const response = withAdminSecurityHeaders(new Response("asset", {
      headers: { "cache-control": "public, max-age=300, immutable" },
    }), false);

    expect(response.headers.get("cache-control")).toBe("public, max-age=300, immutable");
  });
});
