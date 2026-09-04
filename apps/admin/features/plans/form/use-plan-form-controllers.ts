"use client";

import { useForm, useStore } from "@tanstack/react-form";
import type { BudgetLimitDraft, PriceDraft } from "./plan-form-values";
import { defaultTemplateDraft } from "./plan-model";

export function usePlanFormControllers(input: { onCreateTemplate: () => Promise<void>; onEditTemplate: () => Promise<void> }) {
  const templateForm = useForm({ defaultValues: defaultTemplateDraft(), onSubmit: input.onCreateTemplate });
  const templateDraft = useStore(templateForm.store, (state) => state.values);

  const detailForm = useForm({ defaultValues: { description: "", adminNote: "", status: "enabled" as "enabled" | "closed" | "disabled", catalogStatus: "unlisted" as "listed" | "unlisted", accessPointIds: [] as string[], budgetLimits: [] as BudgetLimitDraft[], priceDrafts: {} as Record<string, PriceDraft> }, onSubmit: input.onEditTemplate });
  const detailDraft = useStore(detailForm.store, (state) => state.values);
  const setTemplateDescriptionDraft = (value: string) => detailForm.setFieldValue("description", value);
  const setTemplateAdminNoteDraft = (value: string) => detailForm.setFieldValue("adminNote", value);
  const setTemplateStatusDraft = (value: string) => detailForm.setFieldValue("status", value as "enabled" | "closed" | "disabled");
  const setTemplateCatalogStatusDraft = (value: string) => detailForm.setFieldValue("catalogStatus", value as "listed" | "unlisted");
  const setTemplateAccessPointIdsDraft = (value: string[] | ((current: string[]) => string[])) => detailForm.setFieldValue("accessPointIds", typeof value === "function" ? value(detailForm.state.values.accessPointIds) : value);
  const setTemplateBudgetLimitsDraft = (value: BudgetLimitDraft[] | ((current: BudgetLimitDraft[]) => BudgetLimitDraft[])) => detailForm.setFieldValue("budgetLimits", typeof value === "function" ? value(detailForm.state.values.budgetLimits) : value);
  const setTemplatePriceDrafts = (value: Record<string, PriceDraft> | ((current: Record<string, PriceDraft>) => Record<string, PriceDraft>)) => detailForm.setFieldValue("priceDrafts", typeof value === "function" ? value(detailForm.state.values.priceDrafts) : value);

  return { templateForm, templateDraft, detailForm, detailDraft, setTemplateDescriptionDraft, setTemplateAdminNoteDraft, setTemplateStatusDraft, setTemplateCatalogStatusDraft, setTemplateAccessPointIdsDraft, setTemplateBudgetLimitsDraft, setTemplatePriceDrafts };
}
