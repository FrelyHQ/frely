import { createHash, createHmac, randomBytes, timingSafeEqual, type KeyObject } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  createOidcOpaqueCredential,
  createPkceS256Challenge,
  hashOidcCredential,
  isHighEntropyOidcValue,
  isValidPkceChallenge,
  isValidPkceVerifier,
  oidcPrivateKey,
  oidcPublicJwk,
  oidcPublicKey,
  parseClientSecretBasic,
  signOidcIdToken,
  verifyOidcClientSecret,
  type OidcPublicJwk
} from "@frely/auth";
import type { AppConfig } from "@frely/config";
import { readBoundedRequestText, RelayError } from "@frely/core";
import type { OidcAuthorizationCodeSnapshot as OidcAuthorizationCode, UserSnapshot as User } from "@frely/identity";
import type { IdentityAuditInput, IdentityCommands, IdentityQueries } from "@frely/identity/server";

export const OIDC_USERINFO_AUDIENCE = "friday-relay:userinfo";
export const OIDC_INTERACTION_COOKIE = "friday_oidc_interaction";
export const OIDC_PENDING_COOKIE = "friday_oidc_pending";

type EnabledOidcConfig = Extract<NonNullable<AppConfig["oidc"]>, { enabled: true }>;
export type OidcClientConfig = EnabledOidcConfig["clients"][number];

export interface OidcAuthorizationRequest {
  clientId: string;
  redirectUri: string;
  scope: string;
  state: string;
  nonce: string;
  codeChallenge: string;
}

export interface OidcTokenResponse {
  token_type: "Bearer";
  access_token: string;
  expires_in: number;
  scope: string;
  id_token?: string;
}

export interface OidcAccessPrincipal {
  user: User;
  clientId: string;
  scopes: readonly string[];
}

export type AsyncOidcQueryPort = Pick<IdentityQueries,
  | "getOidcAuthorizationCodeByHash"
  | "getOidcAccessTokenByHash"
  | "getUser"
>;
export type AsyncOidcCommandPort = Pick<IdentityCommands,
  | "createOidcAuthorizationCode"
  | "exchangeOidcAuthorizationCode"
  | "revokeOidcAccessToken"
  | "deleteExpiredOidcState"
>;

interface SigningKeyMaterial {
  kid: string;
  privateKey?: KeyObject;
  publicKey: KeyObject;
}

interface LoadedSigningKey {
  material: SigningKeyMaterial;
  privatePem: string | null;
}

interface LoadedClient {
  config: OidcClientConfig;
  secret: string;
}

interface OidcMaterial {
  config: EnabledOidcConfig;
  clients: LoadedClient[];
  interactionSecret: string;
  signingKeys: SigningKeyMaterial[];
}

const OIDC_MAINTENANCE_INTERVAL_MS = 600_000;
let oidcMaterialPromise: Promise<OidcMaterial> | undefined;
let lastAsyncOidcMaintenanceAt = Number.NEGATIVE_INFINITY;

export class OidcProtocolError extends RelayError {
  constructor(
    code: "invalid_request" | "invalid_client" | "invalid_grant" | "unauthorized_client" | "unsupported_grant_type" | "invalid_scope",
    status: number,
    message = "OIDC request failed"
  ) {
    super(code, message, status);
    this.name = "OidcProtocolError";
  }
}

const OIDC_FORM_BODY_MAX_BYTES = 16_384;

export async function readOidcFormBody(request: Request): Promise<URLSearchParams> {
  try {
    return new URLSearchParams(await readBoundedRequestText(request, OIDC_FORM_BODY_MAX_BYTES));
  } catch (error) {
    if (
      error instanceof RelayError
      && ["invalid_content_length", "invalid_request_body", "request_body_too_large"].includes(error.code)
    ) {
      throw new OidcProtocolError("invalid_request", 400);
    }
    throw error;
  }
}

export class OidcProvider {
  protected constructor(
    readonly appConfig: AppConfig,
    readonly config: EnabledOidcConfig,
    protected readonly clients: LoadedClient[],
    protected readonly interactionSecret: string,
    protected readonly signingKeys: SigningKeyMaterial[]
  ) {}
  metadata(): Record<string, unknown> {
    return oidcMetadataForConfig(this.config);
  }

