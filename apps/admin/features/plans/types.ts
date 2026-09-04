export type BudgetLimitScope = "subscription" | "user";

export interface BudgetPolicy { id: string; metric: string; limitValue: number; windowType: string; windowSeconds: number | null; status: string; createdAt: string; updatedAt: string; }
export interface PlanBudgetLimit { limitScope: BudgetLimitScope; metric: "tokens" | "amount"; limitValue: number; windowType: "fixed" | "cumulative"; windowSeconds: number | null; }
export interface PriceTierSummary { serviceTier?: string; tierKey: string; minInputTokens: number; maxInputTokens: number | null; inputPer1M: number; cachedInputPer1M: number; cacheWritePer1M: number | null; outputPer1M: number; status: string; }
export interface PriceSummary { id: string; inputPer1M: number; cachedInputPer1M: number; cacheWritePer1M: number | null; outputPer1M: number; tiers?: PriceTierSummary[]; }
export interface EffectivePriceSummary { source: "access_point" | "plan_access_point"; price: PriceSummary; basePrice: PriceSummary | null; planAccessPointPrice: PriceSummary | null; }
export interface AccessPointSummary { id: string; ownerId: string; scopeRef: string; name: string; description: string | null; apiFamily: string; exposedModel: string; status: string; basePrice?: PriceSummary | null; effectivePrice?: EffectivePriceSummary | null; }
export interface PlanTemplate { id: string; ownerId: string; scopeRef: string; name: string; version: number; description: string | null; adminNote: string | null; billingMode: "prepaid" | "paygo"; purchaseAmount: number; durationSeconds: number; status: "enabled" | "closed" | "disabled"; catalogStatus: "listed" | "unlisted"; statusImpact: { availableCardCount: number; activeOrFutureSubscriptionCount: number }; createdAt: string; updatedAt: string; budgetLimits: PlanBudgetLimit[]; accessPoints: AccessPointSummary[]; }
export interface PlanDirectoryRow extends Omit<PlanTemplate, "budgetLimits" | "accessPoints"> { budgetLimitCount: number; accessPointCount: number; accessPointNames: string[]; }
export interface DirectoryPage<T> { items: T[]; page: number; pageSize: number; total: number; totalPages: number; }
export interface PlanTemplateDetailPage { template: Omit<PlanTemplate, "budgetLimits" | "accessPoints">; budgetLimits: DirectoryPage<PlanBudgetLimit>; accessPoints: DirectoryPage<AccessPointSummary>; }
export interface Plan { id: string; planTemplateId: string; source: string; scopeRef: string; purchasedByUserId: string | null; fundingAccountId: string | null; priority: number; effectiveStart: string; effectiveEnd: string | null; status: string; createdAt: string; updatedAt: string; budgetUsage?: PlanBudgetSourceDisplay; }
export interface TeamSummary { id: string; name: string; status: string; }
export interface UserSummary { id: string; email: string; role: string; status: string; }
export interface CreditAccountSummary { id: string; scopeRef: string; status: string; balance: number; }
import type { PlanBudgetSourceDisplay } from "@frely/console-ui/plan-budget";
