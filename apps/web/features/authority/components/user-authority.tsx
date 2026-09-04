"use client";

import { useRouter } from "@web/navigation";
import * as React from "react";
import { useState, type FormEvent } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { MaterialTablePagination } from "@frely/console-ui/material-table-pagination";
import type { AuthorityProductEffectCode } from "@frely/core";
import { SearchSelect } from "@frely/console-ui/search-select";
import { Button } from "@frely/ui/components/button";
import { Card } from "@frely/ui/components/card";
import { Input } from "@frely/ui/components/input";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@frely/ui/components/dialog";
import { fetchTeamProviderPurchaseCandidates, mutateAuthority, type AuthorityMutation } from "../api/authority-api";

interface Product { id: string; code: string; version: number; displayName: string; effectCode: AuthorityProductEffectCode; grantUnits: number; purchaseAmountUnits: number; grantDurationSeconds: number; refundMode: string; refundDeadlineSeconds: number | null; maxCurrentOwnedTeams: number | null; maxLifetimeCreatedTeams: number | null }
interface Grant { id: string; productCode: string | null; effectiveEnd: string | null; lifecycle: string; grantedUnits: number; usedUnits: number; availableUnits: number }
interface ProviderSlot { id: string; providerId: string | null; lifecycle: "active" | "expired_hot" | "retention_expired"; latestEffectiveEnd: string; renewalCutoff: string; usedAccessPoints: number; maxAccessPoints: number }
interface Page<T> { items: T[]; page: number; pageSize: number; total: number; totalPages: number }

