export const DB_OPS_COMMANDS = Object.freeze([
  "migration-status",
  "migration-preflight",
  "migration-recover-provider-attempt-reference",
  "create-restore-point",
  "deployment-readiness",
  "migrate",
  "migrate-locked",
  "bootstrap-owner",
  "owner-handover",
  "capture-month-archive",
  "request-history-archive",
  "archive",
  "seller-settlement-release",
  "runtime-config-check",
  "instance-data-export",
  "instance-data-inspect",
  "instance-data-restore",
] as const);

export type DbOpsCommand = (typeof DB_OPS_COMMANDS)[number];

export const DB_OPS_SCHEMA_MUTATION_COMMANDS = Object.freeze([
  "migration-recover-provider-attempt-reference",
  "migrate",
  "migrate-locked",
  "instance-data-restore",
] as const satisfies readonly DbOpsCommand[]);

export function isDbOpsCommand(value: string | undefined): value is DbOpsCommand {
  return typeof value === "string" && (DB_OPS_COMMANDS as readonly string[]).includes(value);
}
