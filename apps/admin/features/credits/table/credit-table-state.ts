export const creditUserColumnIds = ["user", "team", "balance", "transferOut", "accountStatus", "latestLedger"] as const;
export const creditScopeColumnIds = ["scope", "balance", "status", "latestLedger"] as const;
export const creditTopupColumnIds = ["topup", "user", "credit", "payment", "reference", "evidence", "actions"] as const;
export const creditRowId = (row: { id: string }) => row.id;
