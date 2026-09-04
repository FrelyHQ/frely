import { createHash, randomBytes } from "node:crypto";
import { Resolver } from "node:dns/promises";
import { createId, nowIso, RelayError } from "@frely/core";
import type { ApplicationOperationPort } from "./application-operation-port.js";
import { normalizePublicHostname } from "./public-host.js";

export type DomainBindingStatus = "pending_verification" | "verified" | "active" | "disabled" | "released";

export interface DomainBinding {
  id: string; hostname: string; ownerUserId: string; slotId: string;
  defaultRegistrationTeamId: string | null; registrationInviteLinkId: string | null;
  status: DomainBindingStatus; verificationMethod: "dns_txt"; verifiedAt: string | null;
  activatedAt: string | null; disabledAt: string | null; releasedAt: string | null;
  createdAt: string; updatedAt: string;
}
export interface ActiveDomainBinding extends DomainBinding { teamIds: string[]; }

const SELECT_BINDING = `SELECT id,hostname,owner_user_id AS ownerUserId,slot_id AS slotId,default_registration_team_id AS defaultRegistrationTeamId,registration_invite_link_id AS registrationInviteLinkId,status,verification_method AS verificationMethod,verified_at AS verifiedAt,activated_at AS activatedAt,disabled_at AS disabledAt,released_at AS releasedAt,created_at AS createdAt,updated_at AS updatedAt FROM domain_bindings`;

export function normalizeDomainHostname(value: string): string {
  try {
    return normalizePublicHostname(value);
  } catch (error) {
    if (error instanceof RelayError && error.code === "public_host_hostname_reserved") {
      throw new RelayError("domain_binding_hostname_reserved", "This hostname cannot be bound", 400);
    }
    throw new RelayError("domain_binding_hostname_invalid", "A valid public hostname is required", 400);
  }
}
function hash(value: string): string { return createHash("sha256").update(value,"utf8").digest("hex"); }
