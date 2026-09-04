"use client";

import { PasswordChangeForm, type PasswordChangeActionPort } from "@frely/console-ui/password-change";
import { changeOwnerPassword } from "../api/password-change-api";

const actionPort: PasswordChangeActionPort = { changePassword: changeOwnerPassword };

export function OwnerPasswordChange() {
  return <PasswordChangeForm actionPort={actionPort} />;
}