  jwks(): { keys: OidcPublicJwk[] } {
    return { keys: this.signingKeys.map((key) => oidcPublicJwk(key.publicKey, key.kid)) };
  }

  validateAuthorizationRequest(params: URLSearchParams): OidcAuthorizationRequest {
    assertOnlyParameters(params, ["client_id", "redirect_uri", "response_type", "scope", "state", "nonce", "code_challenge", "code_challenge_method"]);
    const clientId = requiredParam(params, "client_id");
    const redirectUri = requiredParam(params, "redirect_uri");
    const responseType = requiredParam(params, "response_type");
    const state = requiredParam(params, "state");
    const nonce = requiredParam(params, "nonce");
    const codeChallenge = requiredParam(params, "code_challenge");
    const codeChallengeMethod = requiredParam(params, "code_challenge_method");
    const client = this.client(clientId);
    if (!client) throw new OidcProtocolError("unauthorized_client", 400);
    const scope = normalizeClientScope(requiredParam(params, "scope"));
    if (!client.redirectUris.includes(redirectUri)) throw new OidcProtocolError("invalid_request", 400);
    if (responseType !== "code") throw new OidcProtocolError("invalid_request", 400);
    if (!isHighEntropyOidcValue(state) || !isHighEntropyOidcValue(nonce)) throw new OidcProtocolError("invalid_request", 400);
    if (codeChallengeMethod !== "S256" || !isValidPkceChallenge(codeChallenge)) throw new OidcProtocolError("invalid_request", 400);
    return { clientId, redirectUri, scope, state, nonce, codeChallenge };
  }

  createInteraction(request: OidcAuthorizationRequest): { csrf: string; cookie: string } {
    const csrf = randomBytes(32).toString("base64url");
    const payload = Buffer.from(JSON.stringify({
      csrf,
      authorizationHash: authorizationRequestHash(request),
      expiresAt: Date.now() + 300_000
    }), "utf8").toString("base64url");
    const signature = createHmac("sha256", this.interactionSecret).update(payload).digest("base64url");
    return { csrf, cookie: `${payload}.${signature}` };
  }

  createPendingAuthorizationCookie(request: OidcAuthorizationRequest): string {
    const payload = Buffer.from(JSON.stringify({
      ...request,
      expiresAt: Date.now() + 300_000
    }), "utf8").toString("base64url");
    const signature = createHmac("sha256", this.interactionSecret).update(payload).digest("base64url");
    return `${payload}.${signature}`;
  }

  pendingAuthorization(headers: Headers): OidcAuthorizationRequest | null {
    const cookie = cookieValue(headers, OIDC_PENDING_COOKIE);
    if (!cookie) return null;
    const separator = cookie.lastIndexOf(".");
    if (separator <= 0) return null;
    const payload = cookie.slice(0, separator);
    const expected = createHmac("sha256", this.interactionSecret).update(payload).digest();
    let presented: Buffer;
    let parsed: unknown;
    try {
      presented = Buffer.from(cookie.slice(separator + 1), "base64url");
      parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    } catch {
      return null;
    }
    if (presented.length !== expected.length || !timingSafeEqual(presented, expected) || !isRecord(parsed) || typeof parsed.expiresAt !== "number" || parsed.expiresAt <= Date.now()) return null;
    const params = new URLSearchParams({
      client_id: stringField(parsed, "clientId"),
      redirect_uri: stringField(parsed, "redirectUri"),
      response_type: "code",
      scope: stringField(parsed, "scope"),
      state: stringField(parsed, "state"),
      nonce: stringField(parsed, "nonce"),
      code_challenge: stringField(parsed, "codeChallenge"),
      code_challenge_method: "S256"
    });
    try {
      return this.validateAuthorizationRequest(params);
    } catch {
      return null;
    }
  }

