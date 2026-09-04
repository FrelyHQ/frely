import type { OwnerUserOverviewRow } from "../../../lib/teams";
import type { UpdateUserAdminNoteInput } from "../api/user-api";

export type BulkUserOperation = "set-note" | "clear-note";

export interface BulkUserFormValues {
  operation: BulkUserOperation;
  adminNote: string;
}

export const bulkUserFormDefaults: BulkUserFormValues = {
  operation: "set-note",
  adminNote: ""
};

export function validateBulkUserAdminNote(values: BulkUserFormValues) {
  return values.operation === "set-note" && !values.adminNote.trim() ? "Enter an admin note." : undefined;
}

export function toBulkUserAdminNoteInputs(users: OwnerUserOverviewRow[], values: BulkUserFormValues): UpdateUserAdminNoteInput[] {
  const adminNote = values.operation === "clear-note" ? null : values.adminNote;
  return users.map((user) => ({ userId: user.id, adminNote, failureLabel: user.email }));
}
