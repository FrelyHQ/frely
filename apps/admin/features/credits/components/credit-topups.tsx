"use client";
import { useMemo, useState, type ComponentProps } from "react";
import { useMutation } from "@tanstack/react-query";
import { DataTable, type ColumnDef } from "@frely/console-ui/data-table";
import { Button } from "@frely/ui/components/button";
import { Dialog as UiDialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@frely/ui/components/dialog";
import { useRouter } from "@admin/navigation";
import { approveCreditTopup, recordCreditTopupRefund, rejectCreditTopup, reverseCreditTopup } from "../api/credit-api";
import type { CreditTopup } from "../types";
import { creditRowId, creditTopupColumnIds } from "../table/credit-table-state";

function Dialog(props: Omit<ComponentProps<typeof UiDialog>, "observabilityKey">) {
  return <UiDialog observabilityKey="credit-topup-reversal" {...props} />;
}

export function CreditTopups({ topups }: { topups: CreditTopup[] }) {
  const router = useRouter();
  const [reversalTopup, setReversalTopup] = useState<CreditTopup | null>(null);
  const onSuccess = () => router.refresh();
  const approve = useMutation({ mutationFn: approveCreditTopup, retry: false, onSuccess });
  const reject = useMutation({ mutationFn: rejectCreditTopup, retry: false, onSuccess });
  const reverse = useMutation({ mutationFn: reverseCreditTopup, retry: false, onSuccess: () => { setReversalTopup(null); onSuccess(); } });
  const refund = useMutation({ mutationFn: recordCreditTopupRefund, retry: false, onSuccess });
  const busy = approve.isPending || reject.isPending || reverse.isPending || refund.isPending;
  const error = [approve.error, reject.error, reverse.error, refund.error].find((item) => item instanceof Error);
  const columns = useMemo<Array<ColumnDef<CreditTopup, unknown>>>(() => [
    { id: creditTopupColumnIds[0], header: "Topup", accessorKey: "status", cell: ({ row }) => <><strong>{row.original.status}</strong><code>{row.original.id}</code></> },
    { id: creditTopupColumnIds[1], header: "User", accessorFn: (row) => row.userEmail || row.userId },
    { id: creditTopupColumnIds[2], header: "Credit", accessorKey: "creditedAmountUnits", cell: ({ row }) => formatCredit(row.original.creditedAmountUnits) },
    { id: creditTopupColumnIds[3], header: "Payment", accessorKey: "expectedPaymentAmountUnits", cell: ({ row }) => `${formatUnits(row.original.expectedPaymentAmountUnits)} ${row.original.paymentAsset}` },
    { id: creditTopupColumnIds[4], header: "Reference", accessorFn: (row) => row.transactionReference ?? row.transactionReferenceTail ?? "—" },
    { id: creditTopupColumnIds[5], header: "Evidence", accessorKey: "attachmentCount", cell: ({ row }) => <>{row.original.attachmentCount}{row.original.duplicateEvidence ? <strong> Duplicate hash</strong> : null}</> },
    { id: creditTopupColumnIds[6], header: "Actions", enableSorting: false, cell: ({ row }) => <div className="table-actions">
      {row.original.status === "pending_review" ? <><Button type="button" size="sm" disabled={busy} onClick={() => approve.mutate({ id: row.original.id, amount: row.original.expectedPaymentAmountUnits })}>Approve</Button><Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => reject.mutate(row.original.id)}>Reject</Button></> : null}
      {row.original.status === "credited" || (row.original.status === "fulfilled" && row.original.settlementMode === "stripe_checkout") ? <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => setReversalTopup(row.original)}>{row.original.status === "fulfilled" ? "Invalidate / reverse" : "Reverse"}</Button> : null}
      {!row.original.refundRecordedAt && ["credited", "reversed"].includes(row.original.status) ? <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => refund.mutate(row.original.id)}>Record Refund</Button> : null}
    </div> }
  ], [approve, busy, refund, reject, reverse]);
  return <><div aria-live="polite">{error instanceof Error ? <div className="notice-box notice-bad">{error.message}</div> : null}</div><DataTable serverManaged serverManagedSorting={false} data={topups} columns={columns} getRowId={creditRowId} emptyState={{ title: "No credit topups yet." }} />
    <Dialog open={reversalTopup !== null} onOpenChange={(open) => { if (!open && !reverse.isPending) setReversalTopup(null); }}><DialogContent><DialogHeader sticky><DialogTitle>{reversalTopup?.status === "fulfilled" ? "Invalidate Stripe Credit Card?" : "Reverse Credit Topup?"}</DialogTitle><DialogDescription>{reversalTopup?.status === "fulfilled" ? "An unused Card will become permanently unusable. A redeemed Card will append a reversal to its Credit account and may create a negative balance." : "This appends a reversal ledger event and cannot rewrite the original payment fact."}</DialogDescription></DialogHeader>{reversalTopup ? <div className="detail-list"><div><span>Topup</span><code>{reversalTopup.id}</code></div><div><span>Credit</span><strong>{formatCredit(reversalTopup.creditedAmountUnits)}</strong></div>{reversalTopup.cardId ? <div><span>Card</span><code>{reversalTopup.cardId}</code></div> : null}</div> : null}<DialogFooter sticky feedback={reverse.error ? <div className="notice-box notice-bad" role="alert">{reverse.error instanceof Error ? reverse.error.message : "Reverse failed"}</div> : null}><DialogClose asChild><Button variant="secondary" disabled={reverse.isPending}>Cancel</Button></DialogClose><Button variant="warning" disabled={!reversalTopup || reverse.isPending} onClick={() => reversalTopup && reverse.mutate(reversalTopup.id)}>{reverse.isPending ? "Processing…" : "Confirm irreversible action"}</Button></DialogFooter></DialogContent></Dialog>
  </>;
}

function formatCredit(units: number) { return `$${formatUnits(units)}`; }
function formatUnits(units: number) { return (units / 1_000_000).toFixed(6).replace(/\.?0+$/, ""); }