  verifyInteraction(csrf: string, cookie: string | null, request: OidcAuthorizationRequest): boolean {
    if (!csrf || !cookie) return false;
    const separator = cookie.lastIndexOf(".");
    if (separator <= 0) return false;
    const payload = cookie.slice(0, separator);
    const expected = createHmac("sha256", this.interactionSecret).update(payload).digest();
    let presented: Buffer;
    let parsed: unknown;
    try {
      presented = Buffer.from(cookie.slice(separator + 1), "base64url");
      parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    } catch {
      return false;
    }
    return presented.length === expected.length
      && timingSafeEqual(presented, expected)
      && isRecord(parsed)
      && parsed.csrf === csrf
      && parsed.authorizationHash === authorizationRequestHash(request)
      && typeof parsed.expiresAt === "number"
      && parsed.expiresAt > Date.now();
  }

  interactionCookieHeader(value: string, secure: boolean, maxAgeSeconds = 300): string {
    return `${OIDC_INTERACTION_COOKIE}=${encodeURIComponent(value)}; Max-Age=${maxAgeSeconds}; Path=/oidc/authorize; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
  }

  pendingCookieHeader(value: string, secure: boolean, maxAgeSeconds = 300): string {
    return `${OIDC_PENDING_COOKIE}=${encodeURIComponent(value)}; Max-Age=${maxAgeSeconds}; Path=/oidc/authorize; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
  }

  abuseSubject(value: string): string {
    return createHmac("sha256", this.interactionSecret).update(value).digest("hex");
  }

  client(clientId: string): OidcClientConfig | undefined {
    return this.config.clients.find((client) => client.clientId === clientId);
  }
}

/**
 * PostgreSQL/control-plane counterpart of OidcProvider. The protocol and key
 * material stay shared with the synchronous implementation, while every
 * database read/write is awaited through the adapter contract.
 */
export class AsyncOidcProvider extends OidcProvider {
  private constructor(
    readonly identity: AsyncOidcQueryPort,
    readonly identityCommands: AsyncOidcCommandPort,
    appConfig: AppConfig,
    config: EnabledOidcConfig,
    clients: LoadedClient[],
    interactionSecret: string,
    signingKeys: SigningKeyMaterial[],
  ) {
    super(appConfig, config, clients, interactionSecret, signingKeys);
  }

  static async loadAsync(queries: AsyncOidcQueryPort, commands: AsyncOidcCommandPort, appConfig: AppConfig): Promise<AsyncOidcProvider> {
    await maybeMaintainOidcStateAsync(commands);
    try {
      const material = await (oidcMaterialPromise ??= loadOidcMaterial(appConfig));
      return new AsyncOidcProvider(queries, commands, appConfig, material.config, material.clients, material.interactionSecret, material.signingKeys);
    } catch {
      throw oidcUnavailable();
    }
  }

  async issueAuthorizationCodeAsync(request: OidcAuthorizationRequest, user: User, audit?: IdentityAuditInput): Promise<string> {
    if (user.status !== "enabled") throw new OidcProtocolError("invalid_request", 400);
    const code = createOidcOpaqueCredential("code");
    await this.identityCommands.createOidcAuthorizationCode({
      codeHash: code.hash,
      userId: user.id,
      clientId: request.clientId,
      redirectUri: request.redirectUri,
      scope: request.scope,
      codeChallenge: request.codeChallenge,
      nonce: request.nonce,
      expiresAt: expiresAt(this.config.codeTtlSeconds)
    }, audit);
    return code.raw;
  }

  async exchangeTokenAsync(request: Request, params: URLSearchParams): Promise<OidcTokenResponse> {
    const client = parseClientSecretBasic(request.headers.get("authorization"));
    const loadedClient = client ? this.clients.find((candidate) => candidate.config.clientId === client.clientId) : undefined;
    if (!client || !loadedClient || !verifyOidcClientSecret(client.clientSecret, loadedClient.secret)) {
      throw new OidcProtocolError("invalid_client", 401);
    }
    const grantType = requiredParam(params, "grant_type");
    if (grantType === "authorization_code") {
      assertOnlyParameters(params, ["grant_type", "code", "redirect_uri", "code_verifier"]);
      return this.exchangeAuthorizationCodeAsync(loadedClient, params);
    }
    throw new OidcProtocolError("unsupported_grant_type", 400);
  }

