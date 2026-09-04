// @vitest-environment jsdom

import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { SystemSettingsPageData } from "./page-data";

vi.mock("@frely/ui/components/button", () => ({
  Button: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props} />,
}));
vi.mock("@frely/ui/components/card", () => ({
  Card: (props: React.HTMLAttributes<HTMLDivElement>) => <div {...props} />,
}));
vi.mock("@frely/ui/components/checkbox", () => ({
  Checkbox: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input type="checkbox" {...props} />,
}));
vi.mock("@frely/ui/components/input", () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
}));
vi.mock("../_components/ui", () => ({
  PageHeading: ({ children, title }: { children?: React.ReactNode; title: string }) => <header><h1>{title}</h1>{children}</header>,
  StatusBadge: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../../features/system-settings/components/pipeline-plugin-settings", () => ({ PipelinePluginSettings: () => null }));
vi.mock("../../../features/system-settings/components/request-capture-toggle", () => ({ RequestCaptureToggle: () => null }));
vi.mock("../../../features/public-hosts/components/public-hosts-panel", () => ({ PublicHostsPanel: () => null }));
vi.mock("../../../features/web-registration/components/web-registration-card", () => ({ WebRegistrationCard: () => null }));

import SystemSettingsPage from "./page";

afterEach(cleanup);

describe("System Settings release and artifact version ownership", () => {
  test("shows the deployed release independently from runtime artifact versions", () => {
    const data: NonNullable<SystemSettingsPageData> = {
      config: {
        environment: "production",
        releaseVersion: "0.64.45",
        publicBaseUrl: "https://relay.example.test",
        loggingLevel: "info",
        inviteRegistrationBaseUrl: "https://relay.example.test",
      },
      requestCapture: { enabled: false },
      pipelinePlugins: [],
      versions: [{ service: "Admin", version: "0.64.1", availability: "running", detail: "This Admin artifact" }],
      publicHostPolicy: { canonicalHostname: "relay.example.test", canonicalOrigin: "https://relay.example.test" },
      registrationSetting: { enabled: false, configured: false, team: null, updatedAt: null },
      publicHosts: { items: [], page: 1, pageSize: 20, total: 0, totalPages: 1 },
    };

    const deployed = render(<SystemSettingsPage data={data} />);

    expect(screen.getByLabelText("Release Version")).toHaveValue("v0.64.45");
    expect(screen.getByRole("heading", { name: "Runtime Artifact Versions" })).toBeInTheDocument();
    expect(screen.getByDisplayValue("v0.64.1")).toBeInTheDocument();

    deployed.unmount();
    render(<SystemSettingsPage data={{ ...data, config: { ...data.config, releaseVersion: "dev" } }} />);
    expect(screen.getByLabelText("Release Version")).toHaveValue("dev");
  });
});
