import { describe, expect, test } from "vitest";
import { createAdminRequestScope } from "./request";

describe("Admin outer request scope", () => {
  test("reuses one valid req_ id and replaces an invalid external id", () => {
    const accepted = createAdminRequestScope(new Request("http://admin.test/owner", {
      headers: { "x-request-id": "req_external.trace-1" },
    }));
    expect(accepted.requestId).toBe("req_external.trace-1");
    expect(accepted.request.headers.get("x-request-id")).toBe(accepted.requestId);

    const replaced = createAdminRequestScope(new Request("http://admin.test/owner", {
      headers: { "x-request-id": "attacker-controlled" },
    }));
    expect(replaced.requestId).toMatch(/^req_[0-9a-f]{24}$/u);
    expect(replaced.requestId).not.toContain("attacker-controlled");
    expect(replaced.request.headers.get("x-request-id")).toBe(replaced.requestId);
  });

  test("injects headers without reading multipart bytes and keeps abort propagation", async () => {
    const controller = new AbortController();
    const raw = "--raw-boundary\r\nraw-bytes\r\n--raw-boundary--";
    const scoped = createAdminRequestScope(new Request("http://admin.test/api/upload", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=raw-boundary" },
      body: raw,
      signal: controller.signal,
    }));

    expect(scoped.request.headers.get("content-type")).toBe("multipart/form-data; boundary=raw-boundary");
    expect(await scoped.request.text()).toBe(raw);
    controller.abort("client-disconnected");
    expect(scoped.request.signal.aborted).toBe(true);
    expect(scoped.request.signal.reason).toBe("client-disconnected");
  });
});
