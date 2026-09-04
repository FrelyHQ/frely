// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  browserSupportsPasskeyAutofill,
  browserSupportsPasskeys,
  cancelPasskeyCeremony,
  deletePasskey,
  isPasskeyCancellation,
  listPasskeys,
  loginWithPasskey,
  registerPasskey,
  renamePasskey
} from "./passkey-api.js";

const browser = vi.hoisted(() => ({
  browserSupportsWebAuthn: vi.fn(),
  browserSupportsWebAuthnAutofill: vi.fn(),
  cancelCeremony: vi.fn(),
  startAuthentication: vi.fn(),
  startRegistration: vi.fn()
}));

vi.mock("@simplewebauthn/browser", () => ({
  WebAuthnAbortService: { cancelCeremony: browser.cancelCeremony },
  browserSupportsWebAuthn: browser.browserSupportsWebAuthn,
  browserSupportsWebAuthnAutofill: browser.browserSupportsWebAuthnAutofill,
  startAuthentication: browser.startAuthentication,
  startRegistration: browser.startRegistration
}));

beforeEach(() => {
  browser.browserSupportsWebAuthn.mockReturnValue(true);
  browser.browserSupportsWebAuthnAutofill.mockResolvedValue(true);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("Passkey browser capability and cancellation", () => {
  test("reports WebAuthn and Conditional UI support independently", async () => {
    expect(browserSupportsPasskeys()).toBe(true);
    await expect(browserSupportsPasskeyAutofill()).resolves.toBe(true);

    browser.browserSupportsWebAuthn.mockReturnValue(false);
    expect(browserSupportsPasskeys()).toBe(false);
    await expect(browserSupportsPasskeyAutofill()).resolves.toBe(false);
    expect(browser.browserSupportsWebAuthnAutofill).toHaveBeenCalledTimes(1);
  });

  test("cancels an in-flight ceremony and classifies browser cancellation errors", () => {
    cancelPasskeyCeremony();

    expect(browser.cancelCeremony).toHaveBeenCalledOnce();
    expect(isPasskeyCancellation(new DOMException("cancelled", "AbortError"))).toBe(true);
    expect(isPasskeyCancellation(new DOMException("dismissed", "NotAllowedError"))).toBe(true);
    expect(isPasskeyCancellation(new Error("network failure"))).toBe(false);
  });
});

describe("Passkey sign-in", () => {
  test.each([false, true])("performs a %s conditional ceremony without returning WebAuthn material", async (conditional) => {
    const options = authenticationOptions("authentication-options-secret");
    const credentialResponse = authenticationResponse("authentication-response-secret");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ options }))
      .mockResolvedValueOnce(Response.json({ user: { id: "user-passkey", email: "ignored@example.com" } }));
    vi.stubGlobal("fetch", fetchMock);
    browser.startAuthentication.mockResolvedValue(credentialResponse);

    const result = await loginWithPasskey({ conditional });

    expect(result).toEqual({ id: "user-passkey" });

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/auth/passkey/options", { method: "POST" });
    expect(browser.startAuthentication).toHaveBeenCalledWith({ optionsJSON: options, useBrowserAutofill: conditional });
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/auth/passkey/verify", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ response: credentialResponse })
    }));
    expect(JSON.stringify(result)).not.toContain("authentication-options-secret");
    expect(JSON.stringify(result)).not.toContain("authentication-response-secret");
  });

  test("rejects unsupported browsers before creating a server ceremony", async () => {
    browser.browserSupportsWebAuthn.mockReturnValue(false);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(loginWithPasskey()).rejects.toThrow("Passkeys are not supported by this browser");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("propagates one AbortSignal through both sign-in HTTP requests", async () => {
    const controller = new AbortController();
    const options = authenticationOptions("challenge");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ options }))
      .mockResolvedValueOnce(Response.json({ user: { id: "user-passkey" } }));
    vi.stubGlobal("fetch", fetchMock);
    browser.startAuthentication.mockResolvedValue(authenticationResponse("credential"));

    await expect(loginWithPasskey({ signal: controller.signal })).resolves.toEqual({ id: "user-passkey" });

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/auth/passkey/options", { method: "POST", signal: controller.signal });
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/auth/passkey/verify", expect.objectContaining({ signal: controller.signal }));
  });

  test("rejects a successful verification response without a trusted user id", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(Response.json({ options: authenticationOptions("challenge") }))
      .mockResolvedValueOnce(Response.json({ user: { email: "user@example.com" } })));
    browser.startAuthentication.mockResolvedValue(authenticationResponse("credential"));

    await expect(loginWithPasskey()).rejects.toThrow("Passkey sign-in could not be completed");
  });
});

