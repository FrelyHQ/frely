import type { AcceptInviteInput } from "../api/register-api";

export interface RegisterFormValues { email: string; password: string; confirmPassword: string }
export const registerFormDefaults: RegisterFormValues = { email: "", password: "", confirmPassword: "" };
export function validateRegisterField(value: string, label: string) { return value.trim() ? undefined : `${label} is required`; }
export function validateRegisterPasswordPresence(value: string, label = "Password") { return value.length > 0 ? undefined : `${label} is required`; }
export function toAcceptInviteInput(inviteToken: string, values: RegisterFormValues): AcceptInviteInput { return { inviteToken, email: values.email.trim(), password: values.password }; }
export function buildInviteLoginHref(inviteToken: string) { return `/login?next=${encodeURIComponent(`/register?token=${encodeURIComponent(inviteToken)}`)}`; }
