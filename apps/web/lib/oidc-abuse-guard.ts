import type { AsyncAbuseGuard } from "@frely/tenancy";

export type OidcAbuseBucket =
  | "authorize.attempt"
  | "authorize.failure"
  | "token.attempt"
  | "token.failure"
  | "revoke.attempt"
  | "revoke.failure"
  | "userinfo.failure";

export class AsyncOidcAbuseGuard {
  constructor(private readonly guard: AsyncAbuseGuard) {}

  consume(bucket: OidcAbuseBucket, headers: Headers): Promise<void> {
    return this.guard.consume(`oidc.${bucket}`, headers, { routePattern: `/oidc/${bucket.split(".")[0]}` });
  }
}
