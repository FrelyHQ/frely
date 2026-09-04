"use client";

import * as React from "react";
import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "@web/navigation";
import { MaterialTable } from "@frely/console-ui/material-table";
import { MaterialTablePagination } from "@frely/console-ui/material-table-pagination";
import { SearchSelect } from "@frely/console-ui/search-select";
import { Badge } from "@frely/ui/components/badge";
import { BrowserTime } from "@frely/ui/components/browser-time";
import { Button } from "@frely/ui/components/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@frely/ui/components/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@frely/ui/components/dialog";
import { Field, FieldDescription, FieldLabel } from "@frely/ui/components/field";
import { Input } from "@frely/ui/components/input";
import { Textarea } from "@frely/ui/components/textarea";
import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { cardExpiryPresentation } from "../../../lib/card-purchase-ui";
import { mutateCard } from "../api/cards-api";
import { sendCardDefaults, toSendCardInput, validateRecipient } from "../form/send-card-values";
import { cardsInventoryStatusHref, cardsPageHref, parseCardsUrlState } from "../lib/cards-url-state";
import {
  cardInventoryQueryOptions,
  cardsQueryKey,
  cardTransfersQueryOptions,
  planCardsQueryOptions,
} from "../query/cards-query";
import type { CardActionReasonCode, PlanCardInventoryItem, UserCard } from "../types";

type CardAction =
  | { kind: "use"; card: UserCard }
  | { kind: "send"; card: UserCard; step: "recipient" | "confirm" };
type SendCardForm = ReturnType<typeof useSendCardForm>;

