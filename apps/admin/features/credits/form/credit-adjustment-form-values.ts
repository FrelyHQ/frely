export type CreditAdjustmentEventType = "grant" | "adjustment" | "reversal";

export interface CreditAdjustmentFormValues {
  eventType: CreditAdjustmentEventType;
  amount: string;
  reason: string;
  relatedEventId: string;
}

export function defaultCreditAdjustmentFormValues(): CreditAdjustmentFormValues {
  return { eventType: "grant", amount: "", reason: "", relatedEventId: "" };
}

export function validateCreditAdjustmentAmount(amount: string) {
  if (!amount.trim()) return "Enter an amount.";
  const amountUnits = Math.round(Number(amount) * 1_000_000);
  return Number.isSafeInteger(amountUnits) && amountUnits !== 0
    ? undefined
    : "Amount must convert to non-zero integer units.";
}

export function toCreditAdjustmentInput(scopeRef: string, value: CreditAdjustmentFormValues) {
  const amountError = validateCreditAdjustmentAmount(value.amount);
  if (amountError) return { ok: false as const, message: amountError };
  const amountUnits = Math.round(Number(value.amount) * 1_000_000);
  const reason = value.reason.trim();
  if (!reason) return { ok: false as const, message: "Enter a reason." };
  return {
    ok: true as const,
    value: {
      scopeRef,
      eventType: value.eventType,
      amountUnits,
      reason,
      relatedEventId: value.relatedEventId.trim() || null,
    },
  };
}