export function UserAuthority({ products, grants, canCreateTeam, personalCreditBalanceUnits, personalProviderProduct, providerSlots, providerSlotTotal }: {
  products: Page<Product>;
  grants: Page<Grant>;
  canCreateTeam: boolean;
  personalCreditBalanceUnits: number;
  personalProviderProduct: Product | null;
  providerSlots: ProviderSlot[];
  providerSlotTotal: number;
}) {
  const router = useRouter();
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [teamQuery, setTeamQuery] = useState("");
  const [teamPage, setTeamPage] = useState(1);
  const [teamId, setTeamId] = useState("");
  const [renewalSlot, setRenewalSlot] = useState<ProviderSlot | null>(null);
  const teamCandidates = useQuery({
    queryKey: ["user", "team-provider-purchase-candidates", teamQuery, teamPage],
    queryFn: ({ signal }) => fetchTeamProviderPurchaseCandidates(teamQuery, teamPage, signal),
    retry: false,
    enabled: products.items.some((product) => product.effectCode === "team_custom_provider_access")
  });
  const mutation = useMutation({
    mutationFn: mutateAuthority,
    retry: false,
    onMutate: () => setNotice(null),
    onSuccess: (result, input) => {
      if (input.kind === "create-team" && result.teamId && result.targetStatus === "active") { router.push(`/user/team/${result.teamId}`); return; }
      setNotice({ ok: true, text: input.kind === "purchase" ? "Authority Product purchased." : input.kind === "renew" ? "Provider slot renewed." : "Team operation replayed; the original target is unavailable." });
      if (input.kind === "purchase" && input.teamId) setTeamId("");
      if (input.kind === "renew") setRenewalSlot(null);
      router.refresh();
    }
  });

  function createTeam(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    mutation.mutate({ kind: "create-team", name: String(form.get("name")) });
  }

  const pending = mutation.isPending;
  const activeMutation = mutation.variables as AuthorityMutation | undefined;
  const feedback = notice ?? (mutation.error ? { ok: false, text: mutation.error instanceof Error ? mutation.error.message : "Authority operation failed" } : null);
  const selectedTeamCandidate = teamCandidates.data?.items.find((candidate) => candidate.id === teamId);

  return <section className="split-grid">
    <Card className="panel"><div className="panel-heading"><div><h2>Products</h2><p className="muted">Prices and validity shown here come from the current runtime catalog. Personal credit balance: {personalCreditBalanceUnits.toLocaleString("en-US")} units.</p></div></div>
      <div className="card-grid">{products.items.length ? products.items.map((product) => <Card key={product.id}>
        <div className="panel-heading"><div><h3>{product.displayName}</h3><code>{product.code}@{product.version}</code></div></div>
        <div className="detail-list"><div><span>Price</span><strong>{product.purchaseAmountUnits} units</strong></div><div><span>Effect</span><strong>{product.effectCode === "team_custom_provider_access" ? "Team custom Provider access" : product.effectCode === "user_custom_provider_access" ? "One personal Codex Provider slot · 100 AP" : `${product.grantUnits} Team creation unit(s)`}</strong></div><div><span>Validity</span><strong>{product.effectCode === "user_custom_provider_access" ? `${product.grantDurationSeconds / 86400} days` : `${product.grantDurationSeconds}s`}</strong></div><div><span>Refund</span><strong>{product.refundMode === "none" ? "None" : `${product.refundDeadlineSeconds}s while unused`}</strong></div></div>
        {product.effectCode === "team_custom_provider_access" ? <label>Target Team<SearchSelect
          value={teamId}
          onValueChange={setTeamId}
          onSearchChange={(value) => { setTeamQuery(value); setTeamPage(1); }}
          searchable
          placeholder="Search Teams where you are Owner or Billing"
          options={(teamCandidates.data?.items ?? []).map((team) => ({
            value: team.id,
            label: team.name,
            description: `${team.role} · ${team.permanent ? "Permanent access" : team.currentEnd ? `Renews after ${team.currentEnd}` : "No current access"}`
          }))}
          disabled={pending}
          {...(teamCandidates.data ? { pagination: { page: teamCandidates.data.page, totalPages: teamCandidates.data.totalPages, pending: teamCandidates.isFetching, onPageChange: setTeamPage } } : {})}
        /></label> : null}
        {product.effectCode === "team_custom_provider_access" && teamId ? <PurchaseConfirmation
          product={product}
          team={selectedTeamCandidate}
          personalCreditBalanceUnits={personalCreditBalanceUnits}
        /> : null}
        <div className="form-footer"><Button type="button" onClick={() => mutation.mutate({
          kind: "purchase",
          productId: product.id,
          ...(product.effectCode === "team_custom_provider_access" ? { teamId } : {})
        })} disabled={pending || (product.effectCode === "team_custom_provider_access" && (!teamId || Boolean(selectedTeamCandidate?.permanent)))}>{pending && activeMutation?.kind === "purchase" && activeMutation.productId === product.id ? "Purchasing..." : product.effectCode === "team_custom_provider_access" ? "Purchase for Team" : product.effectCode === "user_custom_provider_access" ? "Purchase new slot" : "Purchase"}</Button></div>
      </Card>) : <p className="muted">No Authority Products are currently listed.</p>}</div>
      <MaterialTablePagination page={products.page} pageSize={products.pageSize} total={products.total} totalPages={products.totalPages} pageParam="productPage" pageSizeParam="productPageSize" rangeStart={products.total ? (products.page - 1) * products.pageSize + 1 : 0} rangeEnd={Math.min(products.page * products.pageSize, products.total)} previousHref={products.page > 1 ? authorityHref(products.page - 1, products.pageSize, grants.page, grants.pageSize) : ""} nextHref={products.page < products.totalPages ? authorityHref(products.page + 1, products.pageSize, grants.page, grants.pageSize) : ""} noun="authority products" />
    </Card>
    <Card className="panel"><div className="panel-heading"><div><h2>My Provider slots</h2><p className="muted">Each slot owns one Provider and up to 100 AccessPoints. Expired slots can be renewed for 180 days.</p></div></div>
      <div className="detail-list">{providerSlots.length ? providerSlots.map((slot) => <div key={slot.id} data-clarity-mask="true">
        <span>{slot.providerId ?? "Provider not created"} · {slot.lifecycle} · expires {slot.latestEffectiveEnd}</span>
        <strong>{slot.usedAccessPoints} / {slot.maxAccessPoints} AP</strong>
        <small>Renewal cutoff: {slot.renewalCutoff}</small>
        {slot.lifecycle !== "retention_expired" && personalProviderProduct ? <Button type="button" disabled={pending} onClick={() => setRenewalSlot(slot)}>Review renewal</Button> : null}
      </div>) : <p className="muted">No personal Provider slots.</p>}</div>
      {providerSlotTotal > providerSlots.length ? <div className="notice-box">Showing {providerSlots.length} of {providerSlotTotal} slots. Use the paged Provider API for the complete inventory.</div> : null}
      {!personalProviderProduct && providerSlots.some((slot) => slot.lifecycle !== "retention_expired") ? <div className="notice-box">Renewal is unavailable because no current personal Provider product is listed.</div> : null}
    </Card>
    <PersonalProviderRenewalDialog
      slot={renewalSlot}
      product={personalProviderProduct}
      personalCreditBalanceUnits={personalCreditBalanceUnits}
      pending={pending}
      onOpenChange={(open) => { if (!open && !pending) setRenewalSlot(null); }}
      onConfirm={() => {
        if (renewalSlot && personalProviderProduct) mutation.mutate({ kind: "renew", productId: personalProviderProduct.id, slotId: renewalSlot.id });
      }}
    />
    <Card className="panel"><div className="panel-heading"><div><h2>My Grants</h2><p className="muted">The earliest-expiring eligible Grant is consumed first.</p></div></div>
      <div className="detail-list">{grants.items.length ? grants.items.map((grant) => <div key={grant.id} data-clarity-mask="true"><span>{grant.productCode ?? "detached Grant"} · {grant.effectiveEnd ?? "no expiry"}</span><strong>{grant.availableUnits} / {grant.grantedUnits} available</strong></div>) : <p className="muted">No Team creation Grant.</p>}</div>
      <MaterialTablePagination page={grants.page} pageSize={grants.pageSize} total={grants.total} totalPages={grants.totalPages} pageParam="grantPage" pageSizeParam="grantPageSize" rangeStart={grants.total ? (grants.page - 1) * grants.pageSize + 1 : 0} rangeEnd={Math.min(grants.page * grants.pageSize, grants.total)} previousHref={grants.page > 1 ? authorityHref(products.page, products.pageSize, grants.page - 1, grants.pageSize) : ""} nextHref={grants.page < grants.totalPages ? authorityHref(products.page, products.pageSize, grants.page + 1, grants.pageSize) : ""} noun="authority grants" />
      <form className="form-grid single" onSubmit={createTeam}><label>Team name<Input name="name" maxLength={120} required disabled={pending} /></label><div className="form-footer"><Button type="submit" disabled={pending || !canCreateTeam}>{pending && activeMutation?.kind === "create-team" ? "Creating..." : "Create Team"}</Button></div></form>
      {feedback ? <div className={feedback.ok ? "notice-box notice-good" : "notice-box notice-bad"} role={feedback.ok ? "status" : "alert"} data-clarity-mask="true">{feedback.text}</div> : null}
    </Card>
  </section>;
}

