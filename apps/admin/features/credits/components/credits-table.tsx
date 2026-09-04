"use client";
import { DataTable } from "@frely/console-ui/data-table";
import { creditScopeColumns, creditUserColumns } from "../table/credit-columns";
import { creditRowId } from "../table/credit-table-state";
import type { AdminCreditUserRow, CreditScopeSummary } from "../types";
export function CreditsTable({ rows }: { rows: AdminCreditUserRow[] }) { return <DataTable serverManaged serverManagedSorting={false} data={rows} columns={creditUserColumns} getRowId={creditRowId} getRowProps={() => ({ clickable: true })} emptyState={{ title: "No user credit rows match this search." }} />; }
export function CreditScopeSummaryTable({ rows }: { rows: CreditScopeSummary[] }) { return <DataTable serverManaged serverManagedSorting={false} data={rows} columns={creditScopeColumns} getRowId={creditRowId} emptyState={{ title: "No team or global credit accounts", description: "Only user rows are currently present." }} />; }
