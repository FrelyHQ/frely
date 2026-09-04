import { describe, expect, it } from "vitest";
import { buildInviteLoginHref, registerFormDefaults, toAcceptInviteInput, validateRegisterField } from "../apps/web/features/register/form/register-form-values";

describe("Web Register UI model", () => {
  // REQ-TA-007, REQ-TA-009
  it("maps the confirmed form to the invite DTO without sending the confirmation", () => {
    expect(registerFormDefaults).toEqual({ email: "", password: "", confirmPassword: "" });
    expect(toAcceptInviteInput("invite-secret", {
      email: "  user@example.com ",
      password: " pass phrase ",
      confirmPassword: " pass phrase ",
    })).toEqual({ inviteToken: "invite-secret", email: "user@example.com", password: " pass phrase " });
  });

  it("only performs lightweight required validation", () => {
    expect(validateRegisterField(" ", "Email")).toBe("Email is required");
    expect(validateRegisterField("user@example.com", "Email")).toBeUndefined();
  });

  it("returns signed-in users to the same encoded invitation", () => {
    expect(buildInviteLoginHref("invite/secret?part=1")).toBe("/login?next=%2Fregister%3Ftoken%3Dinvite%252Fsecret%253Fpart%253D1");
  });
});
