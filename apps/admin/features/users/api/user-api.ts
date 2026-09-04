import { readConsoleApiResponse } from "@frely/console-ui/api-error";
import type { toAdminCardInput } from "../form/owner-card-form-values";

export interface AdminCardPlanCandidate {
  id: string;
  name: string;
  version: number;
  durationSeconds: number;
}

export interface AdminCardCreditProductCandidate {
  id: string;
  code: string;
  displayName: string;
  creditedAmountUnits: number;
}

export interface AdminCardCandidatePage<T> {
  items: T[];
  page: number;
  pageSize: 20;
  total: number;
  totalPages: number;
}

export interface UpdateUserAdminNoteInput {
  userId: string;
  adminNote: string | null;
  failureLabel?: string;
}

export async function updateUserAdminNote({ userId, adminNote, failureLabel }: UpdateUserAdminNoteInput) {
  const response = await fetch(`/api/owner/users/${encodeURIComponent(userId)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ adminNote })
  });
  return readConsoleApiResponse<unknown>(response, `Update ${failureLabel ?? userId} failed`);
}

export async function updateUsersAdminNote(inputs: UpdateUserAdminNoteInput[]) {
  await Promise.all(inputs.map(updateUserAdminNote));
}

export async function createOwnerUser(input: { teamId: string; email: string; password: string }) {
  const response = await fetch("/api/owner/users", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input)
  });
  return readConsoleApiResponse<{ id: string }>(response, "Create user failed");
}

export async function grantAdminCard(input: ReturnType<typeof toAdminCardInput>) {
  const response = await fetch("/api/owner/marketing-cards", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input)
  });
  return readConsoleApiResponse<{ card: { id: string; expiresAt: string }; transfer: { id: string } }>(response, "Send Admin Card failed");
}

export async function fetchAdminCardCandidates(
  kind: "plans" | "credit-products",
  userId: string,
  query: string,
  page: number,
  signal?: AbortSignal,
) {
  const params = new URLSearchParams({ kind, userId });
  if (query) params.set("q", query);
  if (page > 1) params.set("page", String(page));
  const response = await fetch(`/api/owner/admin-card-candidates?${params}`, signal ? { signal } : {});
  return readConsoleApiResponse<AdminCardCandidatePage<AdminCardPlanCandidate | AdminCardCreditProductCandidate>>(
    response,
    "Failed to load Marketing Card products",
  );
}
