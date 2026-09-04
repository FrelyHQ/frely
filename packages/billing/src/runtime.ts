type AsyncMethod = (...args: any[]) => any;
type PortFor<Names extends string> = Record<Names, AsyncMethod>;
type Arguments<P, Name extends keyof P> = P[Name] extends (...args: infer A) => unknown ? A : never;
type Result<P, Name extends keyof P> = P[Name] extends (...args: any[]) => infer R ? R : never;

export type BillingCommerceQueryName =
  | "pageEnabledServiceProducts" | "listServiceProducts" | "listServiceProductListings"
  | "pageAdminCreditUserAccounts" | "pageAdminNonUserCreditAccounts" | "getAdminCreditDirectorySummary"
  | "getAdminCreditConfigurationSummary" | "pageDraftPaymentChannels"
  | "getServiceProduct" | "getServiceProductListing" | "getServiceOrder" | "listServiceOrdersForBuyer"
  | "listServiceOrders" | "listServiceFulfillments" | "getPartnerTeamCreationAllocation"
  | "listAvailablePartnerTeamCreationAllocations" | "pageUserCreditCatalog" | "pageCreditAccounts"
  | "pageCardTransfers" | "pageCreditProducts" | "pagePaymentChannels" | "pageCreditProductListings"
  | "pageCreditTransferPolicies" | "searchCreditProductCandidates" | "searchPaymentChannelCandidates"
  | "pageUserCardInventory" | "pageUserPlanCards" | "pageUserCardTransfers" | "getTopupAttachment"
  | "isEnabledPaymentChannelListed" | "pageTopupAttachments" | "cursorUserTopups" | "cursorAdminTopups"
  | "cursorCreditLedger" | "getCreditAccount" | "findCreditAccountForScope" | "getCreditAccountBalanceUnits"
  | "getCreditAccountBalance" | "listCreditLedgerEventsForAccount" | "getCreditProduct"
  | "getPaymentChannel" | "listPaymentChannelInstructionAttachments" | "getPaymentChannelInstructionAttachment"
  | "getCreditProductListing"
  | "getCard" | "listCardActivationBatches" | "getCardActivationBatchDetail" | "getCardActivationStats"
  | "previewCardActivationCode" | "getPlanPurchaseOrder" | "getPlanPurchaseOrderForUser" | "pagePlanPurchaseOrders"
  | "getCreditTopup" | "listCreditTopupAttachments"
  | "getCreditTransferPolicy" | "isCreditTransferOutEnabled"
  | "getPlanPaymentListing" | "pagePlanPaymentListings" | "pageUserStore" | "findEnabledAccessPointPrice"
  | "findEnabledAccessPointPrices" | "findEnabledProviderModelCost" | "findEnabledProviderModelCosts"
  | "findEffectivePlanAccessPointPrice" | "findEffectivePlanAccessPointPrices" | "listPlanBudgetLimitsForPlans"
  | "listScopeBudgetPolicyAssignments" | "listScopeGovernanceBudgetPolicyAssignments"
  | "usageForSubscription" | "usageForSubscriptionUser" | "usageForScope" | "usageSummary"
  | "listPlanBudgetUsageSourcesForUser" | "listPlanSubscriptionBudgetUsage" | "summarizeScopeBudgetUsageWindows" | "listSellerSettlementEvents"
  | "sellerSettlementBalance" | "getStripeWebhookEvent";