function PersonalProviderRenewalDialog({ slot, product, personalCreditBalanceUnits, pending, onOpenChange, onConfirm }: {
  slot: ProviderSlot | null;
  product: Product | null;
  personalCreditBalanceUnits: number;
  pending: boolean;
  onOpenChange(open: boolean): void;
  onConfirm(): void;
}) {
  const now = new Date();
  const currentEnd = slot ? new Date(slot.latestEffectiveEnd) : now;
  const estimatedStart = currentEnd > now ? currentEnd : now;
  const estimatedEnd = product ? new Date(estimatedStart.getTime() + product.grantDurationSeconds * 1_000) : estimatedStart;
  return <Dialog observabilityKey="personal-provider-renewal" open={slot !== null} onOpenChange={onOpenChange}>
    <DialogContent>
      <DialogHeader sticky>
        <DialogTitle>Confirm personal Provider renewal</DialogTitle>
        <DialogDescription>Review the exact slot, current cutoff, current listed product terms, and estimated period before purchasing.</DialogDescription>
      </DialogHeader>
      {slot && product ? <div className="detail-list" data-clarity-mask="true">
        <div><span>Slot</span><strong>{slot.id}</strong></div>
        <div><span>Current expiry</span><strong>{slot.latestEffectiveEnd}</strong></div>
        <div><span>Exact renewal cutoff</span><strong>{slot.renewalCutoff}</strong></div>
        <div><span>Current product</span><strong>{product.displayName} · {product.code}@{product.version}</strong></div>
        <div><span>Price</span><strong>{product.purchaseAmountUnits.toLocaleString("en-US")} units</strong></div>
        <div><span>Duration</span><strong>{product.grantDurationSeconds / 86_400} days</strong></div>
        <div><span>Personal credit</span><strong>{personalCreditBalanceUnits.toLocaleString("en-US")} units</strong></div>
        <div><span>Estimated period</span><strong>{estimatedStart.toISOString()} → {estimatedEnd.toISOString()}</strong></div>
      </div> : <p className="muted">Renewal terms are unavailable.</p>}
      <DialogFooter sticky>
        <DialogClose asChild><Button variant="secondary" disabled={pending}>Cancel</Button></DialogClose>
        <Button type="button" disabled={pending || !slot || !product} onClick={onConfirm}>{pending ? "Renewing..." : "Confirm renewal"}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

function PurchaseConfirmation({ product, team, personalCreditBalanceUnits }: {
  product: Product;
  team: { name: string; currentEnd: string | null; permanent: number } | undefined;
  personalCreditBalanceUnits: number;
}) {
  if (!team) return null;
  if (team.permanent) return <div className="notice-box">
    <strong>Purchase unavailable</strong>
    <p>{team.name} already has permanent Team custom Provider access, so it cannot be renewed.</p>
  </div>;
  const now = new Date();
  const currentEnd = team.currentEnd ? new Date(team.currentEnd) : null;
  const newStart = currentEnd && currentEnd > now ? currentEnd : now;
  const newEnd = new Date(newStart.getTime() + product.grantDurationSeconds * 1_000);
  return <div className="notice-box">
    <strong>Purchase confirmation</strong>
    <div className="detail-list">
      <div><span>Debit account</span><strong>Personal credit · {personalCreditBalanceUnits.toLocaleString("en-US")} units</strong></div>
      <div><span>Price</span><strong>{product.purchaseAmountUnits.toLocaleString("en-US")} units</strong></div>
      <div><span>Target Team</span><strong>{team.name}</strong></div>
      <div><span>Current expiry</span><strong>{team.permanent ? "Permanent" : team.currentEnd ?? "Not entitled"}</strong></div>
      <div><span>New period</span><strong>{newStart.toISOString()} → {newEnd.toISOString()}</strong></div>
    </div>
  </div>;
}

function authorityHref(productPage: number, productPageSize: number, grantPage: number, grantPageSize: number) {
  const params = new URLSearchParams();
  if (productPage > 1) params.set("productPage", String(productPage));
  if (productPageSize !== 20) params.set("productPageSize", String(productPageSize));
  if (grantPage > 1) params.set("grantPage", String(grantPage));
  if (grantPageSize !== 20) params.set("grantPageSize", String(grantPageSize));
  return `/user/authority${params.size ? `?${params}` : ""}`;
}
