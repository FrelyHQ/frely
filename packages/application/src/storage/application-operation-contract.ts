import { nowIso } from "@frely/core";
import type { AsyncApplicationOperationPort } from "./async-application-operation-port.js";

/**
 * The first adapter-neutral contract is intentionally small and explicit. It
 * covers the control-plane records needed to prove identity, API-key and
 * provider catalog parity without claiming that the entire legacy ApplicationOperationPort
 * has already been ported to PostgreSQL.
 */
export type ApplicationOperationPortContractMethods = Pick<AsyncApplicationOperationPort,
  | "backend"
  | "getTeam"
  | "listTeams"
  | "upsertTeam"
  | "getUser"
  | "listUsers"
  | "getUserByEmail"
  | "upsertUser"
  | "getTeamMembership"
  | "grantTeamMembership"
  | "getOrCreateActiveTeamInviteLink"
  | "getTeamInviteLink"
  | "consumeTeamInviteLinkUse"
  | "getApiKeyByHash"
  | "listApiKeys"
  | "createApiKey"
  | "getProvider"
  | "listProviders"
  | "upsertProvider"
  | "getProviderModel"
  | "listProviderModels"
  | "upsertProviderModel"
  | "getPlan"
  | "listPlanDefinitions"
  | "listPlanBudgetLimits"
  | "createPlanDefinition"
>;

export interface ApplicationOperationPortContractExecution {
  repository: ApplicationOperationPortContractMethods;
  withTransaction<T>(callback: (repository: ApplicationOperationPortContractMethods) => Promise<T>): Promise<T>;
}

export interface ApplicationOperationPortContractResult {
  backend: "postgres";
  rolledBack: boolean;
  teamId: string;
  userId: string;
  apiKeyId: string;
  providerId: string;
  providerModelId: string;
  planId: string;
}

const ROLLBACK_SENTINEL = "repository_contract_rollback";

/**
 * Runs the adapter-neutral fixture against PostgreSQL. The fixture is
 * deliberately rolled back so a contract gate never leaves rows behind.
 */
