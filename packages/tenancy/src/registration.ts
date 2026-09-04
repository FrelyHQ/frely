import type { AppConfig } from "@frely/config";
import { RelayError } from "@frely/core";
import type { AsyncApplicationOperationPort } from "@frely/application/runtime";
import type { TenancyQueries } from "./server.js";

export type RegistrationEntryKind = "global" | "domain_binding";

export interface RegistrationTarget {
  entryKind: RegistrationEntryKind;
  teamId: string;
  teamName: string;
  registrationInviteLinkId: string;
  domainBindingId: string | null;
}

export type RegistrationTargetContext =
  | { entryKind: "global"; canonicalOrigin?: string }
  | { entryKind: "domain_binding"; canonicalOrigin?: string; domainBindingId: string; hostname: string };

export interface RegistrationTargetView {
  entryKind: RegistrationEntryKind;
  teamName: string;
}

export type AsyncRegistrationTargetApplicationOperationPort = Pick<AsyncApplicationOperationPort,
  | "getWebRegistrationSetting"
  | "resolveActiveDomainBinding"
>;
export type RegistrationTenancyQueries = Pick<TenancyQueries, "getTeam" | "getInviteLink" | "isTeamAvailable">;

/** Read-only registration target resolution for the shared async runtime. */
export class AsyncRegistrationTargetService {
  constructor(
    readonly repo: AsyncRegistrationTargetApplicationOperationPort,
    readonly tenancy: RegistrationTenancyQueries,
    readonly config: AppConfig,
  ) {}

  async resolve(context: RegistrationTargetContext): Promise<RegistrationTarget | null> {
    if (context.canonicalOrigin !== undefined && !sameOrigin(context.canonicalOrigin, this.config.app.publicBaseUrl)) return null;
    if (context.entryKind === "global") return this.resolveGlobal();
    return this.resolvePartner(context);
  }

  private async resolveGlobal(): Promise<RegistrationTarget | null> {
    const setting = await this.repo.getWebRegistrationSetting();
    if (!setting?.defaultTeamId || !setting.registrationInviteLinkId) return null;
    return this.validatedTarget("global", setting.defaultTeamId, setting.registrationInviteLinkId, null);
  }

  private async resolvePartner(context: Extract<RegistrationTargetContext, { entryKind: "domain_binding" }>): Promise<RegistrationTarget | null> {
    let binding;
    try {
      binding = await this.repo.resolveActiveDomainBinding(context.hostname);
    } catch {
      return null;
    }
    if (!binding || binding.id !== context.domainBindingId) return null;
    if (!binding.defaultRegistrationTeamId || !binding.registrationInviteLinkId || !binding.teamIds.includes(binding.defaultRegistrationTeamId)) return null;
    return this.validatedTarget("domain_binding", binding.defaultRegistrationTeamId, binding.registrationInviteLinkId, binding.id);
  }

  private async validatedTarget(entryKind: RegistrationEntryKind, teamId: string, registrationInviteLinkId: string, domainBindingId: string | null): Promise<RegistrationTarget | null> {
    const [team, invite, available] = await Promise.all([
      this.tenancy.getTeam(teamId),
      this.tenancy.getInviteLink(registrationInviteLinkId),
      this.tenancy.isTeamAvailable(teamId)
    ]);
    if (!team || !available || !invite || invite.status !== "enabled" || invite.teamId !== teamId) return null;
    if (invite.usedCount === null || (invite.maxUses !== null && invite.usedCount >= invite.maxUses)) return null;
    return { entryKind, teamId, teamName: team.name, registrationInviteLinkId, domainBindingId };
  }
}

export function registrationTargetView(target: RegistrationTarget): RegistrationTargetView {
  return { entryKind: target.entryKind, teamName: target.teamName };
}

export function registrationUnavailable(): RelayError {
  return new RelayError("registration_unavailable", "Registration is unavailable", 404);
}

function sameOrigin(left: string, right: string): boolean {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
}
