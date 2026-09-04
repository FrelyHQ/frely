export type AdminCardType = "plan" | "credit";

export interface AdminCardFormValues {
  cardType: AdminCardType;
  productId: string;
  expiresAtLocal: string;
  referenceCode: string;
  note: string;
}

export const CARD_DEFAULT_VALIDITY_MS = 2_592_000_000;

export function defaultAdminCardFormValues(cardType: AdminCardType = "plan", now = new Date()): AdminCardFormValues {
  return {
    cardType,
    productId: "",
    expiresAtLocal: localDateTimeValue(new Date(now.getTime() + CARD_DEFAULT_VALIDITY_MS)),
    referenceCode: "",
    note: ""
  };
}

export function localDateTimeValue(value: Date): string {
  if (!Number.isFinite(value.getTime())) return "";
  const local = new Date(value.getTime() - value.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

export function validateAdminCardExpiration(value: string, now = new Date()): string | undefined {
  const parsed = new Date(value);
  if (!value || !Number.isFinite(parsed.getTime())) return "Select a valid expiration time.";
  return parsed.getTime() > now.getTime() ? undefined : "Expiration time must be in the future.";
}

export function validateAdminCardReference(value: string): string | undefined {
  const referenceCode = value.trim();
  if (!referenceCode) return "Enter an activity reference code.";
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(referenceCode)
    ? undefined
    : "Use 1-100 letters, numbers, dots, underscores, colons, or hyphens.";
}

export function adminCardTimePresentation(value: string): { timeZone: string; offset: string; utc: string } | null {
  const parsed = new Date(value);
  if (!value || !Number.isFinite(parsed.getTime())) return null;
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "Browser local time";
  const offsetMinutes = -parsed.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absolute = Math.abs(offsetMinutes);
  const hours = String(Math.floor(absolute / 60)).padStart(2, "0");
  const minutes = String(absolute % 60).padStart(2, "0");
  return { timeZone, offset: `UTC${sign}${hours}:${minutes}`, utc: parsed.toISOString() };
}

export function toAdminCardInput(recipientUserId: string, value: AdminCardFormValues) {
  const expirationError = validateAdminCardExpiration(value.expiresAtLocal);
  if (expirationError) throw new Error(expirationError);
  const referenceError = validateAdminCardReference(value.referenceCode);
  if (referenceError) throw new Error(referenceError);
  if (!value.productId) throw new Error("Select a Card product.");
  return {
    cardType: value.cardType,
    recipientUserId,
    expiresAt: new Date(value.expiresAtLocal).toISOString(),
    planId: value.cardType === "plan" ? value.productId : null,
    creditProductId: value.cardType === "credit" ? value.productId : null,
    referenceCode: value.referenceCode.trim(),
    note: value.note.trim() || null
  };
}
