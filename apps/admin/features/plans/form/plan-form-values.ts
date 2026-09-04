import type { BudgetLimitScope } from "../types";

export type DurationUnit = "seconds" | "hours" | "days" | "years";
export type WindowUnit = "seconds" | "hours" | "days";
export interface PriceDraft { multiplier: string; }
export interface BudgetLimitDraft { localId: string; metric: string; limitValue: string; windowType: string; windowValue: string; windowUnit: WindowUnit; limitScope: BudgetLimitScope; }
export interface TemplateFormValues { name: string; description: string; adminNote: string; billingMode: "prepaid" | "paygo"; purchaseAmount: string; catalogStatus: "listed" | "unlisted"; noDurationLimit: boolean; durationValue: string; durationUnit: DurationUnit; budgetLimits: BudgetLimitDraft[]; accessPointIds: string[]; accessPointPriceDrafts: Record<string, PriceDraft>; }

export function defaultTemplateFormValues(): TemplateFormValues {
  return { name: "", description: "", adminNote: "", billingMode: "prepaid", purchaseAmount: "0", catalogStatus: "unlisted", noDurationLimit: false, durationValue: "30", durationUnit: "days", budgetLimits: [], accessPointIds: [], accessPointPriceDrafts: {} };
}

export function planSubscriptionCancelInput(id: string) {
  return { id, action: "cancel" as const };
}