  private async exchangeAuthorizationCodeAsync(loadedClient: LoadedClient, params: URLSearchParams): Promise<OidcTokenResponse> {
    const code = requiredParam(params, "code");
    const redirectUri = requiredParam(params, "redirect_uri");
    const verifier = requiredParam(params, "code_verifier");
    if (!loadedClient.config.redirectUris.includes(redirectUri) || !isValidPkceVerifier(verifier)) throw new OidcProtocolError("invalid_grant", 400);
    const codeHash = hashOidcCredential(code);
    const codeChallenge = createPkceS256Challenge(verifier);
    const candidate = await this.identity.getOidcAuthorizationCodeByHash(codeHash);
    const user = candidate ? await this.identity.getUser(candidate.userId) : undefined;
    if (!validCodeCandidate(candidate, user, loadedClient.config.clientId, redirectUri, codeChallenge)) throw new OidcProtocolError("invalid_grant", 400);
    if (!candidate || !user) throw new OidcProtocolError("invalid_grant", 400);

    const activeKey = this.signingKeys.find((key) => key.kid === this.config.activeSigningKeyId);
    if (!activeKey?.privateKey) throw oidcUnavailable();
    let idToken: string;
    try {
      idToken = signOidcIdToken({
        issuer: this.config.issuer,
        subject: user.id,
        audience: loadedClient.config.clientId,
        nonce: candidate.nonce,
        expiresInSeconds: this.config.idTokenTtlSeconds,
        ...(candidate.scope.split(" ").includes("email") ? { email: user.email } : {})
      }, activeKey.privateKey, activeKey.kid);
    } catch {
      throw oidcUnavailable();
    }
    const access = createOidcOpaqueCredential("access");
    try {
      const result = await this.identityCommands.exchangeOidcAuthorizationCode({
        codeHash,
        clientId: loadedClient.config.clientId,
        redirectUri,
        codeChallenge,
        accessTokenHash: access.hash,
        accessTokenAudience: OIDC_USERINFO_AUDIENCE,
        accessTokenExpiresAt: expiresAt(this.config.accessTokenTtlSeconds)
      });
      return {
        token_type: "Bearer",
        access_token: access.raw,
        expires_in: this.config.accessTokenTtlSeconds,
        scope: result.authorizationCode.scope,
        id_token: idToken
      };
    } catch (error) {
      if (error instanceof RelayError && error.code === "invalid_grant") throw new OidcProtocolError("invalid_grant", 400);
      throw error;
    }
  }

  async revokeAsync(request: Request, params: URLSearchParams): Promise<void> {
    assertOnlyParameters(params, ["token", "token_type_hint"]);
    const client = parseClientSecretBasic(request.headers.get("authorization"));
    const loadedClient = client ? this.clients.find((candidate) => candidate.config.clientId === client.clientId) : undefined;
    if (!client || !loadedClient || !verifyOidcClientSecret(client.clientSecret, loadedClient.secret)) {
      throw new OidcProtocolError("invalid_client", 401);
    }
    const token = requiredParam(params, "token");
    const hint = params.get("token_type_hint");
    if (hint && hint !== "access_token") throw new OidcProtocolError("invalid_request", 400);
    await this.identityCommands.revokeOidcAccessToken(hashOidcCredential(token), loadedClient.config.clientId);
  }

  async userInfoAsync(request: Request): Promise<{ sub: string; email?: string }> {
    const { user, scopes } = await this.accessTokenPrincipalAsync(request, OIDC_USERINFO_AUDIENCE);
    return { sub: user.id, ...(scopes.includes("email") ? { email: user.email } : {}) };
  }

  async accessTokenPrincipalAsync(
    request: Request,
    audience: typeof OIDC_USERINFO_AUDIENCE,
  ): Promise<OidcAccessPrincipal> {
    const match = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") ?? "");
    if (!match?.[1]) throw new OidcProtocolError("invalid_request", 401);
    const now = new Date().toISOString();
    const token = await this.identity.getOidcAccessTokenByHash(hashOidcCredential(match[1].trim()));
    const client = token ? this.client(token.clientId) : undefined;
    const user = token ? await this.identity.getUser(token.userId) : undefined;
    const scopes = token?.scope.split(" ") ?? [];
    if (
      !token
      || !client
      || token.audience !== audience
      || token.revokedAt
      || token.expiresAt <= now
      || !user
      || user.status !== "enabled"
    ) throw new OidcProtocolError("invalid_request", 401);
    return { user, clientId: token.clientId, scopes };
  }
}

