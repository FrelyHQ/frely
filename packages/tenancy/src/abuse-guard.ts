import { createHmac } from "node:crypto";
import { isIP } from "node:net";
import { metrics } from "@opentelemetry/api";
import type { AppConfig } from "@frely/config";
import { RelayError } from "@frely/core";
import type { AsyncApplicationOperationPort } from "@frely/application/runtime";
import type { ApplicationOperationPort } from "@frely/application/runtime";

export type AbuseGuardSource = "web" | "admin" | "gateway";
export type CanonicalClientIpHeader = "x-real-ip" | "cf-connecting-ip";
export type AbuseBucket =
  | "auth.login.attempt"
  | "auth.login.failed"
  | "auth.refresh.attempt"
  | "auth.refresh.failed"
  | "invite.preview.attempt"
  | "invite.preview.failed"
  | "invite.accept.attempt"
  | "invite.accept.failed"
  | "gateway.auth.failed"
  | "api_key_self.auth.failed"
  | "oidc.authorize.attempt"
  | "oidc.authorize.failure"
  | "oidc.token.attempt"
  | "oidc.token.failure"
  | "oidc.revoke.attempt"
  | "oidc.revoke.failure"
  | "oidc.userinfo.failure";

export interface AbuseGuardContext {
  routePattern?: string;
  requestId?: string | null;
}

const WINDOW_SECONDS = 600;
export const ABUSE_POLICIES: Readonly<Record<AbuseBucket, Readonly<{ limit: number; windowSeconds: number }>>> = {
  "auth.login.attempt": { limit: 20, windowSeconds: WINDOW_SECONDS },
  "auth.login.failed": { limit: 10, windowSeconds: WINDOW_SECONDS },
  "auth.refresh.attempt": { limit: 60, windowSeconds: WINDOW_SECONDS },
  "auth.refresh.failed": { limit: 30, windowSeconds: WINDOW_SECONDS },
  "invite.preview.attempt": { limit: 60, windowSeconds: WINDOW_SECONDS },
  "invite.preview.failed": { limit: 20, windowSeconds: WINDOW_SECONDS },
  "invite.accept.attempt": { limit: 20, windowSeconds: WINDOW_SECONDS },
  "invite.accept.failed": { limit: 10, windowSeconds: WINDOW_SECONDS },
  "gateway.auth.failed": { limit: 120, windowSeconds: WINDOW_SECONDS },
  "api_key_self.auth.failed": { limit: 60, windowSeconds: WINDOW_SECONDS },
  "oidc.authorize.attempt": { limit: 10, windowSeconds: WINDOW_SECONDS },
  "oidc.authorize.failure": { limit: 10, windowSeconds: WINDOW_SECONDS },
  "oidc.token.attempt": { limit: 10, windowSeconds: WINDOW_SECONDS },
  "oidc.token.failure": { limit: 10, windowSeconds: WINDOW_SECONDS },
  "oidc.revoke.attempt": { limit: 10, windowSeconds: WINDOW_SECONDS },
  "oidc.revoke.failure": { limit: 10, windowSeconds: WINDOW_SECONDS },
  "oidc.userinfo.failure": { limit: 10, windowSeconds: WINDOW_SECONDS }
};

let lastCleanupAt = Number.NEGATIVE_INFINITY;
let lastAsyncCleanupAt = Number.NEGATIVE_INFINITY;
let decisionCounter: ReturnType<ReturnType<typeof metrics.getMeter>["createCounter"]> | undefined;

export class AbuseGuard {
  constructor(
    private readonly repo: ApplicationOperationPort,
    private readonly config: AppConfig,
    private readonly source: AbuseGuardSource
  ) {}

  consume(bucket: AbuseBucket, headers: Headers, context: AbuseGuardContext = {}): void {
    this.decide(bucket, headers, context, true);
  }

  assertNotBlocked(bucket: AbuseBucket, headers: Headers, context: AbuseGuardContext = {}): void {
    this.decide(bucket, headers, context, false);
  }

  canonicalClientIp(headers: Headers): { header: CanonicalClientIpHeader; value: string } | null {
    const header = effectiveCanonicalClientIpHeader(this.config);
    if (!header) {
      if (this.config.app.environment !== "production") return null;
      throw unavailableError();
    }
    const candidate = headers.get(header)?.trim() ?? "";
    if (candidate.length > 64 || candidate.includes(",") || !isIP(candidate)) {
      if (this.config.app.environment !== "production") return null;
      throw unavailableError();
    }
    return { header, value: candidate };
  }

