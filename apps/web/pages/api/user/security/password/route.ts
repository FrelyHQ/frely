import { assertPasswordChangeRequestOrigin, createValidatedAuthMutationRequest, passwordChangeRateLimitSubjects, readPasswordChangeRequestBody } from "@frely/auth";
import { RelayError, requestIdFromHeaders } from "@frely/core";
import { handle, json, services } from "../../../../../lib/server";

export async function POST(request: Request) {
  const response = await handle(request, async ({ hostScope }) => {
    const { asyncTenancy, application, config } = await services();
    assertPasswordChangeRequestOrigin(request, config, hostScope.publicOrigin);
    const authRequest = createValidatedAuthMutationRequest(request, hostScope.publicOrigin);
    const claims = await asyncTenancy.requireCookieUser(request.headers);
    const requestId = requestIdFromHeaders(request.headers);
    const subjects = passwordChangeRateLimitSubjects(config, request.headers, claims.sub);
    let decision;
    try {
      decision = await application.commands.consumeAbuseRateLimits({
        rules: [
          { id: "user", bucket: "password_change.user", subjectHashes: [subjects.user], limit: 5, windowSeconds: 900 },
          { id: "client_ip", bucket: "password_change.client_ip", subjectHashes: [subjects.clientIp], limit: 20, windowSeconds: 900 }
        ]
      });
    } catch (error) {
      await auditRequestFailure({ application }, claims.sub, requestId, error);
      throw error;
    }
    if (!decision.allowed) {
      const bucketCategory = rateLimitBucketCategory(decision.deniedRuleIds);
      const auditInput = {
        actor: { actorType: "user", actorId: claims.sub },
        action: "auth.password_change",
        resource: { resourceType: "user", resourceId: claims.sub },
        result: "denied",
        source: "web",
        requestId,
        metadata: { bucketCategory }
      } as const;
      await application.audit.record(auditInput);
      const error = new RelayError("rate_limited", "Too many requests", 429) as RelayError & { retryAfterSeconds: number };
      error.retryAfterSeconds = decision.retryAfterSeconds;
      throw error;
    }
    let body;
    try {
      body = await readPasswordChangeRequestBody(request);
    } catch (error) {
      await auditRequestFailure({ application }, claims.sub, requestId, error);
      throw error;
    }
    try {
      const session = await asyncTenancy.changeOwnPasswordWithBetterAuth({
        userId: claims.sub,
        surface: "web",
        currentPassword: body.currentPassword,
        newPassword: body.newPassword,
        request: authRequest,
        requestId
      });
      const result = json({ changed: true, otherSessionsRevoked: true });
      for (const cookie of session.setCookieHeaders) result.headers.append("set-cookie", cookie);
      return result;
    } catch (error) {
      await auditRequestFailure({ application }, claims.sub, requestId, error);
      throw error;
    }
  }, { passwordChangeHostBoundary: true, passwordChangeSafeErrors: true });
  response.headers.set("cache-control", "no-store");
  return response;
}

type PasswordApp = Pick<Awaited<ReturnType<typeof services>>, "application">;

async function auditRequestFailure(app: PasswordApp, userId: string, requestId: string, error: unknown): Promise<void> {
  const failureCategory = error instanceof RelayError ? error.code : "internal_error";
  const input = {
    actor: { actorType: "user", actorId: userId },
    action: "auth.password_change",
    resource: { resourceType: "user", resourceId: userId },
    result: "failure",
    source: "web",
    requestId,
    metadata: { failureCategory }
  } as const;
  await app.application.audit.record(input);
}

function rateLimitBucketCategory(deniedRuleIds: string[]): "user" | "client_ip" | "both" {
  return deniedRuleIds.length > 1 ? "both" : deniedRuleIds[0] === "client_ip" ? "client_ip" : "user";
}
