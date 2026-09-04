import { betterAuth, type BetterAuthOptions, type DBAdapter, type DBTransactionAdapter, type JoinOption, type Where } from "better-auth";
import { prismaAdapter } from "@better-auth/prisma-adapter";
import { authMutationHeaders, betterAuthSessionTokenHash, createPasswordHash, verifyPassword, type ValidatedAuthMutationRequest } from "@frely/auth";
import type { AppConfig } from "@frely/config";
import { createId, RelayError } from "@frely/core";
import type { Prisma, PrismaTransactionOwner } from "@frely/postgres/server";
import type { BetterAuthResponseResult, BetterAuthRuntime, BetterAuthSessionResult } from "./better-auth-contracts.js";
import { createAuthLinkEmail, createResendMailTransportFromEnvironment, type MailEnvironment, type MailTransport } from "./resend-mail.js";

export type { BetterAuthResponseResult, BetterAuthRuntime, BetterAuthSessionResult } from "./better-auth-contracts.js";

const BETTER_AUTH_BASE_PATH = "/api/auth";
const BETTER_AUTH_SESSION_COOKIE = "friday_session_token";
const CREDENTIAL_PROVIDER = "credential";
const CREDENTIAL_ISSUER = "local:credential";
type PrismaIdentityOwner = PrismaTransactionOwner & { prisma: Prisma.TransactionClient };

export interface BetterAuthRuntimeOptions {
  readonly mailTransport?: MailTransport | null;
  readonly environment?: MailEnvironment;
}

/**
 * Create the single Better Auth identity/session authority used by Web and
 * Owner. Business status and authorization remain outside the Better Auth
 * schema and are checked through the supplied Friday controls table.
 */