export async function runApplicationOperationPortContract(execution: ApplicationOperationPortContractExecution, prefix: string): Promise<ApplicationOperationPortContractResult> {
  if (!/^[a-z][a-z0-9_]{0,40}$/u.test(prefix)) throw new Error("repository_contract_prefix_invalid");
  const now = nowIso();
  const teamId = `${prefix}_team`;
  const userId = `${prefix}_user`;
  const apiKeyId = `${prefix}_key`;
  const providerId = `${prefix}_provider`;
  const providerModelId = `${prefix}_provider_model`;
  const planId = `${prefix}_plan`;
  let rolledBack = false;

  try {
    await execution.withTransaction(async (transaction) => {
      const team = await transaction.upsertTeam({ id: teamId, ownerId: `${prefix}_owner`, name: "ApplicationOperationPort contract team", createdAt: now });
      const user = await transaction.upsertUser({
        id: userId,
        teamId: team.id,
        email: `${prefix}@invalid.test`,
        passwordHash: "contract-only-placeholder",
        createMembership: false,
        createdAt: now,
      });
      if (user.teamId !== team.id || (await transaction.getUserByEmail(user.email))?.id !== user.id) throw new Error("repository_contract_identity_readback_failed");
      if (!(await transaction.listTeams()).some((candidate) => candidate.id === team.id)) throw new Error("repository_contract_team_list_readback_failed");
      if (!(await transaction.listUsers()).some((candidate) => candidate.id === user.id)) throw new Error("repository_contract_user_list_readback_failed");

      const membership = await transaction.grantTeamMembership(team.id, user.id);
      if ((await transaction.getTeamMembership(team.id, user.id))?.id !== membership.id) throw new Error("repository_contract_membership_readback_failed");
      const invite = await transaction.getOrCreateActiveTeamInviteLink(team.id, user.id, 1);
      if ((await transaction.getTeamInviteLink(invite.inviteLink.id))?.id !== invite.inviteLink.id) throw new Error("repository_contract_invite_readback_failed");
      const consumedInvite = await transaction.consumeTeamInviteLinkUse(invite.inviteLink.id);
      if (consumedInvite.status !== "disabled" || consumedInvite.usedCount !== 1) throw new Error("repository_contract_invite_consume_failed");

      const apiKey = await transaction.createApiKey({
        userId: user.id,
        name: "ApplicationOperationPort contract key",
        keyHash: `${prefix}_hash`,
        keyPrefix: "fr_contract",
        keyValue: "contract-only-placeholder",
      });
      if ((await transaction.getApiKeyByHash(apiKey.keyHash))?.id !== apiKey.id) throw new Error("repository_contract_api_key_readback_failed");
      if (!(await transaction.listApiKeys(user.id)).some((candidate) => candidate.id === apiKey.id)) throw new Error("repository_contract_api_key_list_readback_failed");

      const provider = await transaction.upsertProvider({
        id: providerId,
        ownerId: user.id,
        scopeRef: `user:${user.id}`,
        name: "ApplicationOperationPort contract provider",
        kind: "contract",
        baseUrlResolver: "identity:contract",
        credentialResolver: "identity:contract",
        modelsResolver: "identity:contract",
        createdAt: now,
      });
      const providerModel = await transaction.upsertProviderModel({
        id: providerModelId,
        providerId: provider.id,
        providerModelName: "contract-model",
        createdAt: now,
      });
      if ((await transaction.getProviderModel(provider.id, providerModel.providerModelName))?.id !== providerModel.id) throw new Error("repository_contract_provider_readback_failed");
      if (!(await transaction.listProviders()).some((candidate) => candidate.id === provider.id)) throw new Error("repository_contract_provider_list_readback_failed");
      if (!(await transaction.listProviderModels()).some((candidate) => candidate.id === providerModel.id)) throw new Error("repository_contract_provider_model_list_readback_failed");

      const plan = await transaction.createPlanDefinition({
        id: planId,
        ownerId: user.id,
        scopeRef: `user:${user.id}`,
        name: "ApplicationOperationPort contract plan",
        durationSeconds: 3600,
        createdAt: now,
        // REQ-OPS-006: related Plan writes must share the adapter-neutral transaction.
        budgetLimits: [{ limitScope: "subscription", metric: "tokens", limitValue: 10_000, windowType: "cumulative", windowSeconds: null }],
      });
      if ((await transaction.getPlan(plan.id))?.id !== plan.id) throw new Error("repository_contract_plan_readback_failed");
      if (!(await transaction.listPlanDefinitions()).some((candidate) => candidate.id === plan.id)) throw new Error("repository_contract_plan_list_readback_failed");
      const planBudgetLimits = await transaction.listPlanBudgetLimits(plan.id);
      if (planBudgetLimits.length !== 1 || planBudgetLimits[0]?.metric !== "tokens" || planBudgetLimits[0].limitValue !== 10_000) throw new Error("repository_contract_plan_budget_readback_failed");
      throw new Error(ROLLBACK_SENTINEL);
    });
  } catch (error) {
    if (!(error instanceof Error) || error.message !== ROLLBACK_SENTINEL) throw error;
    rolledBack = true;
  }

  if (!rolledBack) throw new Error("repository_contract_transaction_did_not_rollback");
  if (await execution.repository.getTeam(teamId) || await execution.repository.getUser(userId) || await execution.repository.getApiKeyByHash(`${prefix}_hash`) || await execution.repository.getProvider(providerId) || await execution.repository.getPlan(planId)) {
    throw new Error("repository_contract_rollback_readback_failed");
  }
  return { backend: execution.repository.backend, rolledBack, teamId, userId, apiKeyId, providerId, providerModelId, planId };
}
