import { describe, expect, test } from "vitest";
import { isRetryablePostgresTransactionError } from "./server.js";

describe("PostgreSQL transaction retry classification", () => {
  test("recognizes Prisma adapter serialization conflicts without matching error messages", () => {
    expect(isRetryablePostgresTransactionError({ code: "P2010", meta: { driverAdapterError: { cause: { kind: "TransactionWriteConflict", originalCode: "40001" } } } })).toBe(true);
    expect(isRetryablePostgresTransactionError({ code: "P2010", meta: { driverAdapterError: { cause: { kind: "DatabaseConstraintViolation" } } } })).toBe(false);
  });
});
