export interface CreditProductFormValues { code: string; displayName: string; description: string; adminNote: string; creditedAmountUnits: string }
export interface PaymentChannelFormValues { code: string; displayName: string; paymentNetwork: string; paymentAsset: string; settlementMode?: "manual_review" | "stripe_checkout"; recipientIdentifier: string; recipientIdentifierDisplay: string; paymentInstruction: string }
export interface CreditListingFormValues { productId: string; paymentChannelId: string; priceAmountUnits: string }

export const defaultCreditProductFormValues = (): CreditProductFormValues => ({ code: "", displayName: "", description: "", adminNote: "", creditedAmountUnits: "" });
export const defaultPaymentChannelFormValues = (): PaymentChannelFormValues => ({ code: "", displayName: "", paymentNetwork: "", paymentAsset: "CNY", settlementMode: "manual_review", recipientIdentifier: "", recipientIdentifierDisplay: "", paymentInstruction: "" });
export const defaultCreditListingFormValues = (productId = "", paymentChannelId = ""): CreditListingFormValues => ({ productId, paymentChannelId, priceAmountUnits: "" });

export function validateRequired(value: string, label: string) { return value.trim() ? undefined : `${label} is required.`; }
export function validatePositiveUnits(value: string, label: string) { const parsed = Number(value); return Number.isSafeInteger(parsed) && parsed > 0 ? undefined : `${label} must be a positive integer.`; }

export function toCreditProductInput(value: CreditProductFormValues, displayOrder: number) {
  return { code: value.code.trim(), displayName: value.displayName.trim(), description: value.description.trim(), adminNote: value.adminNote.trim(), creditedAmountUnits: Number(value.creditedAmountUnits), displayOrder };
}
export function toPaymentChannelInput(value: PaymentChannelFormValues) {
  const settlementMode = value.settlementMode ?? "manual_review";
  const stripe = settlementMode === "stripe_checkout";
  return { code: value.code.trim(), displayName: value.displayName.trim(), paymentNetwork: stripe ? "stripe" : value.paymentNetwork.trim(), paymentAsset: value.paymentAsset.trim().toUpperCase() || (stripe ? "USD" : ""), settlementMode, recipientIdentifierType: stripe ? "other_account" : "alipay_account", transactionReferenceType: stripe ? "order_id" : "trade_number", recipientIdentifier: stripe ? "stripe_checkout" : value.recipientIdentifier.trim(), recipientIdentifierDisplay: stripe ? "Stripe Checkout" : value.recipientIdentifierDisplay.trim(), paymentInstruction: stripe ? "Secure payment is completed on Stripe Checkout." : value.paymentInstruction.trim() };
}
export function toCreditListingInput(value: CreditListingFormValues) { return { productId: value.productId, paymentChannelId: value.paymentChannelId, priceAmountUnits: Number(value.priceAmountUnits) }; }