export function oidcMetadata(appConfig: AppConfig): Record<string, unknown> {
  return oidcMetadataForConfig(requireEnabledOidc(appConfig));
}

export async function maybeMaintainOidcStateAsync(identity: Pick<IdentityCommands, "deleteExpiredOidcState">, nowMs = Date.now()): Promise<boolean> {
  if (nowMs - lastAsyncOidcMaintenanceAt < OIDC_MAINTENANCE_INTERVAL_MS) return false;
  lastAsyncOidcMaintenanceAt = nowMs;
  await identity.deleteExpiredOidcState(new Date(nowMs).toISOString());
  return true;
}

export function resetOidcProcessStateForTests(): void {
  if (process.env.NODE_ENV !== "test") throw new Error("OIDC process state can only be reset in tests");
  oidcMaterialPromise = undefined;
}

export function oidcCookieValue(headers: Headers): string | null {
  return cookieValue(headers, OIDC_INTERACTION_COOKIE);
}

export function oidcRedirect(uri: string, values: Record<string, string>): string {
  const target = new URL(uri);
  for (const [key, value] of Object.entries(values)) target.searchParams.set(key, value);
  return target.toString();
}

export function assertOidcOrigin(request: Request, issuer: string): void {
  const origin = request.headers.get("origin");
  if (origin !== issuer) throw new OidcProtocolError("invalid_request", 400);
}

export function assertOidcRequestHost(request: Request, issuer: string): void {
  const host = request.headers.get("host")?.trim().toLowerCase().replace(/\.$/, "");
  const issuerHost = new URL(issuer).host.toLowerCase().replace(/\.$/, "");
  if (!host || host.includes("/") || host.includes("@") || host !== issuerHost) throw new OidcProtocolError("invalid_request", 400);
}

export function normalizeOidcEndpointError(error: unknown): RelayError {
  if (error instanceof OidcProtocolError) return error;
  if (
    error instanceof RelayError
    && ["oidc_unavailable", "rate_limited", "abuse_guard_unavailable", "https_required", "owner_web_login_forbidden"].includes(error.code)
  ) {
    return error;
  }
  return oidcUnavailable();
}

export async function withOidcEndpointFailureClosure<T>(action: () => Promise<T> | T): Promise<T> {
  try {
    return await action();
  } catch (error) {
    throw normalizeOidcEndpointError(error);
  }
}

function requireEnabledOidc(config: AppConfig): EnabledOidcConfig {
  if (!config.oidc?.enabled) throw new RelayError("oidc_unavailable", "OIDC is not enabled", 503);
  return config.oidc;
}

async function loadOidcMaterial(appConfig: AppConfig): Promise<OidcMaterial> {
  const config = requireEnabledOidc(appConfig);
  const [clients, interactionSecret, loadedSigningKeys] = await Promise.all([
    Promise.all(config.clients.map(async (client): Promise<LoadedClient> => ({
      config: client,
      secret: await readSecret(client.clientSecretFile, 32, `OIDC client secret for ${client.clientId}`)
    }))),
    readSecret(config.interactionSecretFile, 32, "OIDC interaction secret"),
    Promise.all(config.signingKeys.map(async (entry): Promise<LoadedSigningKey> => {
      const [privatePem, publicPem] = await Promise.all([
        entry.privateKeyFile ? readFile(entry.privateKeyFile, "utf8") : Promise.resolve(null),
        entry.publicKeyFile ? readFile(entry.publicKeyFile, "utf8") : Promise.resolve(null)
      ]);
      const privateKey = privatePem ? oidcPrivateKey(privatePem) : undefined;
      const publicKey = publicPem ? oidcPublicKey(publicPem) : privateKey;
      if (!publicKey) throw new Error("OIDC signing key has no public key material");
      if (privateKey && publicPem) {
        const derived = oidcPublicJwk(privateKey, entry.kid);
        const configured = oidcPublicJwk(publicKey, entry.kid);
        if (derived.n !== configured.n || derived.e !== configured.e) throw new Error("OIDC signing key public/private key mismatch");
      }
      return {
        material: { kid: entry.kid, ...(privateKey ? { privateKey } : {}), publicKey },
        privatePem
      };
    }))
  ]);
  assertIndependentOidcSecrets([
    appConfig.auth.jwtSecret,
    ...clients.map((client) => client.secret),
    interactionSecret,
    ...loadedSigningKeys.flatMap((key) => key.privatePem ? [stripFinalLineEnding(key.privatePem)] : [])
  ]);
  return {
    config,
    clients,
    interactionSecret,
    signingKeys: loadedSigningKeys.map((key) => key.material)
  };
}