export type BillingCommerceCommandName =
  | "createServiceProduct" | "updateServiceProductStatus" | "createServiceProductListing"
  | "updateServiceProductListingStatus" | "createServiceOrder" | "submitServiceOrderPayment"
  | "cancelServiceOrder" | "approveServiceOrder" | "retryServiceOrderFulfillment" | "rejectServiceOrder"
  | "consumePartnerTeamCreationAllocation" | "createCreditAccount" | "createCreditProduct" | "disableCreditProduct"
  | "createPaymentChannel" | "setPaymentChannelStatus" | "createPaymentChannelInstructionAttachment"
  | "createCreditProductListing" | "disableCreditProductListing" | "switchCreditProductListingsChannel"
  | "createCardActivationBatch" | "exportCardActivationBatch" | "revokeCardActivationBatch"
  | "revokeCardActivationCode" | "redeemCardActivationCode" | "sendCard" | "grantAdminCard"
  | "useCard" | "replaceAvailablePlanCards" | "createPlanPurchaseOrder" | "attachStripePlanCheckoutSession"
  | "completeStripePlanPurchaseOrder" | "recordStripePlanPurchaseTerminal" | "cancelUserPlanPurchaseOrder"
  | "reversePlanPurchaseOrder" | "purchasePlanCard" | "createUserCreditTopup"
  | "submitCreditTopupPaymentReference" | "attachStripeCheckoutSession" | "approveCreditTopup"
  | "recordStripeWebhookIgnored" | "recordStripeWebhookFailure" | "recordStripeCreditTopupTerminal" | "completeStripeCreditTopup"
  | "rejectCreditTopup" | "cancelUserCreditTopup" | "reverseCreditTopup" | "recordCreditTopupRefundNote"
  | "expireCreditTopups" | "createCreditTopupAttachment" | "setCreditTransferPolicy"
  | "createAdminCreditLedgerEvent" | "transferCredit" | "createPlanPaymentListing"
  | "disablePlanPaymentListing" | "releaseDueSellerSettlements";

export type BillingCommerceRuntimeQueryPort<P extends PortFor<BillingCommerceQueryName>> = Pick<P, BillingCommerceQueryName>;
export type BillingCommerceRuntimeCommandPort<P extends PortFor<BillingCommerceCommandName>> = Pick<P, BillingCommerceCommandName>;

/** Named, bounded Billing/Commerce read surface. The persistence adapter may
 * retain compatibility methods, but hosts no longer consume the generic
 * ApplicationOperationPort for these financial projections. */
export class BillingCommerceRuntimeQueries<P extends PortFor<BillingCommerceQueryName>> {
  constructor(private readonly port: P) {}

