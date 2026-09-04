// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  failActiveSurface: vi.fn(),
  invalidate: vi.fn(),
}));

vi.mock("@frely/observability/client-runtime", () => ({
  getSurfaceRuntime: () => ({ failActiveSurface: mocks.failActiveSurface }),
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...await importOriginal<typeof import("@tanstack/react-router")>(),
  HeadContent: () => <meta name="admin-head-marker" content="present" />,
  Scripts: () => <script data-admin-scripts-marker="present" />,
  useRouter: () => ({ invalidate: mocks.invalidate }),
}));

import { AdminRootErrorComponent } from "../root-error-boundary";
import { AdminRootShell } from "../root-shell";

afterEach(() => {
  cleanup();
  mocks.failActiveSurface.mockReset();
  mocks.invalidate.mockReset();
});

describe("Admin root error boundary", () => {
  test("keeps the document shell and hydration scripts outside the root error boundary", () => {
    const rootRouteSource = readFileSync(join(process.cwd(), "apps/admin/src/routes/__root.tsx"), "utf8");
    const markup = renderToStaticMarkup(<AdminRootShell><main>error body</main></AdminRootShell>);

    expect(rootRouteSource).toContain("shellComponent: AdminRootShell");
    expect(markup).toContain("<html");
    expect(markup).toContain("admin-head-marker");
    expect(markup).toContain("error body");
    expect(markup).toContain("data-admin-scripts-marker");
  });

  test("fails the active Surface and invalidates loaders when the user retries", async () => {
    const user = userEvent.setup();

    render(<AdminRootErrorComponent />);

    await waitFor(() => expect(mocks.failActiveSurface).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(mocks.invalidate).toHaveBeenCalledTimes(1);
  });
});