export function createBetterAuthRuntime(
  owner: PrismaIdentityOwner,
  config: AppConfig,
  options: BetterAuthRuntimeOptions = {},
): BetterAuthRuntime {
  const canonicalOrigin = new URL(config.app.publicBaseUrl).origin;
  const mailTransport = options.mailTransport === undefined
    ? options.environment === undefined
      ? createResendMailTransportFromEnvironment(config)
      : createResendMailTransportFromEnvironment(config, options.environment)
    : options.mailTransport;
  const sendAuthLinkEmail = async (input: {
    readonly to: string;
    readonly subject: string;
    readonly title: string;
    readonly description: string;
    readonly action: string;
    readonly url: string;
  }): Promise<void> => {
    if (!mailTransport) throw new RelayError("email_delivery_unavailable", "Email delivery is not configured", 503);
    await mailTransport.send(createAuthLinkEmail(input));
  };
  const adapterFactory = prismaAdapter(owner.prisma, {
    provider: "postgresql",
    transaction: true,
    usePlural: false,
  });
  const database = (options: BetterAuthOptions): DBAdapter<BetterAuthOptions> => {
    return hmacSessionAdapter(adapterFactory(options), config.auth.jwtSecret);
  };

  const auth = betterAuth({
    appName: config.app.name,
    baseURL: canonicalOrigin,
    basePath: BETTER_AUTH_BASE_PATH,
    secret: config.auth.jwtSecret,
    database,
    emailVerification: {
      expiresIn: 3600,
      sendOnSignIn: false,
      sendOnSignUp: false,
      sendVerificationEmail: async ({ user, url }) => sendAuthLinkEmail({
        to: user.email,
        subject: "Verify your Frely email",
        title: "Verify your email",
        description: "Use the button below to verify the email address for your Frely account.",
        action: "Verify email",
        url,
      }),
    },
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      autoSignIn: false,
      requireEmailVerification: false,
      resetPasswordTokenExpiresIn: 3600,
      sendResetPassword: async ({ user, url }) => sendAuthLinkEmail({
        to: user.email,
        subject: "Reset your Frely password",
        title: "Reset your password",
        description: "Use the button below to choose a new password for your Frely account.",
        action: "Reset password",
        url,
      }),
      password: {
        hash: createPasswordHash,
        verify: ({ password, hash }) => verifyPassword(password, hash),
      },
    },
    // Better Auth is invoked only behind Friday's distributed, surface-specific
    // AbuseGuard. Its default in-memory sign-in rule (3 requests per 10 seconds)
    // would otherwise couple invite acceptance to unrelated Web/Owner logins.
    rateLimit: { enabled: false },
    account: {
      accountLinking: {
        enabled: false,
        disableImplicitLinking: true,
      },
      updateAccountOnSignIn: false,
      encryptOAuthTokens: true,
    },
    user: {
      changeEmail: { enabled: false },
      deleteUser: { enabled: false },
    },
    verification: {
      storeIdentifier: "hashed",
      storeInDatabase: true,
    },
    session: {
      storeSessionInDatabase: true,
      expiresIn: config.auth.refreshTokenTtlSeconds,
      updateAge: 86_400,
      freshAge: 86_400,
      cookieCache: { enabled: false },
    },
    advanced: {
      useSecureCookies: config.auth.cookieSecure,
      cookies: {
        session_token: {
          name: BETTER_AUTH_SESSION_COOKIE,
          attributes: {
            httpOnly: true,
            sameSite: "lax",
            path: "/",
          },
        },
      },
      database: {
        generateId: ({ model }) => createId(`auth_${model}`),
      },
    },
    // Façades validate the external Host/origin boundary. Better Auth only
    // receives an in-process request built from this canonical origin.
    trustedOrigins: [canonicalOrigin],
    databaseHooks: {
      session: {
        create: {
          before: async (session) => {
            const controls = await owner.prisma.user_controls.findUnique({
              where: { id: session.userId },
              select: { status: true },
            });
            return controls?.status === "enabled";
          },
        },
      },
      user: {
        update: {
          before: async () => false,
        },
        delete: {
          before: async () => false,
        },
      },
    },
  });

  const loadSession = async (headers: Headers): Promise<BetterAuthSessionResult | null> => {
    const response = await auth.handler(new Request(`${canonicalOrigin}${BETTER_AUTH_BASE_PATH}/get-session`, {
      method: "GET",
      headers: copySessionHeaders(headers),
    }));
    const payload = await readJson(response);
    if (!response.ok || payload === null || !isSessionPayload(payload)) return null;
    return toSessionResult(payload);
  };

  return {
    cookieName: BETTER_AUTH_SESSION_COOKIE,
    signInEmail: async (request, email, password) => {
      const response = await auth.handler(rewriteAuthPath(request, "/sign-in/email", {
        email,
        password,
        rememberMe: true,
      }, canonicalOrigin));
      const payload = await readJson(response);
      if (!response.ok) throw mapBetterAuthError(response.status, payload);
      if (!isSignInPayload(payload)) throw new RelayError("auth_session_invalid", "Authentication session is invalid", 500);
      const cookies = setCookieHeaders(response);
      const session = await loadSession(new Headers({ cookie: cookieHeaderFromSetCookies(cookies) }));
      if (!session) throw new RelayError("auth_session_invalid", "Authentication session is invalid", 500);
      return {
        ...session,
        setCookieHeaders: cookies,
      };
    },
    getSession: loadSession,
    signOut: async (request) => {
      const response = await auth.handler(rewriteAuthPath(request, "/sign-out", {}, canonicalOrigin));
      if (!response.ok) throw mapBetterAuthError(response.status, await readJson(response));
      return setCookieHeaders(response);
    },
    revokeUserSessions: async (userId) => {
      await owner.prisma.session.deleteMany({ where: { userId } });
    },
    createCredentialAccount: async (input) => {
      await owner.prisma.account.create({
        data: {
          id: createId("auth_account"),
          accountId: input.userId,
          providerId: CREDENTIAL_PROVIDER,
          userId: input.userId,
          issuer: CREDENTIAL_ISSUER,
          password: input.passwordHash,
          createdAt: input.createdAt,
          updatedAt: input.updatedAt,
        },
      });
    },
    updateCredentialPassword: async (input) => {
      const result = await owner.prisma.account.updateMany({
        where: {
          userId: input.userId,
          accountId: input.userId,
          providerId: CREDENTIAL_PROVIDER,
          issuer: CREDENTIAL_ISSUER,
          password: input.expectedPasswordHash,
        },
        data: { password: input.newPasswordHash, updatedAt: new Date() },
      });
      return result.count === 1;
    },
    findCredentialPassword: async (userId) => {
      const account = await owner.prisma.account.findFirst({
        where: {
          userId,
          accountId: userId,
          providerId: CREDENTIAL_PROVIDER,
          issuer: CREDENTIAL_ISSUER,
        },
        select: { password: true },
      });
      return account?.password ?? null;
    },
  };
}

