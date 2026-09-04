import { describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => {
  let resolveRegistration: (value?: void | PromiseLike<void>) => void = () => undefined;
  const registration = new Promise<void>((resolve) => {
    resolveRegistration = resolve;
  });
  return {
    createServerEntry: vi.fn(<T>(entry: T) => entry),
    createStartHandler: vi.fn(() => vi.fn()),
    registerAdminObservability: vi.fn(() => registration),
    resolveRegistration: () => resolveRegistration(),
  };
});

vi.mock("@tanstack/react-start/server", () => ({
  createStartHandler: mocks.createStartHandler,
  defaultStreamHandler: Symbol("defaultStreamHandler"),
}));

vi.mock("@tanstack/react-start/server-entry", () => ({
  createServerEntry: mocks.createServerEntry,
}));

vi.mock("./server/observability-bootstrap", () => ({
  registerAdminObservability: mocks.registerAdminObservability,
}));

describe("Admin server bootstrap", () => {
  test("waits for observability registration before creating the request handler", async () => {
    const serverImport = import("./server");

    await vi.waitFor(() => expect(mocks.registerAdminObservability).toHaveBeenCalledTimes(1));
    expect(mocks.createStartHandler).not.toHaveBeenCalled();

    mocks.resolveRegistration();
    await serverImport;
    expect(mocks.createStartHandler).toHaveBeenCalledTimes(1);
    expect(mocks.createServerEntry).toHaveBeenCalledTimes(1);
  });
});
