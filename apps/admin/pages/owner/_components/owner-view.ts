import type { TeamAccessLevel } from "@frely/team-console-ui";

export type AdminAudienceView = "owner" | "teamOwner" | "user";
export type AdminUserAudienceView = Extract<AdminAudienceView, "owner" | "user">;

export function resolveAdminAudienceView(value: string | string[] | undefined): AdminAudienceView {
  const view = Array.isArray(value) ? value[0] : value;
  if (view === "teamOwner" || view === "user") return view;
  return "owner";
}

export function resolveAdminUserAudienceView(value: string | string[] | undefined): AdminUserAudienceView {
  return resolveAdminAudienceView(value) === "user" ? "user" : "owner";
}

export function teamAccessLevelForAdminView(view: AdminAudienceView): TeamAccessLevel {
  if (view === "teamOwner") return "team-admin";
  if (view === "user") return "user";
  return "owner";
}

export function adminAudienceViewQuery(view: AdminAudienceView): string {
  return view === "owner" ? "" : `?view=${view}`;
}
