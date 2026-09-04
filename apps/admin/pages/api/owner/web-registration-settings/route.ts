import { RelayError, requestIdFromHeaders } from "@frely/core";
import { actorFromClaims, auditFailureAsync, auditSuccessAsync } from "@frely/ui-application/server";
import type { UiQueryPort } from "@frely/ui-application/contracts";
import type { TenancyQueries } from "@frely/tenancy/server";
import { bodyJson, handle, json, services } from "../../../../lib/server";
import type { WebRegistrationSettingView } from "../../../../features/web-registration/types";

export async function GET(request: Request) {
  return handle(request, async () => {
    const { asyncTenancy, application} = await services();
    await asyncTenancy.requireOwner(request.headers);
    return json(await webRegistrationSettingViewAsync(application.queries, asyncTenancy.tenancy));
  });
}

export async function PATCH(request: Request) {
  return handle(request, async () => {
    const { asyncTenancy, application} = await services();
    const claims = await asyncTenancy.requireOwner(request.headers);
    const requestId = requestIdFromHeaders(request.headers);
    try {
      const body = await bodyJson<unknown>(request);
      assertExactKeys(body);
      const teamId = body.teamId;
      if (teamId !== null && (typeof teamId !== "string" || teamId.trim().length === 0)) {
        throw new RelayError("invalid_web_registration_setting", "teamId must be a Team id or null", 400);
      }
      const nextTeamId = typeof teamId === "string" ? teamId : null;
      {
        const current = await application.queries.getWebRegistrationSetting();
        let nextInviteId: string | null = null;
        if (nextTeamId !== null) {
          const team = await asyncTenancy.tenancy.getTeam(nextTeamId);
          if (!team || !(await asyncTenancy.tenancy.isTeamAvailable(team.id))) throw new RelayError("registration_team_unavailable", "The selected Team is unavailable", 409);
          const currentInvite = current?.defaultTeamId === team.id && current.registrationInviteLinkId
            ? await asyncTenancy.tenancy.getInviteLink(current.registrationInviteLinkId)
            : undefined;
          const reusable = currentInvite
            && currentInvite.status === "enabled"
            && currentInvite.teamId === team.id
            && currentInvite.maxUses === null
            && currentInvite.activeLimitExempt === 1
            && currentInvite.usedCount !== null;
          if (reusable) nextInviteId = currentInvite.id;
          else nextInviteId = (await asyncTenancy.createTeamInviteLink(team.id, { actor: actorFromClaims(claims), source: "owner", requestId })).inviteLink.id;
        }
        if (current?.registrationInviteLinkId && current.registrationInviteLinkId !== nextInviteId && current.defaultTeamId) {
          const oldInvite = await asyncTenancy.tenancy.getInviteLink(current.registrationInviteLinkId);
          if (oldInvite?.status === "enabled") await asyncTenancy.disableTeamInviteLink(current.defaultTeamId, oldInvite.id, { actor: actorFromClaims(claims), source: "owner", requestId });
        }
        await application.commands.updateWebRegistrationSetting({ defaultTeamId: nextTeamId, registrationInviteLinkId: nextInviteId, updatedByUserId: claims.sub });
        await auditSuccessAsync(application.audit, {
          actor: actorFromClaims(claims), source: "owner", requestId,
          action: "web_registration_setting.update",
          resource: { resourceType: "web_registration_setting", resourceId: "global" },
          metadata: { previousTeamId: current?.defaultTeamId ?? null, teamId: nextTeamId, previousRegistrationInviteLinkId: current?.registrationInviteLinkId ?? null, registrationInviteLinkId: nextInviteId, enabled: nextTeamId !== null }
        });
        return json(await webRegistrationSettingViewAsync(application.queries, asyncTenancy.tenancy));
      }
    } catch (error) {
      const failure = {
        actor: actorFromClaims(claims),
        source: "owner",
        requestId,
        action: "web_registration_setting.update",
        resource: { resourceType: "web_registration_setting", resourceId: "global" },
        metadata: { routePattern: "/api/owner/web-registration-settings" },
        error
      } as const;
      await auditFailureAsync(application.audit, failure);
      throw error;
    }
  });
}

function assertExactKeys(body: unknown): asserts body is { teamId: string | null } {
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1 || !Object.hasOwn(body, "teamId")) {
    throw new RelayError("invalid_web_registration_setting", "Body must contain only teamId", 400);
  }
}

async function webRegistrationSettingViewAsync(
  repo: Pick<UiQueryPort, "getWebRegistrationSetting">,
  tenancy: Pick<TenancyQueries, "getTeam" | "getInviteLink" | "isTeamAvailable">,
): Promise<WebRegistrationSettingView> {
  const setting = await repo.getWebRegistrationSetting();
  if (!setting) throw new RelayError("web_registration_setting_not_found", "Web registration setting not found", 500);
  const team = setting.defaultTeamId ? await tenancy.getTeam(setting.defaultTeamId) : undefined;
  const invite = setting.registrationInviteLinkId ? await tenancy.getInviteLink(setting.registrationInviteLinkId) : undefined;
  const configured = Boolean(setting.defaultTeamId && setting.registrationInviteLinkId);
  const enabled = Boolean(configured && team && await tenancy.isTeamAvailable(team.id) && invite && invite.status === "enabled" && invite.teamId === team.id && invite.usedCount !== null && (invite.maxUses === null || invite.usedCount < invite.maxUses));
  return { enabled, configured, team: team ? { id: team.id, name: team.name } : null, updatedAt: setting.updatedAt };
}
