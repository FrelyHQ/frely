type AsyncMethod = (...args: any[]) => any;
type CrossContextCommandName =
  | "useCard" | "purchasePlanCard" | "createPlanPurchaseOrder" | "completeStripePlanPurchaseOrder"
  | "reversePlanPurchaseOrder" | "approveCreditTopup" | "completeStripeCreditTopup" | "reverseCreditTopup"
  | "retryServiceOrderFulfillment" | "consumePartnerTeamCreationAllocation";
type CrossContextPort = Record<CrossContextCommandName, AsyncMethod>;
type Arguments<P, Name extends keyof P> = P[Name] extends (...args: infer A) => unknown ? A : never;
type Result<P, Name extends keyof P> = P[Name] extends (...args: any[]) => infer R ? R : never;

/**
 * Explicit Billing/Commerce application coordinators for workflows whose
 * current compatibility transaction also creates or cancels Entitlement or
 * Tenancy results. The port is bounded to named Commands and exposes no
 * generic transaction, posting, ApplicationOperationPort, or Unit-of-Work API.
 */
export class BillingCommerceApplicationService<P extends CrossContextPort> {
  constructor(readonly commands: P) {}

  useCard(...args: Arguments<P, "useCard">): Result<P, "useCard"> { return this.commands.useCard(...args); }
  purchasePlanCard(...args: Arguments<P, "purchasePlanCard">): Result<P, "purchasePlanCard"> { return this.commands.purchasePlanCard(...args); }
  createPlanPurchaseOrder(...args: Arguments<P, "createPlanPurchaseOrder">): Result<P, "createPlanPurchaseOrder"> { return this.commands.createPlanPurchaseOrder(...args); }
  completeStripePlanPurchaseOrder(...args: Arguments<P, "completeStripePlanPurchaseOrder">): Result<P, "completeStripePlanPurchaseOrder"> { return this.commands.completeStripePlanPurchaseOrder(...args); }
  reversePlanPurchaseOrder(...args: Arguments<P, "reversePlanPurchaseOrder">): Result<P, "reversePlanPurchaseOrder"> { return this.commands.reversePlanPurchaseOrder(...args); }
  approveCreditTopup(...args: Arguments<P, "approveCreditTopup">): Result<P, "approveCreditTopup"> { return this.commands.approveCreditTopup(...args); }
  completeStripeCreditTopup(...args: Arguments<P, "completeStripeCreditTopup">): Result<P, "completeStripeCreditTopup"> { return this.commands.completeStripeCreditTopup(...args); }
  reverseCreditTopup(...args: Arguments<P, "reverseCreditTopup">): Result<P, "reverseCreditTopup"> { return this.commands.reverseCreditTopup(...args); }
  retryServiceOrderFulfillment(...args: Arguments<P, "retryServiceOrderFulfillment">): Result<P, "retryServiceOrderFulfillment"> { return this.commands.retryServiceOrderFulfillment(...args); }
  consumePartnerTeamCreationAllocation(...args: Arguments<P, "consumePartnerTeamCreationAllocation">): Result<P, "consumePartnerTeamCreationAllocation"> { return this.commands.consumePartnerTeamCreationAllocation(...args); }
}