function oidcMetadataForConfig(config: EnabledOidcConfig): Record<string, unknown> {
  return {
    issuer: config.issuer,
    authorization_endpoint: `${config.issuer}/oidc/authorize`,
    token_endpoint: `${config.issuer}/oidc/token`,
    revocation_endpoint: `${config.issuer}/oidc/revoke`,
    userinfo_endpoint: `${config.issuer}/oidc/userinfo`,
    jwks_uri: `${config.issuer}/oidc/jwks`,
    response_types_supported: ["code"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["RS256"],
    scopes_supported: ["openid", "email"],
    token_endpoint_auth_methods_supported: ["client_secret_basic"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    claims_supported: ["iss", "sub", "aud", "iat", "exp", "nonce", "email"]
  };
}

async function readSecret(path: string, minBytes: number, label: string): Promise<string> {
  const value = (await readFile(path, "utf8")).replace(/\r?\n$/, "");
  if (Buffer.byteLength(value, "utf8") < minBytes) throw new Error(`${label} must contain at least ${minBytes} bytes`);
  return value;
}

function requiredParam(params: URLSearchParams, name: string): string {
  const values = params.getAll(name);
  if (values.length !== 1 || !values[0]) throw new OidcProtocolError("invalid_request", 400);
  return values[0];
}

function assertOnlyParameters(params: URLSearchParams, allowed: string[]): void {
  const allowlist = new Set(allowed);
  for (const key of params.keys()) if (!allowlist.has(key)) throw new OidcProtocolError("invalid_request", 400);
}

function normalizeClientScope(raw: string): string {
  const values = raw.trim().split(/\s+/);
  if (new Set(values).size !== values.length) {
    throw new OidcProtocolError("invalid_scope", 400);
  }
  if (!values.includes("openid") || values.some((value) => value !== "openid" && value !== "email")) {
    throw new OidcProtocolError("invalid_scope", 400);
  }
  return values.includes("email") ? "openid email" : "openid";
}

function validCodeCandidate(
  code: OidcAuthorizationCode | undefined,
  user: User | undefined,
  clientId: string,
  redirectUri: string,
  codeChallenge: string
): code is OidcAuthorizationCode {
  const now = new Date().toISOString();
  return Boolean(
    code
    && !code.consumedAt
    && code.expiresAt > now
    && code.clientId === clientId
    && code.redirectUri === redirectUri
    && code.codeChallenge === codeChallenge
    && user?.status === "enabled"
  );
}

function expiresAt(ttlSeconds: number): string {
  return new Date(Date.now() + ttlSeconds * 1000).toISOString();
}

function authorizationRequestHash(request: OidcAuthorizationRequest): string {
  return createHash("sha256").update(JSON.stringify([
    request.clientId,
    request.redirectUri,
    request.scope,
    request.state,
    request.nonce,
    request.codeChallenge
  ])).digest("hex");
}

function cookieValue(headers: Headers, name: string): string | null {
  for (const part of (headers.get("cookie") ?? "").split(";")) {
    const [candidate, ...value] = part.trim().split("=");
    if (candidate !== name) continue;
    try {
      return decodeURIComponent(value.join("="));
    } catch {
      return null;
    }
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringField(value: Record<string, unknown>, key: string): string {
  return typeof value[key] === "string" ? value[key] : "";
}

function assertIndependentOidcSecrets(values: string[]): void {
  const fingerprints = values.map((value) => createHash("sha256").update(value).digest("hex"));
  if (new Set(fingerprints).size !== fingerprints.length) throw new Error("OIDC secrets and signing keys must be independent");
}

function stripFinalLineEnding(value: string): string {
  return value.replace(/\r?\n$/, "");
}

function oidcUnavailable(): RelayError {
  return new RelayError("oidc_unavailable", "OIDC is unavailable", 503);
}
