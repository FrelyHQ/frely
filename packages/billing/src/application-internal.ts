export * from "./commerce-application-internal.js";

import type { Prisma } from "@frely/postgres/server";
import type {
  ClaimlessInvocationBillingFinancialTerms,
  ClaimlessInvocationBillingFinancialTermsInput,
  InvocationBillingAdmissionFundingInput,
  InvocationBillingBudgetInput,
  InvocationBillingFinancialTerms,
  InvocationBillingFinancialTermsInput,
  InvocationBillingOccupationInput,
  InvocationBillingOccupationSnapshot,
  InvocationBillingSettlementResult,
  SettleInvocationBillingCommand,
  TransitionInvocationReconciliationInput,
  UsageReconciliationProjection,
} from "./invocation-contracts.js";
import {
  AdmitInvocationBilling,
  ListUsageReconciliations,
  PrepareClaimlessInvocationBilling,
  SettleInvocationBilling,
  TransitionInvocationReconciliation,
} from "./server.js";

export interface InvocationFundingLock {
  readonly id: string;
  readonly status: string;
  readonly balanceSnapUnits: bigint;
}

export interface BoundInvocationAdmissionParticipant {
  readonly userPaygoConcurrencyLimit: number;
  lockAdmissionFunding(input: InvocationBillingAdmissionFundingInput): Promise<InvocationFundingLock | null>;
  assertCapacity(input: { account: InvocationFundingLock; userId: string; requiredUnits: bigint; now: string }): Promise<void>;
  assertPlanBudgets(input: InvocationBillingBudgetInput): Promise<void>;
  assertDirectBudgets(input: InvocationBillingBudgetInput): Promise<void>;
  readOccupation(billableInvocationRef: string): Promise<InvocationBillingOccupationSnapshot>;
  prepareFinancialTerms(input: InvocationBillingFinancialTermsInput): Promise<InvocationBillingFinancialTerms>;
  execute(input: InvocationBillingOccupationInput): Promise<{ usageReservationId: string | null }>;
}

export interface BoundClaimlessInvocationPreparationParticipant {
  execute(input: ClaimlessInvocationBillingFinancialTermsInput): Promise<ClaimlessInvocationBillingFinancialTerms>;
}

export interface BoundInvocationSettlementParticipant {
  lockFunding(billableInvocationRef: string): Promise<InvocationFundingLock | null>;
  execute(input: SettleInvocationBillingCommand & { account: InvocationFundingLock | null }): Promise<InvocationBillingSettlementResult>;
}

export interface BoundInvocationReconciliationParticipant {
  lockFunding(billableInvocationRef: string): Promise<InvocationFundingLock | null>;
  execute(input: TransitionInvocationReconciliationInput): Promise<void>;
}

export interface BoundUsageReconciliationQueries {
  list(limit?: number): Promise<UsageReconciliationProjection[]>;
  listForBillableInvocationRefs(billableInvocationRefs: string[]): Promise<UsageReconciliationProjection[]>;
}

export interface BoundBillingInvocationParticipants {
  admission: BoundInvocationAdmissionParticipant;
  claimlessPreparation: BoundClaimlessInvocationPreparationParticipant;
  settlement: BoundInvocationSettlementParticipant;
  reconciliation: BoundInvocationReconciliationParticipant;
  unresolved: BoundUsageReconciliationQueries;
}

export function bindBillingInvocationParticipants(
  transaction: Prisma.TransactionClient,
  userPaygoConcurrencyLimit: number,
): BoundBillingInvocationParticipants {
  const admission = new AdmitInvocationBilling(userPaygoConcurrencyLimit);
  const claimlessPreparation = new PrepareClaimlessInvocationBilling();
  const settlement = new SettleInvocationBilling();
  const reconciliation = new TransitionInvocationReconciliation();
  const unresolved = new ListUsageReconciliations();
  return Object.freeze({
    admission: Object.freeze({
      userPaygoConcurrencyLimit,
      lockAdmissionFunding: admission.lockAdmissionFunding.bind(admission, transaction),
      assertCapacity: admission.assertCapacity.bind(admission, transaction),
      assertPlanBudgets: admission.assertPlanBudgets.bind(admission, transaction),
      assertDirectBudgets: admission.assertDirectBudgets.bind(admission, transaction),
      readOccupation: admission.readOccupation.bind(admission, transaction),
      prepareFinancialTerms: admission.prepareFinancialTerms.bind(admission, transaction),
      execute: admission.execute.bind(admission, transaction),
    }),
    claimlessPreparation: Object.freeze({ execute: claimlessPreparation.execute.bind(claimlessPreparation, transaction) }),
    settlement: Object.freeze({
      lockFunding: settlement.lockFunding.bind(settlement, transaction),
      execute: settlement.execute.bind(settlement, transaction),
    }),
    reconciliation: Object.freeze({
      lockFunding: reconciliation.lockFunding.bind(reconciliation, transaction),
      execute: reconciliation.execute.bind(reconciliation, transaction),
    }),
    unresolved: Object.freeze({
      list: unresolved.execute.bind(unresolved, transaction),
      listForBillableInvocationRefs: unresolved.executeForBillableInvocationRefs.bind(unresolved, transaction),
    }),
  });
}