describe("Passkey account API", () => {
  test("lists the current user's safe Passkey projection", async () => {
    const passkey = safePasskey();
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ passkeys: [passkey], canAdd: true }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(listPasskeys()).resolves.toEqual({ passkeys: [passkey], canAdd: true });
    expect(fetchMock).toHaveBeenCalledWith("/api/account/security/passkeys", { method: "GET" });
  });

  test("keeps registration options and authenticator response inside the direct ceremony", async () => {
    const options = registrationOptions("registration-options-secret");
    const credentialResponse = registrationResponse("registration-response-secret");
    const passkey = safePasskey();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ options }))
      .mockResolvedValueOnce(Response.json({ passkey }));
    vi.stubGlobal("fetch", fetchMock);
    browser.startRegistration.mockResolvedValue(credentialResponse);

    const result = await registerPasskey({ name: "Laptop", currentPassword: "password-secret" });

    expect(result).toEqual(passkey);
    expect(browser.startRegistration).toHaveBeenCalledWith({ optionsJSON: options });
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/account/security/passkeys/registration/options", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ name: "Laptop", currentPassword: "password-secret" })
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/account/security/passkeys/registration/verify", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ response: credentialResponse })
    }));
    expect(JSON.stringify(result)).not.toContain("registration-options-secret");
    expect(JSON.stringify(result)).not.toContain("registration-response-secret");
    expect(String((fetchMock.mock.calls[1]?.[1] as RequestInit | undefined)?.body)).not.toContain("password-secret");
  });

  test("renames and deletes only the encoded current-user credential resource", async () => {
    const renamed = { ...safePasskey(), name: "Security key" };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ passkey: renamed }))
      .mockResolvedValueOnce(Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(renamePasskey("credential/with spaces", "Security key")).resolves.toEqual(renamed);
    await expect(deletePasskey("credential/with spaces", "current-password")).resolves.toBeUndefined();

    const resource = "/api/account/security/passkeys/credential%2Fwith%20spaces";
    expect(fetchMock).toHaveBeenNthCalledWith(1, resource, expect.objectContaining({ method: "PATCH", body: JSON.stringify({ name: "Security key" }) }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, `${resource}/delete`, expect.objectContaining({ method: "POST", body: JSON.stringify({ currentPassword: "current-password" }) }));
  });

  test("rejects malformed safe projections and uses the server's bounded error message", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ passkeys: {}, canAdd: true }))
      .mockResolvedValueOnce(Response.json({ error: { code: "current_password_invalid", message: "raw server detail must not be rendered" } }, { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(listPasskeys()).rejects.toThrow("Passkey settings could not be loaded");
    await expect(deletePasskey("credential", "wrong-password")).rejects.toThrow("Current password is invalid");
  });

  test("normalizes raw browser exceptions to a fixed user-safe message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ options: authenticationOptions("challenge") })));
    browser.startAuthentication.mockRejectedValue(new Error("authenticator serial 1234 transport stack failure"));

    await expect(loginWithPasskey()).rejects.toThrow("Passkey sign-in could not be completed");
  });
});

function safePasskey() {
  return {
    id: "passkey-1",
    name: "Laptop",
    deviceType: "multiDevice" as const,
    backedUp: true,
    createdAt: "2026-07-31T00:00:00.000Z",
    lastUsedAt: null,
    updatedAt: "2026-07-31T00:00:00.000Z",
    availableOn: ["web"] as Array<"web" | "admin">
  };
}

function authenticationOptions(challenge: string) {
  return { challenge, timeout: 60_000, rpId: "example.com", userVerification: "required" as const };
}

function authenticationResponse(id: string) {
  return {
    id,
    rawId: id,
    response: { authenticatorData: "data", clientDataJSON: "client", signature: "signature" },
    type: "public-key" as const,
    clientExtensionResults: {}
  };
}

function registrationOptions(challenge: string) {
  return {
    challenge,
    rp: { id: "example.com", name: "Frely" },
    user: { id: "user-handle", name: "user@example.com", displayName: "User" },
    pubKeyCredParams: [{ alg: -7, type: "public-key" as const }]
  };
}

function registrationResponse(id: string) {
  return {
    id,
    rawId: id,
    response: { attestationObject: "attestation", clientDataJSON: "client", transports: ["internal" as const] },
    type: "public-key" as const,
    clientExtensionResults: {}
  };
}
