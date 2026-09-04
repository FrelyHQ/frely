"use client";

import React, { useState, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useRouter } from "@admin/navigation";
import { ConsoleDialog, ConsoleDialogFooter } from "@frely/console-ui/console-dialog";
import { Button } from "@frely/ui/components/button";
import { Card } from "@frely/ui/components/card";
import { BrowserTime } from "@frely/ui/components/browser-time";
import { MaterialTable } from "@frely/console-ui/material-table";
import { SearchSelect } from "../../../pages/owner/_components/search-select";
import {
  cancelTeamProviderEntitlement,
  fetchTeamProviderProductCandidates,
  grantTeamProviderEntitlement
} from "../api/team-api";

interface HistoryRow {
  id: string;
  sourceKind: string;
  sourceProductCodeSnapshot: string | null;
  sourceProductVersionSnapshot: number | null;
  buyerEmail: string | null;
  issuedByEmail: string | null;
  effectiveStart: string;
  effectiveEnd: string | null;
  lifecycle: string;
  cancelReasonCode: string | null;
}

export function TeamProviderEntitlementManagement(props: {
  teamId: string;
  state: string;
  history: HistoryRow[];
  nextCursor: string | null;
  olderHref: string | null;
  pagination?: ReactNode;
}) {
  const [open, setOpen] = useState(false);

  return <Card className="panel">
    <div className="panel-heading">
      <div><h2>Team Custom Provider Access</h2><p className="muted">Current state: {props.state}. Review entitlement history or grant and cancel access from the management dialog.</p></div>
      <Button type="button" onClick={() => setOpen(true)}>Manage access</Button>
    </div>
    {open ? <TeamProviderEntitlementDialog {...props} onClose={() => setOpen(false)} /> : null}
  </Card>;
}

function TeamProviderEntitlementDialog(props: {
  teamId: string;
  state: string;
  history: HistoryRow[];
  nextCursor: string | null;
  olderHref: string | null;
  pagination?: ReactNode;
  onClose: () => void;
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [productId, setProductId] = useState("");
  const [cancelReason, setCancelReason] = useState("operator_error");
  const products = useQuery({
    queryKey: ["owner", "team-provider-product-candidates", query, page],
    queryFn: ({ signal }) => fetchTeamProviderProductCandidates(query, page, signal),
    retry: false
  });
  const grant = useMutation({
    mutationFn: () => grantTeamProviderEntitlement(props.teamId, productId, crypto.randomUUID()),
    retry: false,
    onSuccess: () => { setProductId(""); router.refresh(); }
  });
  const cancel = useMutation({
    mutationFn: (entitlementId: string) => cancelTeamProviderEntitlement(entitlementId, cancelReason),
    retry: false,
    onSuccess: () => router.refresh()
  });
  const options = (products.data?.items ?? []).map((product) => ({
    value: product.id,
    label: `${product.displayName} · ${product.code}@${product.version}`,
    description: `${product.grantDurationSeconds}s`
  }));
  const feedback = grant.error?.message ?? cancel.error?.message;

  return <ConsoleDialog
    observabilityKey="team-provider-entitlement-management"
    titleId="team-provider-entitlement-management-title"
    eyebrow="Team Details"
    title="Manage Team Custom Provider Access"
    description={`Current state: ${props.state}. Grants use the selected listed product version and do not charge an account.`}
    closeDisabled={grant.isPending || cancel.isPending}
    onClose={props.onClose}
  >
    <div className="embedded-section">
      <strong>Grant access</strong>
      <p className="muted">Choose an enabled Authority Product for this Team.</p>
      <div className="form-grid">
        <label>Authority Product<SearchSelect
          value={productId}
          onValueChange={setProductId}
          onSearchChange={(value) => { setQuery(value); setPage(1); }}
          searchable
          placeholder="Search listed Provider access products"
          options={options}
          disabled={grant.isPending || cancel.isPending}
          {...(products.data ? { pagination: { page: products.data.page, totalPages: products.data.totalPages, pending: products.isFetching, onPageChange: setPage } } : {})}
        /></label>
        <div className="form-footer">
          <Button type="button" disabled={!productId || grant.isPending || cancel.isPending} onClick={() => grant.mutate()}>{grant.isPending ? "Granting..." : "Grant access"}</Button>
        </div>
      </div>
    </div>
    <div className="embedded-section">
      <strong>Entitlement history</strong>
      <p className="muted">Select the recorded reason before canceling an active finite entitlement.</p>
      <label>Cancellation reason<SearchSelect
        value={cancelReason}
        onValueChange={setCancelReason}
        searchable={false}
        disabled={grant.isPending || cancel.isPending}
        options={[
          { value: "operator_error", label: "Operator error" },
          { value: "security_response", label: "Security response" },
          { value: "fraud", label: "Fraud" },
          { value: "product_correction", label: "Product correction" }
        ]}
      /></label>
      <MaterialTable
        columns={[{ header: "Source" }, { header: "Period" }, { header: "Actor" }, { header: "Status" }, { header: "Action" }]}
        rows={props.history.map((row) => ({
          id: row.id,
          cells: [
            <span key="source"><strong>{row.sourceKind}</strong><br /><code>{row.sourceProductCodeSnapshot ? `${row.sourceProductCodeSnapshot}@${row.sourceProductVersionSnapshot}` : "legacy"}</code></span>,
            <span key="period"><BrowserTime value={row.effectiveStart} /> – {row.effectiveEnd ? <BrowserTime value={row.effectiveEnd} /> : "Permanent"}</span>,
            row.buyerEmail ?? row.issuedByEmail ?? "Legacy migration",
            `${row.lifecycle}${row.cancelReasonCode ? ` · ${row.cancelReasonCode}` : ""}`,
            row.lifecycle === "active" && row.effectiveEnd ? <Button key="cancel" type="button" variant="destructive" size="sm" disabled={grant.isPending || cancel.isPending} onClick={() => cancel.mutate(row.id)}>Cancel</Button> : "—"
          ]
        }))}
        emptyState={{ title: "No Team Provider entitlement history." }}
        table={{ density: "compact" }}
      />
      {props.pagination}
      {!props.pagination && props.nextCursor && props.olderHref ? <div className="form-footer"><Button asChild variant="secondary"><a href={props.olderHref}>Older history</a></Button></div> : null}
    </div>
    <ConsoleDialogFooter feedback={feedback ? <div className="notice-box notice-bad" role="alert">{feedback}</div> : null}>
      <Button type="button" variant="secondary" disabled={grant.isPending || cancel.isPending} onClick={props.onClose}>Close</Button>
    </ConsoleDialogFooter>
  </ConsoleDialog>;
}