function hmacSessionAdapter(base: DBAdapter<BetterAuthOptions>, secret: string): DBAdapter<BetterAuthOptions> {
  const wrap = (adapter: DBAdapter<BetterAuthOptions> | DBTransactionAdapter<BetterAuthOptions>): DBAdapter<BetterAuthOptions> | DBTransactionAdapter<BetterAuthOptions> => {
    const isSessionModel = (model: string): boolean => model === "session";
    const mapToken = (value: unknown): unknown => {
      if (typeof value === "string") return betterAuthSessionTokenHash(value, secret);
      if (Array.isArray(value)) return value.map((item) => typeof item === "string" ? betterAuthSessionTokenHash(item, secret) : item);
      return value;
    };
    const mapWhere = (model: string, where: Where[] | undefined): Where[] | undefined => {
      if (!isSessionModel(model) || !where) return where;
      return where.map((condition) => condition.field === "token"
        ? { ...condition, value: mapToken(condition.value) as Where["value"] }
        : condition) as Where[];
    };
    const restoreToken = <T>(model: string, value: T, rawToken?: string): T => {
      if (!isSessionModel(model) || !rawToken || !value || typeof value !== "object") return value;
      const result = { ...(value as Record<string, unknown>) };
      if (typeof result.token === "string" && result.token === betterAuthSessionTokenHash(rawToken, secret)) result.token = rawToken;
      return result as T;
    };
    const rawTokenFromWhere = (model: string, where: Where[] | undefined): string | undefined => {
      if (!isSessionModel(model)) return undefined;
      const token = where?.find((condition) => condition.field === "token" && (!condition.operator || condition.operator === "eq"))?.value;
      return typeof token === "string" ? token : undefined;
    };
    const wrapped = {
      ...adapter,
      create: async <T extends Record<string, unknown>, R = T>(data: { model: string; data: Omit<T, "id">; select?: string[]; forceAllowId?: boolean }): Promise<R> => {
        const rawToken = isSessionModel(data.model) && typeof data.data.token === "string" ? data.data.token : undefined;
        const created = await adapter.create<T, R>({
          ...data,
          data: {
            ...data.data,
            ...(rawToken ? { token: mapToken(rawToken) } : {}),
          } as Omit<T, "id">,
        });
        return restoreToken(data.model, created, rawToken);
      },
      findOne: async <T>(data: { model: string; where: Where[]; select?: string[]; join?: JoinOption }): Promise<T | null> => {
        const rawToken = rawTokenFromWhere(data.model, data.where);
        const found = await adapter.findOne<T>({ ...data, where: mapWhere(data.model, data.where)! });
        return restoreToken(data.model, found, rawToken);
      },
      findMany: async <T>(data: { model: string; where?: Where[]; limit?: number; select?: string[]; sortBy?: { field: string; direction: "asc" | "desc" }; offset?: number; join?: JoinOption }): Promise<T[]> => {
        return adapter.findMany<T>({ ...data, where: mapWhere(data.model, data.where) });
      },
      update: async <T>(data: { model: string; where: Where[]; update: Record<string, unknown> }): Promise<T | null> => {
        const rawToken = rawTokenFromWhere(data.model, data.where);
        const updated = await adapter.update<T>({ ...data, where: mapWhere(data.model, data.where)!, update: data.update.token === undefined ? data.update : { ...data.update, token: mapToken(data.update.token) } });
        return restoreToken(data.model, updated, rawToken);
      },
      updateMany: (data: { model: string; where: Where[]; update: Record<string, unknown> }) => adapter.updateMany({
        ...data,
        where: mapWhere(data.model, data.where)!,
        update: data.update.token === undefined ? data.update : { ...data.update, token: mapToken(data.update.token) },
      }),
      delete: (data: { model: string; where: Where[] }) => adapter.delete({ ...data, where: mapWhere(data.model, data.where)! }),
      deleteMany: (data: { model: string; where: Where[] }) => adapter.deleteMany({ ...data, where: mapWhere(data.model, data.where)! }),
      consumeOne: async <T>(data: { model: string; where: Where[] }): Promise<T | null> => {
        const rawToken = rawTokenFromWhere(data.model, data.where);
        const consumed = await adapter.consumeOne<T>({ ...data, where: mapWhere(data.model, data.where)! });
        return restoreToken(data.model, consumed, rawToken);
      },
      incrementOne: async <T>(data: { model: string; where: Where[]; increment: Record<string, number>; set?: Record<string, unknown> }): Promise<T | null> => {
        const rawToken = rawTokenFromWhere(data.model, data.where);
        const updated = await adapter.incrementOne<T>({ ...data, where: mapWhere(data.model, data.where)! });
        return restoreToken(data.model, updated, rawToken);
      },
    } as DBAdapter<BetterAuthOptions> | DBTransactionAdapter<BetterAuthOptions>;
    if ("transaction" in adapter && typeof adapter.transaction === "function") {
      const transaction = adapter.transaction;
      (wrapped as DBAdapter<BetterAuthOptions>).transaction = async <R>(callback: (trx: DBTransactionAdapter<BetterAuthOptions>) => Promise<R>) => {
        return transaction((trx) => callback(wrap(trx) as DBTransactionAdapter<BetterAuthOptions>));
      };
    }
    return wrapped;
  };
  return wrap(base) as DBAdapter<BetterAuthOptions>;
}

