"use client";

import { PasswordChangeForm, type PasswordChangeActionPort } from "@frely/console-ui/password-change";
import { changeWebPassword } from "../api/password-change-api";

const actionPort: PasswordChangeActionPort = { changePassword: changeWebPassword };

export function WebPasswordChange() {
  return <PasswordChangeForm actionPort={actionPort} />;
}