  private decide(bucket: AbuseBucket, headers: Headers, context: AbuseGuardContext, consume: boolean): void {
    const policy = ABUSE_POLICIES[bucket];
    try {
      const nowMs = Date.now();
      if (nowMs - lastCleanupAt >= WINDOW_SECONDS * 1000) {
        this.repo.deleteExpiredAbuseRateLimits(nowMs);
        lastCleanupAt = nowMs;
      }
      const canonical = this.canonicalClientIp(headers);
      const subjectValue = canonical?.value ?? "unavailable-client-ip";
      const subjectHash = createHmac("sha256", this.config.auth.jwtSecret)
        .update(`friday-relay-abuse-v1\0client_ip\0${subjectValue}`)
        .digest("hex");
      const input = {
        bucket,
        subjectHashes: [`client_ip:${subjectHash}`],
        limit: policy.limit,
        windowSeconds: policy.windowSeconds,
        nowMs
      };
      const decision = consume
        ? this.repo.consumeAbuseRateLimit(input)
        : this.repo.inspectAbuseRateLimit(input);
      if (!decision.allowed) {
        recordDecision(bucket, "blocked", this.source);
        logDecision(bucket, "blocked", this.source, context, decision.retryAfterSeconds);
        throw rateLimitedError(decision.retryAfterSeconds);
      }
      recordDecision(bucket, "allowed", this.source);
    } catch (error) {
      if (error instanceof RelayError && error.code === "rate_limited") throw error;
      recordDecision(bucket, "unavailable", this.source);
      logDecision(bucket, "unavailable", this.source, context);
      throw unavailableError();
    }
  }
}

export function createAbuseGuard(input: { repo: ApplicationOperationPort; config: AppConfig; source: AbuseGuardSource }): AbuseGuard {
  return new AbuseGuard(input.repo, input.config, input.source);
}

export interface AsyncAbuseGuardQueries extends Pick<AsyncApplicationOperationPort, "inspectAbuseRateLimit"> {}
export interface AsyncAbuseGuardCommands extends Pick<AsyncApplicationOperationPort, "deleteExpiredAbuseRateLimits" | "consumeAbuseRateLimit"> {}

export class AsyncAbuseGuard {
  constructor(
    private readonly queries: AsyncAbuseGuardQueries,
    private readonly commands: AsyncAbuseGuardCommands,
    private readonly config: AppConfig,
    private readonly source: AbuseGuardSource,
  ) {}

  consume(bucket: AbuseBucket, headers: Headers, context: AbuseGuardContext = {}): Promise<void> {
    return this.decide(bucket, headers, context, true);
  }

  assertNotBlocked(bucket: AbuseBucket, headers: Headers, context: AbuseGuardContext = {}): Promise<void> {
    return this.decide(bucket, headers, context, false);
  }

  canonicalClientIp(headers: Headers): { header: CanonicalClientIpHeader; value: string } | null {
    const header = effectiveCanonicalClientIpHeader(this.config);
    if (!header) {
      if (this.config.app.environment !== "production") return null;
      throw unavailableError();
    }
    const candidate = headers.get(header)?.trim() ?? "";
    if (candidate.length > 64 || candidate.includes(",") || !isIP(candidate)) {
      if (this.config.app.environment !== "production") return null;
      throw unavailableError();
    }
    return { header, value: candidate };
  }

  private async decide(bucket: AbuseBucket, headers: Headers, context: AbuseGuardContext, consume: boolean): Promise<void> {
    const policy = ABUSE_POLICIES[bucket];
    try {
      const nowMs = Date.now();
      if (nowMs - lastAsyncCleanupAt >= WINDOW_SECONDS * 1000) {
        await this.commands.deleteExpiredAbuseRateLimits(nowMs);
        lastAsyncCleanupAt = nowMs;
      }
      const canonical = this.canonicalClientIp(headers);
      const subjectValue = canonical?.value ?? "unavailable-client-ip";
      const subjectHash = createHmac("sha256", this.config.auth.jwtSecret)
        .update(`friday-relay-abuse-v1\0client_ip\0${subjectValue}`)
        .digest("hex");
      const input = {
        bucket,
        subjectHashes: [`client_ip:${subjectHash}`],
        limit: policy.limit,
        windowSeconds: policy.windowSeconds,
        nowMs,
      };
      const decision = consume
        ? await this.commands.consumeAbuseRateLimit(input)
        : await this.queries.inspectAbuseRateLimit(input);
      if (!decision.allowed) {
        recordDecision(bucket, "blocked", this.source);
        logDecision(bucket, "blocked", this.source, context, decision.retryAfterSeconds);
        throw rateLimitedError(decision.retryAfterSeconds);
      }
      recordDecision(bucket, "allowed", this.source);
    } catch (error) {
      if (error instanceof RelayError && error.code === "rate_limited") throw error;
      recordDecision(bucket, "unavailable", this.source);
      logDecision(bucket, "unavailable", this.source, context);
      throw unavailableError();
    }
  }
}

