import { landingRegistrationEntryFromHeaders, type LandingEntryStateClaims } from "@frely/auth";
import { AsyncRegistrationTargetService, type RegistrationTarget, type RegistrationTargetContext } from "@frely/tenancy";
import type { AsyncRegistrationTargetApplicationOperationPort, RegistrationTenancyQueries } from "@frely/tenancy";
import type { AppConfig } from "@frely/config";
import type { WebHostScope } from "./domain-binding";

export type WebRegistrationEntry = "global" | "partner";

export interface WebRegistrationResolution {
  target: RegistrationTarget | null;
  state: LandingEntryStateClaims | null;
  context: RegistrationTargetContext | null;
}

export async function resolveWebRegistrationTargetAsync(input: {
  repo: AsyncRegistrationTargetApplicationOperationPort;
  tenancy: RegistrationTenancyQueries;
  config: AppConfig;
  headers: Headers;
  hostScope: WebHostScope;
  entry: WebRegistrationEntry | null;
}): Promise<WebRegistrationResolution> {
  const { repo, tenancy, config, headers, hostScope, entry } = input;
  const canonicalOrigin = new URL(config.app.publicBaseUrl).origin;
  if (hostScope.kind !== "platform") return { target: null, state: null, context: null };
  if (entry === "partner") {
    if (hostScope.publicOrigin !== canonicalOrigin) return { target: null, state: null, context: null };
    const state = landingRegistrationEntryFromHeaders(config, headers);
    if (!state) return { target: null, state: null, context: null };
    const context: RegistrationTargetContext = {
      entryKind: "domain_binding",
      domainBindingId: state.domainBindingId,
      hostname: state.hostname,
      canonicalOrigin: state.canonicalOrigin
    };
    return { target: await new AsyncRegistrationTargetService(repo, tenancy, config).resolve(context), state, context };
  }
  const context: RegistrationTargetContext = { entryKind: "global", canonicalOrigin };
  return { target: await new AsyncRegistrationTargetService(repo, tenancy, config).resolve(context), state: null, context };
}

export async function resolveLegacyPartnerRegistrationTargetAsync(input: {
  repo: AsyncRegistrationTargetApplicationOperationPort;
  tenancy: RegistrationTenancyQueries;
  config: AppConfig;
  hostScope: WebHostScope;
}): Promise<WebRegistrationResolution> {
  if (input.hostScope.kind !== "domain") return { target: null, state: null, context: null };
  const context: RegistrationTargetContext = {
    entryKind: "domain_binding",
    domainBindingId: input.hostScope.binding.id,
    hostname: input.hostScope.hostname,
    canonicalOrigin: input.config.app.publicBaseUrl
  };
  return { target: await new AsyncRegistrationTargetService(input.repo, input.tenancy, input.config).resolve(context), state: null, context };
}
