import { describe, expect, test, vi } from "vitest";
import { testConfig } from "@frely/testkit";
import { createAuthLinkEmail, createResendMailTransport, createResendMailTransportFromEnvironment, resendSenderForConfig } from "./resend-mail.js";

describe("Resend mail transport", () => {
  test("sends a single transactional message with the Resend API contract", async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 202 }));
    const transport = createResendMailTransport({
      apiKey: "test-resend-api-key",
      from: "Frely <noreply@example.test>",
      endpoint: "https://api.resend.test/emails",
      fetchImplementation,
    });

    await transport.send({
      to: "user@example.test",
      subject: "Verify your email",
      html: "<p>Verify</p>",
      text: "Verify",
    });

    expect(fetchImplementation).toHaveBeenCalledOnce();
    const [url, init] = fetchImplementation.mock.calls[0]!;
    expect(url).toBe("https://api.resend.test/emails");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-resend-api-key");
    expect(new Headers(init?.headers).get("user-agent")).toBe("friday-relay-email/1");
    expect(JSON.parse(String(init?.body))).toEqual({
      from: "Frely <noreply@example.test>",
      to: ["user@example.test"],
      subject: "Verify your email",
      html: "<p>Verify</p>",
      text: "Verify",
    });
  });

  test("maps provider and network failures without exposing provider details", async () => {
    const fetchImplementation = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("provider detail test-resend-api-key", { status: 401 }))
      .mockRejectedValueOnce(new Error("network detail test-resend-api-key"));
    const transport = createResendMailTransport({
      apiKey: "test-resend-api-key",
      from: "noreply@example.test",
      endpoint: "https://api.resend.test/emails",
      fetchImplementation,
    });

    await expect(transport.send({
      to: "user@example.test",
      subject: "subject",
      html: "<p>body</p>",
      text: "body",
    })).rejects.toMatchObject({ code: "email_delivery_failed", status: 502, message: "Email delivery failed" });

    await expect(transport.send({
      to: "user@example.test",
      subject: "subject",
      html: "<p>body</p>",
      text: "body",
    })).rejects.toMatchObject({ code: "email_delivery_failed", status: 502, message: "Email delivery failed" });
  });

  test("uses EMAIL_SRV_RESEND and derives the sender from the canonical app hostname", () => {
    const config = testConfig();
    const transport = createResendMailTransportFromEnvironment(config, { EMAIL_SRV_RESEND: "test-resend-api-key" });
    expect(typeof transport?.send).toBe("function");
    expect(resendSenderForConfig(config)).toBe(`Frely <noreply@${new URL(config.app.publicBaseUrl).hostname}>`);
    expect(createAuthLinkEmail({
      to: "user@example.test",
      subject: "Verify your email",
      title: "Verify <email>",
      description: "Verify your email.",
      action: "Verify email",
      url: "https://relay.example.test/verify?token=opaque&next=1",
    }).html).toContain("token=opaque&amp;next=1");
  });

  test("does not create a transport when no Resend key is configured", () => {
    expect(createResendMailTransportFromEnvironment(testConfig(), {})).toBeUndefined();
  });
});
