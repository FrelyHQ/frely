import type { TeamPlanCreditAccountOption, TeamPlanTemplateOption } from "../components/team-plan-management";

export type PaymentMode = "admin_grant" | "charge_account";
export interface TeamPlanFormValues { planTemplateId: string; units: string; priority: string; effectiveStart: string; paymentMode: PaymentMode; paymentAccountId: string }

export function createTeamPlanFormValues(templates: TeamPlanTemplateOption[], creditAccounts: TeamPlanCreditAccountOption[], now = new Date()): TeamPlanFormValues {
  const template = templates[0] ?? null;
  return { planTemplateId: template?.id ?? "", units: "1", priority: template ? String(defaultTeamPlanPriority(template)) : "10", effectiveStart: datetimeLocalValue(now), paymentMode: "admin_grant", paymentAccountId: creditAccounts.find((account) => account.status === "active")?.id ?? "" };
}

export function toAddTeamPlanInput(teamId: string, values: TeamPlanFormValues, templates: TeamPlanTemplateOption[]) {
  const template = templates.find((candidate) => candidate.id === values.planTemplateId);
  if (!template) return { ok: false as const, message: "Select an enabled plan template." };
  const units = Number(values.units);
  if (!Number.isInteger(units) || units <= 0) return { ok: false as const, message: "Units must be a positive integer." };
  if (isNoLimitPayGoTemplate(template) && units !== 1) return { ok: false as const, message: "No-duration PayGo plans can only create one ongoing subscription." };
  const priority = Number(values.priority);
  if (!Number.isFinite(priority)) return { ok: false as const, message: "Priority must be a finite number." };
  if (values.paymentMode === "charge_account" && !values.paymentAccountId) return { ok: false as const, message: "Select a credit account to charge." };
  return { ok: true as const, value: { planTemplateId: template.id, scopeRef: `team:${teamId}`, units, priority, paymentMode: values.paymentMode, paymentAccountId: values.paymentMode === "charge_account" ? values.paymentAccountId : null, effectiveStart: values.effectiveStart ? new Date(values.effectiveStart).toISOString() : undefined } };
}

export function buildTeamPlanPreview(template: TeamPlanTemplateOption | null, unitsDraft: string, paymentMode: PaymentMode) {
  const units = Number(unitsDraft); const validUnits = Number.isInteger(units) && units > 0;
  if (!template || !validUnits || (isNoLimitPayGoTemplate(template) && units !== 1)) return { valid: false, units: validUnits ? units : 0, totalDue: 0 };
  return { valid: true, units, totalDue: paymentMode === "charge_account" ? template.purchaseAmount * units : 0 };
}

export function defaultTeamPlanPriority(template: Pick<TeamPlanTemplateOption, "billingMode">) { return template.billingMode === "paygo" ? 100 : 10; }
export function isNoLimitPayGoTemplate(template: Pick<TeamPlanTemplateOption, "billingMode" | "durationSeconds">) { return template.billingMode === "paygo" && template.durationSeconds === 0; }
function datetimeLocalValue(date: Date) { const offsetMs = date.getTimezoneOffset() * 60_000; return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16); }
