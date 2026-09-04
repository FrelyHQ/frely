import type { CardMutationInput } from "../types";
export interface SendCardValues { recipientUserId: string; referenceCode: string; note: string }
export const sendCardDefaults: SendCardValues = { recipientUserId: "", referenceCode: "", note: "" };
export function validateRecipient(value: string) { return value.trim() ? undefined : "Recipient user ID is required"; }
export function toSendCardInput(cardId: string, values: SendCardValues, canSetReferenceCode: boolean): CardMutationInput {
  return {
    kind: "send",
    cardId,
    toUserId: values.recipientUserId.trim(),
    ...(canSetReferenceCode ? { referenceCode: values.referenceCode.trim() || null } : {}),
    note: values.note.trim() || null,
  };
}