export function createAsyncAbuseGuard(input: { queries: AsyncAbuseGuardQueries; commands: AsyncAbuseGuardCommands; config: AppConfig; source: AbuseGuardSource }): AsyncAbuseGuard {
  return new AsyncAbuseGuard(input.queries, input.commands, input.config, input.source);
}

export function effectiveCanonicalClientIpHeader(config: AppConfig): CanonicalClientIpHeader | null {
  return config.security.abuseRateLimit.canonicalClientIpHeader
    ?? (config.oidc?.enabled ? config.oidc.canonicalClientIpHeader ?? null : null);
}

export function isExpectedLoginFailure(error: unknown): boolean {
  return error instanceof RelayError && [
    "invalid_credentials",
    "user_disabled",
    "owner_login_forbidden",
    "owner_web_login_forbidden"
  ].includes(error.code);
}

export function isExpectedRefreshFailure(error: unknown): boolean {
  return error instanceof RelayError && [
    "invalid_refresh_token",
    "invalid_credentials",
    "user_not_found",
    "user_disabled",
    "owner_login_forbidden",
    "owner_web_login_forbidden"
  ].includes(error.code);
}

export function isExpectedApiKeyAuthenticationFailure(error: unknown): boolean {
  return error instanceof RelayError && [
    "unauthorized",
    "invalid_api_key",
    "api_key_disabled",
    "api_key_revoked",
    "api_key_expired",
    "principal_not_found",
    "user_disabled"
  ].includes(error.code);
}

export function normalizeLoginFailure(error: unknown): RelayError {
  return isExpectedLoginFailure(error)
    ? new RelayError("invalid_credentials", "Invalid credentials", 401)
    : error instanceof RelayError
      ? error
      : new RelayError("internal_error", "Internal server error", 500);
}

export function normalizeRefreshFailure(error: unknown): RelayError {
  return isExpectedRefreshFailure(error)
    ? new RelayError("invalid_refresh_token", "Invalid refresh token", 401)
    : error instanceof RelayError
      ? error
      : new RelayError("internal_error", "Internal server error", 500);
}

export function normalizeApiKeyAuthenticationFailure(error: unknown): RelayError {
  return isExpectedApiKeyAuthenticationFailure(error)
    ? new RelayError("invalid_api_key", "Invalid API key", 401)
    : error instanceof RelayError
      ? error
      : new RelayError("internal_error", "Internal server error", 500);
}

function rateLimitedError(retryAfterSeconds: number): RelayError {
  const error = new RelayError("rate_limited", "Too many requests", 429) as RelayError & { retryAfterSeconds: number };
  error.retryAfterSeconds = retryAfterSeconds;
  return error;
}

function unavailableError(): RelayError {
  return new RelayError("abuse_guard_unavailable", "Request protection is unavailable", 503);
}

function recordDecision(bucket: AbuseBucket, decision: "allowed" | "blocked" | "unavailable", source: AbuseGuardSource): void {
  decisionCounter ??= metrics.getMeter("@frely/tenancy").createCounter("abuse_rate_limit_decisions_total");
  decisionCounter.add(1, abuseDecisionAttributes(bucket, decision, source));
}

export function abuseDecisionAttributes(
  bucket: AbuseBucket,
  decision: "allowed" | "blocked" | "unavailable",
  source: AbuseGuardSource,
): Readonly<{ bucket: AbuseBucket; decision: "allowed" | "blocked" | "unavailable"; source: AbuseGuardSource }> {
  return { bucket, decision, source };
}

function logDecision(
  bucket: AbuseBucket,
  decision: "blocked" | "unavailable",
  source: AbuseGuardSource,
  context: AbuseGuardContext,
  retryAfterSeconds?: number
): void {
  console.warn(JSON.stringify({
    event: "abuse_rate_limit.decision",
    bucket,
    decision,
    source,
    routePattern: context.routePattern ?? "unknown",
    statusClass: decision === "blocked" ? "4xx" : "5xx",
    ...(retryAfterSeconds ? { retryAfterSeconds } : {}),
    ...(context.requestId ? { requestId: context.requestId } : {})
  }));
}
