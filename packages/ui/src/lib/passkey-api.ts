import {
  WebAuthnAbortService,
  browserSupportsWebAuthn,
  browserSupportsWebAuthnAutofill,
  startAuthentication,
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON
} from "@simplewebauthn/browser";
import type { AuthenticatedLoginUser } from "./login-api.js";

export interface AccountPasskey {
  id: string;
  name: string;
  deviceType: "singleDevice" | "multiDevice";
  backedUp: boolean;
  createdAt: string;
  lastUsedAt: string | null;
  updatedAt: string;
  availableOn: Array<"web" | "admin">;
}

export interface AccountPasskeyList {
  passkeys: AccountPasskey[];
  canAdd: boolean;
}

class PasskeyRequestError extends Error {}

export function browserSupportsPasskeys(): boolean {
  return typeof window !== "undefined" && browserSupportsWebAuthn();
}

export async function browserSupportsPasskeyAutofill(): Promise<boolean> {
  return browserSupportsPasskeys() && await browserSupportsWebAuthnAutofill();
}

export function cancelPasskeyCeremony(): void {
  WebAuthnAbortService.cancelCeremony();
}

export async function loginWithPasskey(options: { conditional?: boolean; signal?: AbortSignal } = {}): Promise<AuthenticatedLoginUser> {
  try {
    if (!browserSupportsPasskeys()) throw new PasskeyRequestError("Passkeys are not supported by this browser");
    const signal = options.signal === undefined ? {} : { signal: options.signal };
    const optionResponse = await fetchJson<{ options: PublicKeyCredentialRequestOptionsJSON }>("/api/auth/passkey/options", { method: "POST", ...signal });
    const response = await startAuthentication({
      optionsJSON: optionResponse.options,
      useBrowserAutofill: options.conditional ?? false
    });
    const verified = await fetchJson<{ user: { id?: unknown } }>("/api/auth/passkey/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ response }),
      ...signal
    });
    if (typeof verified.user?.id !== "string" || !verified.user.id) throw new PasskeyRequestError("Passkey sign-in could not be completed");
    return { id: verified.user.id };
  } catch (error) {
    if (isPasskeyCancellation(error) || error instanceof PasskeyRequestError) throw error;
    throw new PasskeyRequestError("Passkey sign-in could not be completed");
  }
}

export async function listPasskeys(): Promise<AccountPasskeyList> {
  const body = await fetchJson<{ passkeys?: unknown; canAdd?: unknown }>("/api/account/security/passkeys", { method: "GET" });
  if (!Array.isArray(body.passkeys) || typeof body.canAdd !== "boolean") throw new PasskeyRequestError("Passkey settings could not be loaded");
  return { passkeys: body.passkeys as AccountPasskey[], canAdd: body.canAdd };
}

export async function registerPasskey(input: { name: string; currentPassword: string }): Promise<AccountPasskey> {
  try {
    if (!browserSupportsPasskeys()) throw new PasskeyRequestError("Passkeys are not supported by this browser");
    const optionResponse = await fetchJson<{ options: PublicKeyCredentialCreationOptionsJSON }>("/api/account/security/passkeys/registration/options", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input)
    });
    const response = await startRegistration({ optionsJSON: optionResponse.options });
    const body = await fetchJson<{ passkey?: AccountPasskey }>("/api/account/security/passkeys/registration/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ response })
    });
    if (!body.passkey) throw new PasskeyRequestError("Passkey could not be added");
    return body.passkey;
  } catch (error) {
    if (isPasskeyCancellation(error) || error instanceof PasskeyRequestError) throw error;
    throw new PasskeyRequestError("Passkey could not be added");
  }
}

export async function renamePasskey(id: string, name: string): Promise<AccountPasskey> {
  const body = await fetchJson<{ passkey?: AccountPasskey }>(`/api/account/security/passkeys/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name })
  });
  if (!body.passkey) throw new Error("Invalid Passkey response");
  return body.passkey;
}

export async function deletePasskey(id: string, currentPassword: string): Promise<void> {
  await fetchJson(`/api/account/security/passkeys/${encodeURIComponent(id)}/delete`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ currentPassword })
  });
}

export function isPasskeyCancellation(error: unknown): boolean {
  return error instanceof DOMException && ["AbortError", "NotAllowedError"].includes(error.name);
}

export function passkeyUserMessage(error: unknown, fallback = "Passkey request failed"): string {
  return error instanceof PasskeyRequestError ? error.message : fallback;
}

async function fetchJson<T = unknown>(input: RequestInfo | URL, init: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  const body = await response.json().catch(() => ({})) as T & { error?: { code?: string } };
  if (!response.ok) throw new PasskeyRequestError(passkeyServerErrorMessage(body.error?.code));
  return body;
}

function passkeyServerErrorMessage(code: string | undefined): string {
  if (code === "current_password_invalid") return "Current password is invalid";
  if (code === "passkey_limit_reached") return "Passkey limit reached";
  if (code === "passkey_already_registered") return "This Passkey is already registered";
  if (code === "passkey_not_found") return "Passkey not found";
  if (code === "rate_limited") return "Too many attempts. Try again later";
  if (code === "unauthorized" || code === "forbidden" || code === "owner_login_forbidden") return "Your session is no longer authorized";
  return "Passkey request failed";
}