export function UserCards() {
  const queryClient = useQueryClient();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { inventoryStatus, page: inventoryPage, pageSize: inventoryPageSize, transferPage, transferPageSize } = parseCardsUrlState(searchParams);
  const inventoryQuery = useQuery(cardInventoryQueryOptions(inventoryStatus, inventoryPage, inventoryPageSize));
  const transfersQuery = useQuery(cardTransfersQueryOptions(transferPage, transferPageSize));
  const [selectedPlan, setSelectedPlan] = useState<PlanCardInventoryItem | null>(null);
  const [planPage, setPlanPage] = useState(1);
  const [planPageSize, setPlanPageSize] = useState(20);
  const [action, setAction] = useState<CardAction | null>(null);
  const form = useSendCardForm();
  const planCardsQuery = useQuery({
    ...planCardsQueryOptions(selectedPlan?.planId ?? "", planPage, planPageSize),
    enabled: selectedPlan !== null,
  });
  const canSetReferenceCode = inventoryQuery.data?.canSetReferenceCode ?? false;

  const mutation = useMutation({
    mutationFn: mutateCard,
    retry: false,
    onSuccess: async (_result, input) => {
      setAction(null);
      form.reset();
      const invalidations = [
        queryClient.invalidateQueries({ queryKey: [...cardsQueryKey, "inventory"] }),
      ];
      if (selectedPlan) {
        invalidations.push(queryClient.invalidateQueries({
          queryKey: [...cardsQueryKey, "plan", selectedPlan.planId],
        }));
      }
      if (input.kind === "send") {
        invalidations.push(queryClient.invalidateQueries({ queryKey: [...cardsQueryKey, "transfers"] }));
      }
      await Promise.all(invalidations);
    },
  });

  useEffect(() => {
    if (!selectedPlan || inventoryQuery.isFetching) return;
    const stillOwned = inventoryQuery.data?.items.some(
      (item) => item.kind === "plan" && item.planId === selectedPlan.planId,
    );
    if (!stillOwned) {
      setSelectedPlan(null);
      setPlanPage(1);
    }
  }, [inventoryQuery.data, inventoryQuery.isFetching, selectedPlan]);

  const saving = mutation.isPending;
  const error = inventoryQuery.error ?? transfersQuery.error ?? planCardsQuery.error ?? mutation.error;

  function setUrlPage(key: "page" | "transferPage", page: number) {
    router.replace(cardsPageHref(searchParams, key, page));
  }

  function beginAction(kind: "use" | "send", card: UserCard) {
    if (kind === "use") setAction({ kind, card });
    else {
      form.reset();
      setAction({ kind, card, step: "recipient" });
    }
  }

  return (
    <>
      {error ? (
        <div className="notice-box notice-bad" role="alert" data-clarity-mask="true">
          {error instanceof Error ? error.message : "Card request failed"}
        </div>
      ) : null}

      <section className="card-status-section" aria-labelledby="card-inventory">
        <div className="panel-heading">
          <div>
            <h2 id="card-inventory">Card inventory</h2>
            <p className="muted">Each Plan appears once. Open it to view and act on individual Cards.</p>
          </div>
          <Badge variant="info">{inventoryQuery.data?.total ?? 0}</Badge>
        </div>
        <div className="compact-filter-bar" aria-label="Card inventory filters">
          <label className="compact-filter-field" data-size="status">
            Status
            <SearchSelect
              ariaLabel="Card inventory status"
              searchable={false}
              value={inventoryStatus}
              options={[
                { value: "available", label: "Available" },
                { value: "all", label: "All Cards" },
              ]}
              onValueChange={(value) => {
                if (value === "available" || value === "all") {
                  router.replace(cardsInventoryStatusHref(searchParams, value));
                }
              }}
            />
          </label>
        </div>
        {inventoryQuery.isPending ? (
          <Card>
            <CardHeader>
              <CardTitle>Loading cards…</CardTitle>
              <CardDescription>Checking your Card inventory.</CardDescription>
            </CardHeader>
          </Card>
        ) : inventoryQuery.data?.items.length ? (
          <>
            <div className="card-grid">
              {inventoryQuery.data.items.map((item) => item.kind === "plan" ? (
                <PlanInventoryCard
                  item={item}
                  key={item.planId}
                  onOpen={() => {
                    setSelectedPlan(item);
                    setPlanPage(1);
                  }}
                />
              ) : (
                <CreditInventoryCard
                  card={item.card}
                  key={item.card.id}
                  onUse={() => beginAction("use", item.card)}
                  onSend={() => beginAction("send", item.card)}
                />
              ))}
            </div>
            <MaterialTablePagination
              noun="inventory items"
              page={inventoryQuery.data.page}
              pageSize={inventoryQuery.data.pageSize}
              total={inventoryQuery.data.total}
              totalPages={inventoryQuery.data.totalPages}
              rangeStart={(inventoryQuery.data.page - 1) * inventoryQuery.data.pageSize + 1}
              rangeEnd={Math.min(inventoryQuery.data.page * inventoryQuery.data.pageSize, inventoryQuery.data.total)}
              {...(inventoryQuery.data.page > 1 ? { onPrevious: () => setUrlPage("page", inventoryQuery.data!.page - 1) } : {})}
              {...(inventoryQuery.data.page < inventoryQuery.data.totalPages ? { onNext: () => setUrlPage("page", inventoryQuery.data!.page + 1) } : {})}
            />
          </>
        ) : (
          <Card>
            <CardHeader>
              <CardTitle>{inventoryStatus === "available" ? "No available Cards" : "No Cards yet"}</CardTitle>
              <CardDescription>{inventoryStatus === "available" ? "Choose All Cards to review used, expired, replaced, or unavailable Cards." : "Purchased or granted Cards will appear here."}</CardDescription>
            </CardHeader>
          </Card>
        )}
      </section>

      <section className="card-status-section" aria-labelledby="card-transfer-history">
        <div className="panel-heading">
          <div>
            <h2 id="card-transfer-history">Transfer history</h2>
            <p className="muted">Cards you sent or received, including messages visible to both participants.</p>
          </div>
          <Badge variant="neutral">{transfersQuery.data?.total ?? 0}</Badge>
        </div>
        {transfersQuery.isPending ? (
          <Card><CardHeader><CardTitle>Loading transfers…</CardTitle></CardHeader></Card>
        ) : transfersQuery.data?.items.length ? (
          <>
            <div className="card-grid">
              {transfersQuery.data.items.map((transfer) => {
                const sent = transfer.fromUserId === transfersQuery.data?.viewerUserId;
                return (
                  <Card key={transfer.id}>
                    <CardHeader>
                      <CardTitle>{sent ? "Sent Card" : "Received Card"}</CardTitle>
                      <CardDescription><span data-clarity-mask="true"><BrowserTime value={transfer.createdAt} /></span></CardDescription>
                    </CardHeader>
                    <CardContent>
                      <div className="detail-list">
                        <div><span>Card ID</span><code data-clarity-mask="true">{transfer.cardId}</code></div>
                        <div><span>{sent ? "Recipient" : "Sender"}</span><code data-clarity-mask="true">{sent ? transfer.toUserId : transfer.fromUserId}</code></div>
                        {transfer.referenceCode ? <div><span>Reference</span><code data-clarity-mask="true">{transfer.referenceCode}</code></div> : null}
                        {transfer.note ? <div><span>Message</span><strong data-clarity-mask="true">{transfer.note}</strong></div> : null}
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
            <MaterialTablePagination
              noun="transfers"
              page={transfersQuery.data.page}
              pageSize={transfersQuery.data.pageSize}
              pageParam="transferPage"
              pageSizeParam="transferPageSize"
              total={transfersQuery.data.total}
              totalPages={transfersQuery.data.totalPages}
              rangeStart={(transfersQuery.data.page - 1) * transfersQuery.data.pageSize + 1}
              rangeEnd={Math.min(transfersQuery.data.page * transfersQuery.data.pageSize, transfersQuery.data.total)}
              {...(transfersQuery.data.page > 1 ? { onPrevious: () => setUrlPage("transferPage", transfersQuery.data!.page - 1) } : {})}
              {...(transfersQuery.data.page < transfersQuery.data.totalPages ? { onNext: () => setUrlPage("transferPage", transfersQuery.data!.page + 1) } : {})}
            />
          </>
        ) : (
          <Card>
            <CardHeader>
              <CardTitle>No transfers yet</CardTitle>
              <CardDescription>Cards sent between users appear here even when no message is included.</CardDescription>
            </CardHeader>
          </Card>
        )}
      </section>

      <Dialog
        observabilityKey="plan-card-list"
        open={selectedPlan !== null && action === null}
        onOpenChange={(open) => {
          if (!open && !saving) {
            setSelectedPlan(null);
            setPlanPage(1);
          }
        }}
      >
        <DialogContent className="w-[min(1120px,calc(100vw-32px))]">
          <DialogHeader sticky>
            <DialogTitle>{selectedPlan ? <span data-clarity-mask="true">{planLabel(selectedPlan.planName, selectedPlan.planVersion)}</span> : "Plan Cards"}</DialogTitle>
            <DialogDescription data-clarity-mask={selectedPlan ? "true" : undefined}>
              {selectedPlan ? `${selectedPlan.totalCount} Card${selectedPlan.totalCount === 1 ? "" : "s"} currently in your inventory.` : "Individual Plan Cards."}
            </DialogDescription>
          </DialogHeader>
          {planCardsQuery.isPending ? (
            <p className="muted">Loading Plan Cards…</p>
          ) : (
            <>
              <MaterialTable
                columns={[
                  { header: "Card", minWidth: 180 },
                  { header: "Source" },
                  { header: "Status" },
                  { header: "Created", minWidth: 160 },
                  { header: "Expires", minWidth: 160 },
                  { header: "Replacement", minWidth: 190 },
                  { header: "Actions", minWidth: 180 },
                ]}
                rows={(planCardsQuery.data?.items ?? []).map((card) => ({
                  id: card.id,
                  cells: [
                    <code data-clarity-mask="true">{card.id}</code>,
                    card.issuanceType === "admin_grant" ? "Admin grant" : card.issuanceType === "external_activation" ? "External activation" : "Purchase",
                    <CardStatusBadge status={card.status} />,
                    <span data-clarity-mask="true"><BrowserTime value={card.createdAt} /></span>,
                    <span data-clarity-mask="true"><BrowserTime value={card.expiresAt} /></span>,
                    <>
                      {card.replacesCardId ? <div><span className="muted">Replaces </span><code data-clarity-mask="true">{card.replacesCardId}</code></div> : null}
                      {card.replacedByCardId ? <div><span className="muted">By </span><code data-clarity-mask="true">{card.replacedByCardId}</code></div> : null}
                      {!card.replacesCardId && !card.replacedByCardId ? "—" : null}
                    </>,
                    <div className="card-actions">
                      {card.canUse ? <Button size="sm" onClick={() => beginAction("use", card)}>Use</Button> : null}
                      {card.canSend ? <Button size="sm" variant="secondary" onClick={() => beginAction("send", card)}>Send</Button> : null}
                      {!card.canUse && !card.canSend ? <span className="muted">{actionReason(card.useReasonCode ?? card.sendReasonCode)}</span> : null}
                      {card.canUse && !card.canSend ? <span className="muted">{actionReason(card.sendReasonCode)}</span> : null}
                    </div>,
                  ],
                }))}
                emptyState={{ title: "No Plan Cards", description: "This Plan no longer has Cards in your inventory." }}
                table={{ density: "compact", minWidth: 1120 }}
              />
              {planCardsQuery.data ? (
                <MaterialTablePagination
                  noun="Plan Cards"
                  page={planCardsQuery.data.page}
                  pageSize={planCardsQuery.data.pageSize}
                  total={planCardsQuery.data.total}
                  totalPages={planCardsQuery.data.totalPages}
                  rangeStart={planCardsQuery.data.total ? (planCardsQuery.data.page - 1) * planCardsQuery.data.pageSize + 1 : 0}
                  rangeEnd={Math.min(planCardsQuery.data.page * planCardsQuery.data.pageSize, planCardsQuery.data.total)}
                  {...(planCardsQuery.data.page > 1 ? { onPrevious: () => setPlanPage(planCardsQuery.data!.page - 1) } : {})}
                  {...(planCardsQuery.data.page < planCardsQuery.data.totalPages ? { onNext: () => setPlanPage(planCardsQuery.data!.page + 1) } : {})}
                  onPageSizeChange={(nextPageSize) => { setPlanPage(1); setPlanPageSize(nextPageSize); }}
                />
              ) : null}
            </>
          )}
          <DialogFooter sticky>
            <DialogClose asChild><Button variant="secondary">Close</Button></DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <CardActionDialog
        action={action}
        canSetReferenceCode={canSetReferenceCode}
        form={form}
        mutation={mutation}
        saving={saving}
        onActionChange={setAction}
      />
    </>
  );
}

function PlanInventoryCard({ item, onOpen }: { item: PlanCardInventoryItem; onOpen: () => void }) {
  return (
    <Card
      role="button"
      tabIndex={0}
      aria-label={`Open ${planLabel(item.planName, item.planVersion)} Cards`}
      className="cursor-pointer"
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
    >
      <CardHeader>
        <div className="panel-heading">
          <CardTitle><span data-clarity-mask="true">{planLabel(item.planName, item.planVersion)}</span></CardTitle>
          <Badge variant={item.planStatus === "enabled" ? "good" : item.planStatus === "closed" ? "warn" : "bad"}>
            {item.planStatus}
          </Badge>
        </div>
        <CardDescription data-clarity-mask="true">{item.totalCount} individual Card{item.totalCount === 1 ? "" : "s"} in this Plan.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="detail-list">
          <div><span>Available</span><strong data-clarity-mask="true">{item.availableCount}</strong></div>
          {item.replacedCount ? <div><span>Replaced</span><strong data-clarity-mask="true">{item.replacedCount}</strong></div> : null}
          {item.invalidatedCount ? <div><span>Invalidated</span><strong data-clarity-mask="true">{item.invalidatedCount}</strong></div> : null}
          {item.usedCount ? <div><span>Used</span><strong data-clarity-mask="true">{item.usedCount}</strong></div> : null}
          {item.expiredCount ? <div><span>Expired</span><strong data-clarity-mask="true">{item.expiredCount}</strong></div> : null}
          {item.nearestAvailableExpiresAt ? <div><span>Earliest available expiry</span><strong data-clarity-mask="true"><BrowserTime value={item.nearestAvailableExpiresAt} /></strong></div> : null}
        </div>
      </CardContent>
      <CardFooter><span className="muted">Open to view individual Cards</span></CardFooter>
    </Card>
  );
}

function CreditInventoryCard({
  card,
  onUse,
  onSend,
}: {
  card: UserCard;
  onUse: () => void;
  onSend: () => void;
}) {
  return (
    <Card>
      <CardHeader>
        <div className="panel-heading">
          <CardTitle><span data-clarity-mask="true">{card.creditProductName}</span></CardTitle>
          <Badge variant="info">Credit Card</Badge>
        </div>
        <CardDescription>{cardStatusDescription(card)}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="detail-list">
          <div><span>Value</span><strong data-clarity-mask="true">{formatCredit(card.creditAmountUnits ?? 0)}</strong></div>
          <div><span>Card ID</span><code data-clarity-mask="true">{card.id}</code></div>
          <div><span>Status</span><CardStatusBadge status={card.status} /></div>
          {card.status === "available" ? (
            <>
              <div><span>Expires</span><strong data-clarity-mask="true"><BrowserTime value={card.expiresAt} /></strong></div>
              <div><span>Remaining</span><ExpiryBadge expiresAt={card.expiresAt} /></div>
            </>
          ) : null}
        </div>
      </CardContent>
      {card.canUse || card.canSend ? (
        <CardFooter className="card-actions">
          {card.canUse ? <Button onClick={onUse}>Use</Button> : null}
          {card.canSend ? <Button variant="secondary" onClick={onSend}>Send</Button> : null}
        </CardFooter>
      ) : null}
    </Card>
  );
}

function CardActionDialog({
  action,
  canSetReferenceCode,
  form,
  mutation,
  saving,
  onActionChange,
}: {
  action: CardAction | null;
  canSetReferenceCode: boolean;
  form: SendCardForm;
  mutation: ReturnType<typeof useMutation<unknown, Error, import("../types").CardMutationInput>>;
  saving: boolean;
  onActionChange: (action: CardAction | null) => void;
}) {
  const identity = action ? cardIdentity(action.card) : "";
  return (
    <Dialog observabilityKey="card-action" open={action !== null} onOpenChange={(open) => { if (!open && !saving) onActionChange(null); }}>
      <DialogContent>
        {action?.kind === "use" ? (
          <>
            <DialogHeader sticky>
              <DialogTitle>Use <span data-clarity-mask="true">{identity}</span>?</DialogTitle>
              <DialogDescription>
                This one-time action cannot be undone. {action.card.cardType === "plan" ? "The Plan subscription starts immediately." : `${formatCredit(action.card.creditAmountUnits ?? 0)} will enter your balance.`}
              </DialogDescription>
            </DialogHeader>
            <div className="detail-list">
              <div><span>Product</span><strong data-clarity-mask="true">{identity}</strong></div>
              <div><span>Card ID</span><code data-clarity-mask="true">{action.card.id}</code></div>
              <div><span>Expires</span><strong data-clarity-mask="true"><BrowserTime value={action.card.expiresAt} /></strong></div>
            </div>
            <DialogFooter sticky feedback={<MutationFeedback error={mutation.error} />}>
              <DialogClose asChild><Button variant="secondary" disabled={saving}>Cancel</Button></DialogClose>
              <Button disabled={saving} onClick={() => mutation.mutate({ kind: "use", cardId: action.card.id })}>
                {saving ? "Using…" : "Confirm use"}
              </Button>
            </DialogFooter>
          </>
        ) : action?.kind === "send" && action.step === "recipient" ? (
          <>
            <DialogHeader sticky>
              <DialogTitle>Send <span data-clarity-mask="true">{identity}</span></DialogTitle>
              <DialogDescription>Enter the exact user ID. User lookup is intentionally unavailable.</DialogDescription>
            </DialogHeader>
            <div className="detail-list">
              <div><span>Product</span><strong data-clarity-mask="true">{identity}</strong></div>
              <div><span>Card ID</span><code data-clarity-mask="true">{action.card.id}</code></div>
            </div>
            <form.Field name="recipientUserId" validators={{ onBlur: ({ value }) => validateRecipient(value) }}>
              {(field) => (
                <Field>
                  <FieldLabel htmlFor="recipient-user-id">Recipient user ID</FieldLabel>
                  <Input id="recipient-user-id" autoComplete="off" value={field.state.value} onBlur={field.handleBlur} onChange={(event) => field.handleChange(event.target.value)} placeholder="user_…" />
                  <FieldDescription>The recipient must already exist and be enabled.</FieldDescription>
                  {field.state.meta.errors.map((fieldError) => <span className="field-error" key={String(fieldError)}>{String(fieldError)}</span>)}
                </Field>
              )}
            </form.Field>
            {canSetReferenceCode ? (
              <form.Field name="referenceCode">
                {(field) => (
                  <Field>
                    <FieldLabel htmlFor="transfer-reference-code">Reference code (optional)</FieldLabel>
                    <Input id="transfer-reference-code" autoComplete="off" maxLength={100} value={field.state.value} onBlur={field.handleBlur} onChange={(event) => field.handleChange(event.target.value)} placeholder="activity-2026-summer" />
                    <FieldDescription>Available because you own an enabled Team.</FieldDescription>
                  </Field>
                )}
              </form.Field>
            ) : null}
            <form.Field name="note">
              {(field) => (
                <Field>
                  <FieldLabel htmlFor="transfer-note">Message (optional)</FieldLabel>
                  <Textarea id="transfer-note" maxLength={500} rows={4} value={field.state.value} onBlur={field.handleBlur} onChange={(event) => field.handleChange(event.target.value)} placeholder="Why you are sending this Card…" />
                  <FieldDescription>This message is visible only to you and this recipient.</FieldDescription>
                </Field>
              )}
            </form.Field>
            <DialogFooter sticky feedback={<MutationFeedback error={mutation.error} />}>
              <DialogClose asChild><Button variant="secondary">Cancel</Button></DialogClose>
              <form.Subscribe selector={(state) => state.values.recipientUserId}>
                {(recipient) => <Button disabled={!recipient.trim()} onClick={() => onActionChange({ ...action, step: "confirm" })}>Review recipient</Button>}
              </form.Subscribe>
            </DialogFooter>
          </>
        ) : action?.kind === "send" ? (
          <>
            <DialogHeader sticky>
              <DialogTitle>Confirm irreversible send</DialogTitle>
              <DialogDescription>Sending is immediate. You lose control of this Card, it cannot be recalled, and its expiration does not change.</DialogDescription>
            </DialogHeader>
            <div className="detail-list">
              <div><span>Product</span><strong data-clarity-mask="true">{identity}</strong></div>
              <div><span>Recipient user ID</span><code data-clarity-mask="true">{form.state.values.recipientUserId.trim()}</code></div>
              <div><span>Card ID</span><code data-clarity-mask="true">{action.card.id}</code></div>
              {canSetReferenceCode && form.state.values.referenceCode.trim() ? <div><span>Reference</span><code data-clarity-mask="true">{form.state.values.referenceCode.trim()}</code></div> : null}
              {form.state.values.note.trim() ? <div><span>Message</span><strong data-clarity-mask="true">{form.state.values.note.trim()}</strong></div> : null}
              <div><span>Expires</span><strong data-clarity-mask="true"><BrowserTime value={action.card.expiresAt} /></strong></div>
            </div>
            <DialogFooter sticky feedback={<MutationFeedback error={mutation.error} />}>
              <Button variant="secondary" disabled={saving} onClick={() => onActionChange({ ...action, step: "recipient" })}>Back</Button>
              <Button
                variant="warning"
                disabled={saving}
                onClick={() => mutation.mutate(toSendCardInput(action.card.id, form.state.values, canSetReferenceCode))}
              >
                {saving ? "Sending…" : "Send permanently"}
              </Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function MutationFeedback({ error }: { error: Error | null }) {
  return error ? <div className="notice-box notice-bad" role="alert" data-clarity-mask="true">{error.message}</div> : null;
}

function useSendCardForm() {
  return useForm({ defaultValues: sendCardDefaults });
}

function CardStatusBadge({ status }: { status: UserCard["status"] }) {
  const variant = status === "available" ? "good" : status === "replaced" ? "warn" : status === "used" ? "neutral" : "bad";
  return <Badge variant={variant}>{status}</Badge>;
}

function ExpiryBadge({ expiresAt }: { expiresAt: string }) {
  const expiry = cardExpiryPresentation(expiresAt);
  const label = `${expiry.remainingDays} day${expiry.remainingDays === 1 ? "" : "s"} remaining`;
  if (expiry.urgency === "warning") return <Badge variant="warn">Warning: {label}</Badge>;
  if (expiry.urgency === "notice") return <Badge variant="info">Expires soon: {label}</Badge>;
  return <Badge variant="neutral">{label}</Badge>;
}

function planLabel(name: string, version: number) {
  return `${name} · v${version}`;
}

function cardIdentity(card: UserCard) {
  if (card.cardType === "plan") return planLabel(card.planName ?? "Plan", card.planVersion ?? 0);
  return card.creditProductName ?? "Credit Card";
}

function actionReason(code: CardActionReasonCode | null) {
  if (code === "plan_closed") return "Plan closed";
  if (code === "plan_disabled") return "Plan disabled";
  if (code === "card_replaced") return "Replaced";
  if (code === "card_invalidated") return "Invalidated";
  if (code === "card_used") return "Used";
  if (code === "card_expired") return "Expired";
  return "Unavailable";
}

function cardStatusDescription(card: UserCard) {
  if (card.status === "replaced") return "Replaced by a newer Plan Card";
  if (card.status === "invalidated") return "Invalidated after a payment refund or dispute";
  if (card.status === "used") return card.usedAt ? <>Used <BrowserTime value={card.usedAt} /></> : "Used";
  if (card.status === "expired") return <>Expired <BrowserTime value={card.expiresAt} /></>;
  return <>Available since <BrowserTime value={card.createdAt} /></>;
}

function formatCredit(units: number) {
  return `$${(units / 1_000_000).toFixed(6).replace(/\.?0+$/, "")}`;
}