function rewriteAuthPath(request: ValidatedAuthMutationRequest, path: string, body: Record<string, unknown>, canonicalOrigin: string): Request {
  const url = new URL(`${BETTER_AUTH_BASE_PATH}${path}`, canonicalOrigin);
  const headers = authMutationHeaders(request);
  headers.set("host", url.host);
  headers.set("origin", canonicalOrigin);
  headers.set("content-type", "application/json");
  return new Request(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function copySessionHeaders(headers: Headers): Headers {
  const copied = new Headers();
  for (const name of ["cookie", "user-agent"]) {
    const value = headers.get(name);
    if (value !== null) copied.set(name, value);
  }
  return copied;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function setCookieHeaders(response: Response): string[] {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof headers.getSetCookie === "function") return headers.getSetCookie();
  const value = response.headers.get("set-cookie");
  return value ? [value] : [];
}

function cookieHeaderFromSetCookies(headers: readonly string[]): string {
  return headers.map((header) => header.split(";", 1)[0]).filter(Boolean).join("; ");
}

function isSignInPayload(value: unknown): value is { user: BetterAuthSessionResult["user"] } {
  if (!value || typeof value !== "object") return false;
  const user = (value as Record<string, unknown>).user;
  return Boolean(
    user && typeof user === "object" && typeof (user as Record<string, unknown>).id === "string"
      && typeof (user as Record<string, unknown>).email === "string",
  );
}

function isSessionPayload(value: unknown): value is { user: BetterAuthSessionResult["user"]; session: BetterAuthSessionResult["session"] } {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  const user = record.user;
  const session = record.session;
  return Boolean(
    user && typeof user === "object" && typeof (user as Record<string, unknown>).id === "string" && typeof (user as Record<string, unknown>).email === "string"
      && session && typeof session === "object" && typeof (session as Record<string, unknown>).id === "string" && typeof (session as Record<string, unknown>).userId === "string",
  );
}

function toSessionResult(payload: { user: BetterAuthSessionResult["user"]; session: BetterAuthSessionResult["session"] }): BetterAuthSessionResult {
  return {
    user: {
      id: payload.user.id,
      email: payload.user.email,
      name: payload.user.name,
      emailVerified: payload.user.emailVerified,
      createdAt: new Date(payload.user.createdAt),
      updatedAt: new Date(payload.user.updatedAt),
    },
    session: {
      id: payload.session.id,
      userId: payload.session.userId,
      expiresAt: new Date(payload.session.expiresAt),
      createdAt: new Date(payload.session.createdAt),
      updatedAt: new Date(payload.session.updatedAt),
    },
  };
}

function mapBetterAuthError(status: number, payload: unknown): RelayError {
  const code = payload && typeof payload === "object" && typeof (payload as Record<string, unknown>).code === "string"
    ? (payload as Record<string, unknown>).code
    : "";
  if (status === 401 || code === "INVALID_EMAIL_OR_PASSWORD" || code === "INVALID_EMAIL") {
    return new RelayError("invalid_credentials", "Invalid email or password", 401);
  }
  if (status === 403) return new RelayError("forbidden", "Authentication is not allowed", 403);
  if (status === 429) return new RelayError("rate_limited", "Too many authentication attempts", 429);
  return new RelayError("auth_provider_error", "Authentication failed", status >= 400 && status < 500 ? status : 500);
}
