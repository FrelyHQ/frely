import { beforeEach, describe, expect, it, vi } from "vitest";
import { notFound, redirect } from "@tanstack/react-router";
import { startInstance } from "./start";

describe("Admin Start server-function error contract", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("replaces unexpected errors before TanStack serializes them", async () => {
    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const boundary = await getServerFunctionBoundary();
    const error = Object.assign(new Error("private database sentinel"), {
      details: { credential: "private credential sentinel" },
    });

    let exposed: unknown;
    try {
      await boundary({ next: async () => { throw error; } });
    } catch (caught) {
      exposed = caught;
    }

    const serialized = JSON.stringify(exposed);
    expect(exposed).toEqual({ code: "internal_server_error" });
    expect(serialized).not.toContain("private database sentinel");
    expect(serialized).not.toContain("private credential sentinel");
    expect(serialized).not.toContain("stack");
    expect(write).toHaveBeenCalledOnce();
    expect(String(write.mock.calls[0]?.[0])).toBe(
      `${JSON.stringify({ event: "admin.server_function.failed", code: "internal_server_error" })}\n`,
    );
  });

  it.each([
    ["response", new Response(null, { status: 401 })],
    ["redirect", redirect({ href: "/owner", statusCode: 307 })],
    ["not-found", notFound()],
  ])("preserves %s control flow", async (_label, controlFlow) => {
    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const boundary = await getServerFunctionBoundary();

    await expect(boundary({ next: async () => { throw controlFlow; } })).rejects.toBe(controlFlow);
    expect(write).not.toHaveBeenCalled();
  });
});

async function getServerFunctionBoundary(): Promise<(options: { next: () => Promise<never> }) => Promise<unknown>> {
  const options = await startInstance.getOptions();
  const boundary = options.functionMiddleware?.[0]?.options.server;
  if (!boundary) throw new Error("Admin server-function error boundary is not configured");
  return boundary as unknown as (options: { next: () => Promise<never> }) => Promise<unknown>;
}