  pageEnabledServiceProducts(...a: Arguments<P, "pageEnabledServiceProducts">): Result<P, "pageEnabledServiceProducts"> { return this.port.pageEnabledServiceProducts(...a); }
  pageAdminCreditUserAccounts(...a: Arguments<P, "pageAdminCreditUserAccounts">): Result<P, "pageAdminCreditUserAccounts"> { return this.port.pageAdminCreditUserAccounts(...a); }
  pageAdminNonUserCreditAccounts(...a: Arguments<P, "pageAdminNonUserCreditAccounts">): Result<P, "pageAdminNonUserCreditAccounts"> { return this.port.pageAdminNonUserCreditAccounts(...a); }
  getAdminCreditDirectorySummary(...a: Arguments<P, "getAdminCreditDirectorySummary">): Result<P, "getAdminCreditDirectorySummary"> { return this.port.getAdminCreditDirectorySummary(...a); }
  getAdminCreditConfigurationSummary(...a: Arguments<P, "getAdminCreditConfigurationSummary">): Result<P, "getAdminCreditConfigurationSummary"> { return this.port.getAdminCreditConfigurationSummary(...a); }
  pageDraftPaymentChannels(...a: Arguments<P, "pageDraftPaymentChannels">): Result<P, "pageDraftPaymentChannels"> { return this.port.pageDraftPaymentChannels(...a); }
  listServiceProducts(...a: Arguments<P, "listServiceProducts">): Result<P, "listServiceProducts"> { return this.port.listServiceProducts(...a); }
  listServiceProductListings(...a: Arguments<P, "listServiceProductListings">): Result<P, "listServiceProductListings"> { return this.port.listServiceProductListings(...a); }
  getServiceProduct(...a: Arguments<P, "getServiceProduct">): Result<P, "getServiceProduct"> { return this.port.getServiceProduct(...a); }
  getServiceProductListing(...a: Arguments<P, "getServiceProductListing">): Result<P, "getServiceProductListing"> { return this.port.getServiceProductListing(...a); }
  getServiceOrder(...a: Arguments<P, "getServiceOrder">): Result<P, "getServiceOrder"> { return this.port.getServiceOrder(...a); }
  listServiceOrdersForBuyer(...a: Arguments<P, "listServiceOrdersForBuyer">): Result<P, "listServiceOrdersForBuyer"> { return this.port.listServiceOrdersForBuyer(...a); }
  listServiceOrders(...a: Arguments<P, "listServiceOrders">): Result<P, "listServiceOrders"> { return this.port.listServiceOrders(...a); }
  listServiceFulfillments(...a: Arguments<P, "listServiceFulfillments">): Result<P, "listServiceFulfillments"> { return this.port.listServiceFulfillments(...a); }
  getPartnerTeamCreationAllocation(...a: Arguments<P, "getPartnerTeamCreationAllocation">): Result<P, "getPartnerTeamCreationAllocation"> { return this.port.getPartnerTeamCreationAllocation(...a); }
  listAvailablePartnerTeamCreationAllocations(...a: Arguments<P, "listAvailablePartnerTeamCreationAllocations">): Result<P, "listAvailablePartnerTeamCreationAllocations"> { return this.port.listAvailablePartnerTeamCreationAllocations(...a); }
  pageUserCreditCatalog(...a: Arguments<P, "pageUserCreditCatalog">): Result<P, "pageUserCreditCatalog"> { return this.port.pageUserCreditCatalog(...a); }
  pageCreditAccounts(...a: Arguments<P, "pageCreditAccounts">): Result<P, "pageCreditAccounts"> { return this.port.pageCreditAccounts(...a); }
  pageCardTransfers(...a: Arguments<P, "pageCardTransfers">): Result<P, "pageCardTransfers"> { return this.port.pageCardTransfers(...a); }
  pageCreditProducts(...a: Arguments<P, "pageCreditProducts">): Result<P, "pageCreditProducts"> { return this.port.pageCreditProducts(...a); }
  pagePaymentChannels(...a: Arguments<P, "pagePaymentChannels">): Result<P, "pagePaymentChannels"> { return this.port.pagePaymentChannels(...a); }
  pageCreditProductListings(...a: Arguments<P, "pageCreditProductListings">): Result<P, "pageCreditProductListings"> { return this.port.pageCreditProductListings(...a); }
  pageCreditTransferPolicies(...a: Arguments<P, "pageCreditTransferPolicies">): Result<P, "pageCreditTransferPolicies"> { return this.port.pageCreditTransferPolicies(...a); }
  searchCreditProductCandidates(...a: Arguments<P, "searchCreditProductCandidates">): Result<P, "searchCreditProductCandidates"> { return this.port.searchCreditProductCandidates(...a); }
  searchPaymentChannelCandidates(...a: Arguments<P, "searchPaymentChannelCandidates">): Result<P, "searchPaymentChannelCandidates"> { return this.port.searchPaymentChannelCandidates(...a); }
  pageUserCardInventory(...a: Arguments<P, "pageUserCardInventory">): Result<P, "pageUserCardInventory"> { return this.port.pageUserCardInventory(...a); }
  pageUserPlanCards(...a: Arguments<P, "pageUserPlanCards">): Result<P, "pageUserPlanCards"> { return this.port.pageUserPlanCards(...a); }
  pageUserCardTransfers(...a: Arguments<P, "pageUserCardTransfers">): Result<P, "pageUserCardTransfers"> { return this.port.pageUserCardTransfers(...a); }
  getTopupAttachment(...a: Arguments<P, "getTopupAttachment">): Result<P, "getTopupAttachment"> { return this.port.getTopupAttachment(...a); }
  isEnabledPaymentChannelListed(...a: Arguments<P, "isEnabledPaymentChannelListed">): Result<P, "isEnabledPaymentChannelListed"> { return this.port.isEnabledPaymentChannelListed(...a); }
  pageTopupAttachments(...a: Arguments<P, "pageTopupAttachments">): Result<P, "pageTopupAttachments"> { return this.port.pageTopupAttachments(...a); }
  cursorUserTopups(...a: Arguments<P, "cursorUserTopups">): Result<P, "cursorUserTopups"> { return this.port.cursorUserTopups(...a); }
  cursorAdminTopups(...a: Arguments<P, "cursorAdminTopups">): Result<P, "cursorAdminTopups"> { return this.port.cursorAdminTopups(...a); }
  cursorCreditLedger(...a: Arguments<P, "cursorCreditLedger">): Result<P, "cursorCreditLedger"> { return this.port.cursorCreditLedger(...a); }
  getCreditAccount(...a: Arguments<P, "getCreditAccount">): Result<P, "getCreditAccount"> { return this.port.getCreditAccount(...a); }
  findCreditAccountForScope(...a: Arguments<P, "findCreditAccountForScope">): Result<P, "findCreditAccountForScope"> { return this.port.findCreditAccountForScope(...a); }
  getCreditAccountBalanceUnits(...a: Arguments<P, "getCreditAccountBalanceUnits">): Result<P, "getCreditAccountBalanceUnits"> { return this.port.getCreditAccountBalanceUnits(...a); }
  getCreditAccountBalance(...a: Arguments<P, "getCreditAccountBalance">): Result<P, "getCreditAccountBalance"> { return this.port.getCreditAccountBalance(...a); }
  listCreditLedgerEventsForAccount(...a: Arguments<P, "listCreditLedgerEventsForAccount">): Result<P, "listCreditLedgerEventsForAccount"> { return this.port.listCreditLedgerEventsForAccount(...a); }
  getCreditProduct(...a: Arguments<P, "getCreditProduct">): Result<P, "getCreditProduct"> { return this.port.getCreditProduct(...a); }
  getPaymentChannel(...a: Arguments<P, "getPaymentChannel">): Result<P, "getPaymentChannel"> { return this.port.getPaymentChannel(...a); }
  listPaymentChannelInstructionAttachments(...a: Arguments<P, "listPaymentChannelInstructionAttachments">): Result<P, "listPaymentChannelInstructionAttachments"> { return this.port.listPaymentChannelInstructionAttachments(...a); }
  getPaymentChannelInstructionAttachment(...a: Arguments<P, "getPaymentChannelInstructionAttachment">): Result<P, "getPaymentChannelInstructionAttachment"> { return this.port.getPaymentChannelInstructionAttachment(...a); }
  getCreditProductListing(...a: Arguments<P, "getCreditProductListing">): Result<P, "getCreditProductListing"> { return this.port.getCreditProductListing(...a); }
  getCard(...a: Arguments<P, "getCard">): Result<P, "getCard"> { return this.port.getCard(...a); }
  listCardActivationBatches(...a: Arguments<P, "listCardActivationBatches">): Result<P, "listCardActivationBatches"> { return this.port.listCardActivationBatches(...a); }
  getCardActivationBatchDetail(...a: Arguments<P, "getCardActivationBatchDetail">): Result<P, "getCardActivationBatchDetail"> { return this.port.getCardActivationBatchDetail(...a); }
  getCardActivationStats(...a: Arguments<P, "getCardActivationStats">): Result<P, "getCardActivationStats"> { return this.port.getCardActivationStats(...a); }
  previewCardActivationCode(...a: Arguments<P, "previewCardActivationCode">): Result<P, "previewCardActivationCode"> { return this.port.previewCardActivationCode(...a); }
  getPlanPurchaseOrder(...a: Arguments<P, "getPlanPurchaseOrder">): Result<P, "getPlanPurchaseOrder"> { return this.port.getPlanPurchaseOrder(...a); }
  getPlanPurchaseOrderForUser(...a: Arguments<P, "getPlanPurchaseOrderForUser">): Result<P, "getPlanPurchaseOrderForUser"> { return this.port.getPlanPurchaseOrderForUser(...a); }
  pagePlanPurchaseOrders(...a: Arguments<P, "pagePlanPurchaseOrders">): Result<P, "pagePlanPurchaseOrders"> { return this.port.pagePlanPurchaseOrders(...a); }
  getCreditTopup(...a: Arguments<P, "getCreditTopup">): Result<P, "getCreditTopup"> { return this.port.getCreditTopup(...a); }
  listCreditTopupAttachments(...a: Arguments<P, "listCreditTopupAttachments">): Result<P, "listCreditTopupAttachments"> { return this.port.listCreditTopupAttachments(...a); }
  getCreditTransferPolicy(...a: Arguments<P, "getCreditTransferPolicy">): Result<P, "getCreditTransferPolicy"> { return this.port.getCreditTransferPolicy(...a); }
  isCreditTransferOutEnabled(...a: Arguments<P, "isCreditTransferOutEnabled">): Result<P, "isCreditTransferOutEnabled"> { return this.port.isCreditTransferOutEnabled(...a); }
  getPlanPaymentListing(...a: Arguments<P, "getPlanPaymentListing">): Result<P, "getPlanPaymentListing"> { return this.port.getPlanPaymentListing(...a); }
  pagePlanPaymentListings(...a: Arguments<P, "pagePlanPaymentListings">): Result<P, "pagePlanPaymentListings"> { return this.port.pagePlanPaymentListings(...a); }
  pageUserStore(...a: Arguments<P, "pageUserStore">): Result<P, "pageUserStore"> { return this.port.pageUserStore(...a); }
  findEnabledAccessPointPrice(...a: Arguments<P, "findEnabledAccessPointPrice">): Result<P, "findEnabledAccessPointPrice"> { return this.port.findEnabledAccessPointPrice(...a); }
  findEnabledAccessPointPrices(...a: Arguments<P, "findEnabledAccessPointPrices">): Result<P, "findEnabledAccessPointPrices"> { return this.port.findEnabledAccessPointPrices(...a); }
  findEnabledProviderModelCost(...a: Arguments<P, "findEnabledProviderModelCost">): Result<P, "findEnabledProviderModelCost"> { return this.port.findEnabledProviderModelCost(...a); }
  findEnabledProviderModelCosts(...a: Arguments<P, "findEnabledProviderModelCosts">): Result<P, "findEnabledProviderModelCosts"> { return this.port.findEnabledProviderModelCosts(...a); }
  findEffectivePlanAccessPointPrices(...a: Arguments<P, "findEffectivePlanAccessPointPrices">): Result<P, "findEffectivePlanAccessPointPrices"> { return this.port.findEffectivePlanAccessPointPrices(...a); }
  findEffectivePlanAccessPointPrice(...a: Arguments<P, "findEffectivePlanAccessPointPrice">): Result<P, "findEffectivePlanAccessPointPrice"> { return this.port.findEffectivePlanAccessPointPrice(...a); }
  listPlanBudgetLimitsForPlans(...a: Arguments<P, "listPlanBudgetLimitsForPlans">): Result<P, "listPlanBudgetLimitsForPlans"> { return this.port.listPlanBudgetLimitsForPlans(...a); }
  listScopeBudgetPolicyAssignments(...a: Arguments<P, "listScopeBudgetPolicyAssignments">): Result<P, "listScopeBudgetPolicyAssignments"> { return this.port.listScopeBudgetPolicyAssignments(...a); }
  listScopeGovernanceBudgetPolicyAssignments(...a: Arguments<P, "listScopeGovernanceBudgetPolicyAssignments">): Result<P, "listScopeGovernanceBudgetPolicyAssignments"> { return this.port.listScopeGovernanceBudgetPolicyAssignments(...a); }
  usageForSubscription(...a: Arguments<P, "usageForSubscription">): Result<P, "usageForSubscription"> { return this.port.usageForSubscription(...a); }
  usageForSubscriptionUser(...a: Arguments<P, "usageForSubscriptionUser">): Result<P, "usageForSubscriptionUser"> { return this.port.usageForSubscriptionUser(...a); }
  usageForScope(...a: Arguments<P, "usageForScope">): Result<P, "usageForScope"> { return this.port.usageForScope(...a); }
  usageSummary(...a: Arguments<P, "usageSummary">): Result<P, "usageSummary"> { return this.port.usageSummary(...a); }
  listPlanBudgetUsageSourcesForUser(...a: Arguments<P, "listPlanBudgetUsageSourcesForUser">): Result<P, "listPlanBudgetUsageSourcesForUser"> { return this.port.listPlanBudgetUsageSourcesForUser(...a); }
  listPlanSubscriptionBudgetUsage(...a: Arguments<P, "listPlanSubscriptionBudgetUsage">): Result<P, "listPlanSubscriptionBudgetUsage"> { return this.port.listPlanSubscriptionBudgetUsage(...a); }
  summarizeScopeBudgetUsageWindows(...a: Arguments<P, "summarizeScopeBudgetUsageWindows">): Result<P, "summarizeScopeBudgetUsageWindows"> { return this.port.summarizeScopeBudgetUsageWindows(...a); }
  listSellerSettlementEvents(...a: Arguments<P, "listSellerSettlementEvents">): Result<P, "listSellerSettlementEvents"> { return this.port.listSellerSettlementEvents(...a); }
  sellerSettlementBalance(...a: Arguments<P, "sellerSettlementBalance">): Result<P, "sellerSettlementBalance"> { return this.port.sellerSettlementBalance(...a); }
  getStripeWebhookEvent(...a: Arguments<P, "getStripeWebhookEvent">): Result<P, "getStripeWebhookEvent"> { return this.port.getStripeWebhookEvent(...a); }
}

