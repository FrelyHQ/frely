import { describe, expect, it } from "vitest";
import { teamInviteRegistrationUrl } from "./team-invite-registration-url.js";

describe("team invite registration URL", () => {
  it("uses the configured public Web base URL instead of the Admin origin", () => {
    expect(teamInviteRegistrationUrl("https://relay.example.com", "invite/+ token")).toBe(
      "https://relay.example.com/register?token=invite%2F%2B%20token"
    );
  });

  it("normalizes a trailing slash before the public registration path", () => {
    expect(teamInviteRegistrationUrl("https://web.example.test/", "invite_1")).toBe(
      "https://web.example.test/register?token=invite_1"
    );
  });
});
