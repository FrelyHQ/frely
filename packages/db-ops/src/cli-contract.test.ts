import { describe, expect, test } from "vitest";
import { DB_OPS_COMMANDS, DB_OPS_SCHEMA_MUTATION_COMMANDS, isDbOpsCommand } from "./cli-contract.js";

describe("db-ops CLI contract", () => {
  test("preserves the bounded operational command surface without executing a command", () => {
    expect(DB_OPS_COMMANDS).toEqual([
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
    ]);
    expect(DB_OPS_SCHEMA_MUTATION_COMMANDS).toEqual([
      "migration-recover-provider-attempt-reference",
      "migrate",
      "migrate-locked",
      "instance-data-restore",
    ]);
    expect(isDbOpsCommand("migration-status")).toBe(true);
    expect(isDbOpsCommand("arbitrary-sql")).toBe(false);
    expect(isDbOpsCommand(undefined)).toBe(false);
  });
});