/** Named business commands only. Deliberately omits caller-selected generic
 * Ledger/Billing posting APIs. */
export class BillingCommerceRuntimeCommands<P extends PortFor<BillingCommerceCommandName>> {
  constructor(private readonly port: P) {}

  createServiceProduct(...a: Arguments<P, "createServiceProduct">): Result<P, "createServiceProduct"> { return this.port.createServiceProduct(...a); }
  updateServiceProductStatus(...a: Arguments<P, "updateServiceProductStatus">): Result<P, "updateServiceProductStatus"> { return this.port.updateServiceProductStatus(...a); }
  createServiceProductListing(...a: Arguments<P, "createServiceProductListing">): Result<P, "createServiceProductListing"> { return this.port.createServiceProductListing(...a); }
  updateServiceProductListingStatus(...a: Arguments<P, "updateServiceProductListingStatus">): Result<P, "updateServiceProductListingStatus"> { return this.port.updateServiceProductListingStatus(...a); }
  createServiceOrder(...a: Arguments<P, "createServiceOrder">): Result<P, "createServiceOrder"> { return this.port.createServiceOrder(...a); }
  submitServiceOrderPayment(...a: Arguments<P, "submitServiceOrderPayment">): Result<P, "submitServiceOrderPayment"> { return this.port.submitServiceOrderPayment(...a); }
  cancelServiceOrder(...a: Arguments<P, "cancelServiceOrder">): Result<P, "cancelServiceOrder"> { return this.port.cancelServiceOrder(...a); }
  approveServiceOrder(...a: Arguments<P, "approveServiceOrder">): Result<P, "approveServiceOrder"> { return this.port.approveServiceOrder(...a); }
  retryServiceOrderFulfillment(...a: Arguments<P, "retryServiceOrderFulfillment">): Result<P, "retryServiceOrderFulfillment"> { return this.port.retryServiceOrderFulfillment(...a); }
  rejectServiceOrder(...a: Arguments<P, "rejectServiceOrder">): Result<P, "rejectServiceOrder"> { return this.port.rejectServiceOrder(...a); }
  consumePartnerTeamCreationAllocation(...a: Arguments<P, "consumePartnerTeamCreationAllocation">): Result<P, "consumePartnerTeamCreationAllocation"> { return this.port.consumePartnerTeamCreationAllocation(...a); }
  createCreditAccount(...a: Arguments<P, "createCreditAccount">): Result<P, "createCreditAccount"> { return this.port.createCreditAccount(...a); }
  createCreditProduct(...a: Arguments<P, "createCreditProduct">): Result<P, "createCreditProduct"> { return this.port.createCreditProduct(...a); }
  disableCreditProduct(...a: Arguments<P, "disableCreditProduct">): Result<P, "disableCreditProduct"> { return this.port.disableCreditProduct(...a); }
  createPaymentChannel(...a: Arguments<P, "createPaymentChannel">): Result<P, "createPaymentChannel"> { return this.port.createPaymentChannel(...a); }
  setPaymentChannelStatus(...a: Arguments<P, "setPaymentChannelStatus">): Result<P, "setPaymentChannelStatus"> { return this.port.setPaymentChannelStatus(...a); }
  createPaymentChannelInstructionAttachment(...a: Arguments<P, "createPaymentChannelInstructionAttachment">): Result<P, "createPaymentChannelInstructionAttachment"> { return this.port.createPaymentChannelInstructionAttachment(...a); }
  createCreditProductListing(...a: Arguments<P, "createCreditProductListing">): Result<P, "createCreditProductListing"> { return this.port.createCreditProductListing(...a); }
  disableCreditProductListing(...a: Arguments<P, "disableCreditProductListing">): Result<P, "disableCreditProductListing"> { return this.port.disableCreditProductListing(...a); }
  switchCreditProductListingsChannel(...a: Arguments<P, "switchCreditProductListingsChannel">): Result<P, "switchCreditProductListingsChannel"> { return this.port.switchCreditProductListingsChannel(...a); }
  createCardActivationBatch(...a: Arguments<P, "createCardActivationBatch">): Result<P, "createCardActivationBatch"> { return this.port.createCardActivationBatch(...a); }
  exportCardActivationBatch(...a: Arguments<P, "exportCardActivationBatch">): Result<P, "exportCardActivationBatch"> { return this.port.exportCardActivationBatch(...a); }
  revokeCardActivationBatch(...a: Arguments<P, "revokeCardActivationBatch">): Result<P, "revokeCardActivationBatch"> { return this.port.revokeCardActivationBatch(...a); }
  revokeCardActivationCode(...a: Arguments<P, "revokeCardActivationCode">): Result<P, "revokeCardActivationCode"> { return this.port.revokeCardActivationCode(...a); }
  redeemCardActivationCode(...a: Arguments<P, "redeemCardActivationCode">): Result<P, "redeemCardActivationCode"> { return this.port.redeemCardActivationCode(...a); }
  sendCard(...a: Arguments<P, "sendCard">): Result<P, "sendCard"> { return this.port.sendCard(...a); }
  grantAdminCard(...a: Arguments<P, "grantAdminCard">): Result<P, "grantAdminCard"> { return this.port.grantAdminCard(...a); }
  useCard(...a: Arguments<P, "useCard">): Result<P, "useCard"> { return this.port.useCard(...a); }
  replaceAvailablePlanCards(...a: Arguments<P, "replaceAvailablePlanCards">): Result<P, "replaceAvailablePlanCards"> { return this.port.replaceAvailablePlanCards(...a); }
  createPlanPurchaseOrder(...a: Arguments<P, "createPlanPurchaseOrder">): Result<P, "createPlanPurchaseOrder"> { return this.port.createPlanPurchaseOrder(...a); }
  attachStripePlanCheckoutSession(...a: Arguments<P, "attachStripePlanCheckoutSession">): Result<P, "attachStripePlanCheckoutSession"> { return this.port.attachStripePlanCheckoutSession(...a); }
  completeStripePlanPurchaseOrder(...a: Arguments<P, "completeStripePlanPurchaseOrder">): Result<P, "completeStripePlanPurchaseOrder"> { return this.port.completeStripePlanPurchaseOrder(...a); }
  recordStripePlanPurchaseTerminal(...a: Arguments<P, "recordStripePlanPurchaseTerminal">): Result<P, "recordStripePlanPurchaseTerminal"> { return this.port.recordStripePlanPurchaseTerminal(...a); }
  cancelUserPlanPurchaseOrder(...a: Arguments<P, "cancelUserPlanPurchaseOrder">): Result<P, "cancelUserPlanPurchaseOrder"> { return this.port.cancelUserPlanPurchaseOrder(...a); }
  reversePlanPurchaseOrder(...a: Arguments<P, "reversePlanPurchaseOrder">): Result<P, "reversePlanPurchaseOrder"> { return this.port.reversePlanPurchaseOrder(...a); }
  purchasePlanCard(...a: Arguments<P, "purchasePlanCard">): Result<P, "purchasePlanCard"> { return this.port.purchasePlanCard(...a); }
  createUserCreditTopup(...a: Arguments<P, "createUserCreditTopup">): Result<P, "createUserCreditTopup"> { return this.port.createUserCreditTopup(...a); }
  submitCreditTopupPaymentReference(...a: Arguments<P, "submitCreditTopupPaymentReference">): Result<P, "submitCreditTopupPaymentReference"> { return this.port.submitCreditTopupPaymentReference(...a); }
  attachStripeCheckoutSession(...a: Arguments<P, "attachStripeCheckoutSession">): Result<P, "attachStripeCheckoutSession"> { return this.port.attachStripeCheckoutSession(...a); }
  recordStripeCreditTopupTerminal(...a: Arguments<P, "recordStripeCreditTopupTerminal">): Result<P, "recordStripeCreditTopupTerminal"> { return this.port.recordStripeCreditTopupTerminal(...a); }
  approveCreditTopup(...a: Arguments<P, "approveCreditTopup">): Result<P, "approveCreditTopup"> { return this.port.approveCreditTopup(...a); }
  recordStripeWebhookIgnored(...a: Arguments<P, "recordStripeWebhookIgnored">): Result<P, "recordStripeWebhookIgnored"> { return this.port.recordStripeWebhookIgnored(...a); }
  recordStripeWebhookFailure(...a: Arguments<P, "recordStripeWebhookFailure">): Result<P, "recordStripeWebhookFailure"> { return this.port.recordStripeWebhookFailure(...a); }
  completeStripeCreditTopup(...a: Arguments<P, "completeStripeCreditTopup">): Result<P, "completeStripeCreditTopup"> { return this.port.completeStripeCreditTopup(...a); }
  rejectCreditTopup(...a: Arguments<P, "rejectCreditTopup">): Result<P, "rejectCreditTopup"> { return this.port.rejectCreditTopup(...a); }
  cancelUserCreditTopup(...a: Arguments<P, "cancelUserCreditTopup">): Result<P, "cancelUserCreditTopup"> { return this.port.cancelUserCreditTopup(...a); }
  reverseCreditTopup(...a: Arguments<P, "reverseCreditTopup">): Result<P, "reverseCreditTopup"> { return this.port.reverseCreditTopup(...a); }
  recordCreditTopupRefundNote(...a: Arguments<P, "recordCreditTopupRefundNote">): Result<P, "recordCreditTopupRefundNote"> { return this.port.recordCreditTopupRefundNote(...a); }
  expireCreditTopups(...a: Arguments<P, "expireCreditTopups">): Result<P, "expireCreditTopups"> { return this.port.expireCreditTopups(...a); }
  createCreditTopupAttachment(...a: Arguments<P, "createCreditTopupAttachment">): Result<P, "createCreditTopupAttachment"> { return this.port.createCreditTopupAttachment(...a); }
  setCreditTransferPolicy(...a: Arguments<P, "setCreditTransferPolicy">): Result<P, "setCreditTransferPolicy"> { return this.port.setCreditTransferPolicy(...a); }
  createAdminCreditLedgerEvent(...a: Arguments<P, "createAdminCreditLedgerEvent">): Result<P, "createAdminCreditLedgerEvent"> { return this.port.createAdminCreditLedgerEvent(...a); }
  transferCredit(...a: Arguments<P, "transferCredit">): Result<P, "transferCredit"> { return this.port.transferCredit(...a); }
  createPlanPaymentListing(...a: Arguments<P, "createPlanPaymentListing">): Result<P, "createPlanPaymentListing"> { return this.port.createPlanPaymentListing(...a); }
  disablePlanPaymentListing(...a: Arguments<P, "disablePlanPaymentListing">): Result<P, "disablePlanPaymentListing"> { return this.port.disablePlanPaymentListing(...a); }
  releaseDueSellerSettlements(...a: Arguments<P, "releaseDueSellerSettlements">): Result<P, "releaseDueSellerSettlements"> { return this.port.releaseDueSellerSettlements(...a); }
}
