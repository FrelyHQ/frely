import { describe, expect, test } from "vitest";
import {
  accessTokenFromHeaders,
  createPasswordHash,
  landingRegistrationEntryCookieHeaders,
  landingRegistrationEntryFromHeaders,
  signLandingEntryState,
  verifyLandingEntryState,
  refreshTokenFromHeaders
} from "./index.js";
import { testConfig } from "@frely/testkit";

describe("authentication cookie parsing", () => {
  test("fails closed for malformed percent-encoding instead of throwing an internal URI error", () => {
    const accessHeaders = new Headers({ cookie: "friday_web_access_token=%E0%A4%A" });
    expect(() => accessTokenFromHeaders(accessHeaders, "web")).toThrow(
      "Bearer token or session cookie is required"
    );

    const refreshHeaders = new Headers({ cookie: "friday_web_refresh_token=%E0%A4%A" });
    expect(refreshTokenFromHeaders(refreshHeaders, "web")).toBeNull();
  });

  test("does not create a reusable hash for an empty credential", async () => {
    await expect(createPasswordHash("")).rejects.toMatchObject({
      code: "invalid_password",
      status: 400
    });
  });

  test("binds a short-lived landing handoff to the canonical origin, hostname, and DomainBinding", () => {
    const config = testConfig();
    const issuedAt = 1_800_000_000;
    const token = signLandingEntryState(config, {
      canonicalOrigin: config.app.publicBaseUrl,
      domainBindingId: "binding_test",
      hostname: "relay.example.test",
      issuedAtEpochSeconds: issuedAt
    });

    expect(verifyLandingEntryState(config, token, { canonicalOrigin: config.app.publicBaseUrl, nowEpochSeconds: issuedAt + 599 })).toEqual(expect.objectContaining({
      type: "landing_entry",
      purpose: "registration",
      domainBindingId: "binding_test",
      hostname: "relay.example.test",
      iat: issuedAt,
      exp: issuedAt + 600
    }));
    expect(() => verifyLandingEntryState(config, token, { canonicalOrigin: "https://other.example.test", nowEpochSeconds: issuedAt + 1 })).toThrow(expect.objectContaining({ code: "landing_entry_invalid" }));
    expect(() => verifyLandingEntryState(config, token, { canonicalOrigin: config.app.publicBaseUrl, nowEpochSeconds: issuedAt + 600 })).toThrow(expect.objectContaining({ code: "landing_entry_invalid" }));

    const currentToken = signLandingEntryState(config, {
      canonicalOrigin: config.app.publicBaseUrl,
      domainBindingId: "binding_test",
      hostname: "relay.example.test"
    });
    const cookie = landingRegistrationEntryCookieHeaders(config, currentToken)[0]!.split(";", 1)[0]!;
    expect(landingRegistrationEntryFromHeaders(config, new Headers({ cookie }))).toEqual(expect.objectContaining({ domainBindingId: "binding_test" }));
  });
});
