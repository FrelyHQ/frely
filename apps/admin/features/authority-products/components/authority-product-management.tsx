"use client";

import { useRouter } from "@admin/navigation";
import * as React from "react";
import { useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@frely/ui/components/button";
import { Card } from "@frely/ui/components/card";
import { Input } from "@frely/ui/components/input";
import { SearchSelect } from "../../../pages/owner/_components/search-select";
import { createAuthorityProduct, type AuthorityProductInput } from "../api/authority-product-api";

const optionalInteger = (form: FormData, name: string) => {
  const value = String(form.get(name) ?? "").trim();
  return value ? Number(value) : null;
};

export function AuthorityProductManagement() {
  const router = useRouter();
  const [effectCode, setEffectCode] = useState<AuthorityProductInput["effectCode"]>("team_create_unit");
  const [refundMode, setRefundMode] = useState<AuthorityProductInput["refundMode"]>("none");
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const mutation = useMutation({
    mutationFn: ({ input }: { input: AuthorityProductInput; form: HTMLFormElement }) => createAuthorityProduct(input),
    retry: false,
    onSuccess: (_result, variables) => {
      variables.form.reset();
      setEffectCode("team_create_unit");
      setRefundMode("none");
      setNotice({ ok: true, text: "Draft product version created." });
      router.refresh();
    }
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    setNotice(null);
    const form = new FormData(formElement);
    const providerAccess = effectCode !== "team_create_unit";
    const input: AuthorityProductInput = {
      code: String(form.get("code")), displayName: String(form.get("displayName")), effectCode,
      grantUnits: providerAccess ? 1 : Number(form.get("grantUnits")), purchaseAmountUnits: Number(form.get("purchaseAmountUnits")),
      ...(effectCode === "user_custom_provider_access"
        ? { grantDurationDays: Number(form.get("grantDurationDays")) }
        : { grantDurationSeconds: Number(form.get("grantDurationSeconds")) }),
      maxLifetimePurchasesPerUser: optionalInteger(form, "maxLifetimePurchasesPerUser"),
      maxUnconsumedUnitsPerUser: providerAccess ? null : optionalInteger(form, "maxUnconsumedUnitsPerUser"),
      maxCurrentOwnedTeams: providerAccess ? null : optionalInteger(form, "maxCurrentOwnedTeams"),
      maxLifetimeCreatedTeams: providerAccess ? null : optionalInteger(form, "maxLifetimeCreatedTeams"),
      refundMode: providerAccess ? "none" : refundMode,
      refundDeadlineSeconds: providerAccess || refundMode === "none" ? null : optionalInteger(form, "refundDeadlineSeconds"),
      settlementHoldSeconds: Number(form.get("settlementHoldSeconds")), sellerScopeRef: String(form.get("sellerScopeRef"))
    };
    mutation.mutate({ input, form: formElement });
  }

  const pending = mutation.isPending;
  const feedback = notice ?? (mutation.error ? { ok: false, text: mutation.error instanceof Error ? mutation.error.message : "Failed to create Authority Product" } : null);

  return <Card className="panel">
    <div className="panel-heading"><div><h2>Create Draft Version</h2><p className="muted">Create Team units, Team Provider access, or personal Provider slots.</p></div></div>
    <form className="form-grid" onSubmit={submit}>
      <label>Product code<Input name="code" required disabled={pending} /></label>
      <label>Display name<Input name="displayName" required disabled={pending} /></label>
      <label>Effect<SearchSelect value={effectCode} onValueChange={(value) => { setEffectCode(value as AuthorityProductInput["effectCode"]); if (value !== "team_create_unit") setRefundMode("none"); }} disabled={pending} searchable={false} options={[{ value: "team_create_unit", label: "Team creation unit" }, { value: "team_custom_provider_access", label: "Team custom Provider access" }, { value: "user_custom_provider_access", label: "Personal Codex Provider slot" }]} /></label>
      {effectCode === "team_create_unit" ? <label>Grant units<Input name="grantUnits" type="number" min="1" required disabled={pending} /></label> : null}
      <label>Purchase amount units<Input name="purchaseAmountUnits" type="number" min="1" required disabled={pending} /></label>
      {effectCode === "user_custom_provider_access"
        ? <label>Grant duration days<Input name="grantDurationDays" type="number" min="1" max="3650" step="1" defaultValue={365} required disabled={pending} /></label>
        : <label>Grant duration seconds<Input name="grantDurationSeconds" type="number" min="1" step="1" required disabled={pending} /></label>}
      <label>Settlement hold seconds<Input name="settlementHoldSeconds" type="number" min="1" required disabled={pending} /></label>
      <label>Seller scope<Input name="sellerScopeRef" placeholder="global: or user:..." required disabled={pending} /></label>
      {effectCode === "team_create_unit" ? <label>Refund mode<SearchSelect value={refundMode} onValueChange={(value) => setRefundMode(value as AuthorityProductInput["refundMode"])} disabled={pending} searchable={false} options={[{ value: "none", label: "No refund" }, { value: "unused_by_owner", label: "Owner refund while unused" }]} /></label> : null}
      {effectCode === "team_create_unit" ? <label>Refund deadline seconds<Input name="refundDeadlineSeconds" type="number" min="1" disabled={pending} /></label> : null}
      <label>Lifetime purchases / user<Input name="maxLifetimePurchasesPerUser" type="number" min={effectCode === "user_custom_provider_access" ? 2 : 1} disabled={pending} /></label>
      {effectCode === "team_create_unit" ? <label>Unconsumed units / user<Input name="maxUnconsumedUnitsPerUser" type="number" min="1" disabled={pending} /></label> : null}
      {effectCode === "team_create_unit" ? <label>Current owned Teams<Input name="maxCurrentOwnedTeams" type="number" min="1" disabled={pending} /></label> : null}
      {effectCode === "team_create_unit" ? <label>Lifetime created Teams<Input name="maxLifetimeCreatedTeams" type="number" min="1" disabled={pending} /></label> : null}
      <div className="form-footer">{feedback ? <span className={feedback.ok ? "notice-box notice-good" : "notice-box notice-bad"}>{feedback.text}</span> : null}<Button type="submit" disabled={pending}>{pending ? "Creating..." : "Create draft"}</Button></div>
    </form>
  </Card>;
}
