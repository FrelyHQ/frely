"use client";

import { useMemo, useState } from "react";
import { Notice, StatusBadge } from "@frely/console-ui";
import { Button } from "@frely/ui/components/button";
import { AccessPointDescription } from "@frely/console-ui/access-point-description";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@frely/ui/components/card";
import { Spinner } from "@frely/ui/components/spinner";
import { useMutation } from "@tanstack/react-query";
import { useRouter } from "@web/navigation";
import { moveAccessOrder, saveAccessOrder } from "../api/access-order-api";
import { hasAccessOrderChanged, moveAccessOrderItem, moveAccessOrderItemByOffset, toSaveAccessOrderInput, type AccessOrderPlacement } from "../lib/access-order-values";
import type { AccessOrderItem } from "../types";

interface DropTarget {
  id: string;
  placement: AccessOrderPlacement;
}

export function AccessOrderList({
  initialItems,
  mode,
  previousOrderId,
  nextOrderId
}: {
  initialItems: AccessOrderItem[];
  mode: "replace" | "relative";
  previousOrderId: string | null;
  nextOrderId: string | null;
}) {
  const router = useRouter();
  const [items, setItems] = useState(initialItems);
  const [selectedModel, setSelectedModel] = useState(() => initialItems[0]?.exposedModel ?? "");
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const [savedOrderByModel, setSavedOrderByModel] = useState<Record<string, string[]>>(() => accessOrderSnapshot(initialItems));
  const mutation = useMutation({ mutationFn: saveAccessOrder, retry: false });
  const relativeMutation = useMutation({
    mutationFn: moveAccessOrder,
    retry: false,
    onSuccess: () => router.refresh(),
    onError: () => {
      setItems(initialItems);
      router.refresh();
    }
  });
  const isPending = mutation.isPending || relativeMutation.isPending;
  const models = useMemo(() => Array.from(new Set(items.map((item) => item.exposedModel))), [items]);

  if (!models.length) {
    return (
      <Card className="access-order-empty">
        <CardHeader>
          <CardTitle>No Plan sources yet</CardTitle>
          <CardDescription>Access order becomes available after a Plan source exposes a model to this user.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const activeModel = models.includes(selectedModel) ? selectedModel : models[0]!;
  const activeGroup = items.filter((item) => item.exposedModel === activeModel);
  const activeSavedOrder = savedOrderByModel[activeModel] ?? [];
  const activeIsDirty = mode === "replace" && hasAccessOrderChanged(items, activeModel, activeSavedOrder);
  const activeIsSaving = mutation.isPending && mutation.variables?.model === activeModel;
  const activeSaveSucceeded = mutation.isSuccess && mutation.data.model === activeModel;
  const activeSaveFailed = mutation.isError && mutation.variables?.model === activeModel;

  function selectModel(model: string) {
    if (isPending || model === activeModel) return;
    mutation.reset();
    setDraggedId(null);
    setDropTarget(null);
    setSelectedModel(model);
  }

  function moveByOffset(itemId: string, offset: -1 | 1) {
    mutation.reset();
    const group = items.filter((item) => item.exposedModel === activeModel);
    const index = group.findIndex((item) => item.id === itemId);
    if (mode === "relative") {
      const anchorId = offset === -1
        ? group[index - 1]?.id ?? previousOrderId
        : group[index + 1]?.id ?? nextOrderId;
      if (!anchorId) return;
      setItems((current) => moveAccessOrderItemByOffset(current, activeModel, itemId, offset));
      relativeMutation.mutate({ model: activeModel, orderId: itemId, placement: offset === -1 ? "before" : "after", anchorId });
      return;
    }
    setItems((current) => moveAccessOrderItemByOffset(current, activeModel, itemId, offset));
  }

  function moveRelative(itemId: string, placement: AccessOrderPlacement, anchorId: string | null) {
    relativeMutation.reset();
    setItems((current) => {
      const group = current.filter((item) => item.exposedModel === activeModel && item.id !== itemId);
      const localAnchorId = anchorId ?? (placement === "before" ? group[0]?.id : group.at(-1)?.id);
      return localAnchorId ? moveAccessOrderItem(current, activeModel, itemId, localAnchorId, placement) : current;
    });
    relativeMutation.mutate({ model: activeModel, orderId: itemId, placement, anchorId });
  }

  function saveCurrentOrder() {
    const input = toSaveAccessOrderInput(items, activeModel);
    mutation.mutate(input, {
      onSuccess: () => {
        setSavedOrderByModel((current) => ({ ...current, [activeModel]: input.orderedPlanScopeIds }));
      }
    });
  }

  return (
    <section className="access-order-workspace" aria-label="Access order workspace">
      <nav className="access-order-models" aria-label="Models with configurable access order">
        <div className="access-order-models-heading">
          <span className="access-order-kicker">Models</span>
          <strong>{models.length}</strong>
        </div>
        <p>Select one model to edit its fallback sequence.</p>
        <div className="access-order-model-list">
          {models.map((model) => {
            const group = items.filter((item) => item.exposedModel === model);
            const availableCount = group.filter((item) => item.status === "available").length;
            const isDirty = hasAccessOrderChanged(items, model, savedOrderByModel[model] ?? []);
            const isActive = model === activeModel;
            return (
              <button
                type="button"
                className="access-order-model-button"
                data-active={isActive || undefined}
                aria-current={isActive ? "true" : undefined}
                onClick={() => selectModel(model)}
                disabled={isPending}
                key={model}
              >
                <span className="access-order-model-name">{model}</span>
                <span className="access-order-model-meta">{group.length} sources · {availableCount} available</span>
                {isDirty ? <span className="access-order-unsaved">Unsaved</span> : null}
              </button>
            );
          })}
        </div>
      </nav>

      <Card className="access-order-editor">
        <CardHeader className="access-order-editor-header">
          <div className="access-order-editor-copy">
            <span className="access-order-kicker">Selected model</span>
            <CardTitle>{activeModel}</CardTitle>
            <CardDescription>Requests try the first available source, then continue down this list when its Subscription budget or PayGo balance is exhausted.</CardDescription>
          </div>
          <div className="access-order-editor-actions">
            <StatusBadge tone={activeIsDirty ? "warn" : "neutral"}>{mode === "relative" ? "Saved immediately" : activeIsDirty ? "Unsaved changes" : `${activeGroup.length} sources`}</StatusBadge>
            {mode === "replace" ? <Button onClick={saveCurrentOrder} disabled={!activeIsDirty || mutation.isPending}>
              {activeIsSaving ? <Spinner data-icon="inline-start" /> : null}
              {activeIsSaving ? "Saving..." : "Save changes"}
            </Button> : null}
          </div>
        </CardHeader>

        <CardContent className="access-order-editor-content">
          {activeSaveSucceeded ? <Notice tone="good" live="status">Order saved for {activeModel}.</Notice> : null}
          {activeSaveFailed ? <Notice tone="bad" live="alert">{mutation.error instanceof Error ? mutation.error.message : "Failed to save access order"}</Notice> : null}
          {relativeMutation.isSuccess ? <Notice tone="good" live="status">Source moved and saved.</Notice> : null}
          {relativeMutation.isError ? <Notice tone="bad" live="alert">{relativeMutation.error instanceof Error ? relativeMutation.error.message : "Failed to move access order source"}</Notice> : null}

          <div className="access-order-sequence-heading" aria-hidden="true">
            <span>Priority sequence</span>
            <span>Top source is tried first</span>
          </div>

          <ol className="access-order-source-list" aria-label={`${activeModel} source priority`}>
            {activeGroup.map((item, index) => {
              const isDragging = draggedId === item.id;
              const itemDropTarget = dropTarget?.id === item.id ? dropTarget.placement : undefined;
              return (
                <li
                  className="access-order-source"
                  data-dragging={isDragging || undefined}
                  data-drop-placement={itemDropTarget}
                  key={item.id}
                  draggable={!isPending && activeGroup.length > 1}
                  onDragStart={(event) => {
                    event.dataTransfer.effectAllowed = "move";
                    event.dataTransfer.setData("text/plain", item.id);
                    setDraggedId(item.id);
                  }}
                  onDragEnd={() => {
                    setDraggedId(null);
                    setDropTarget(null);
                  }}
                  onDragOver={(event) => {
                    if (!draggedId || draggedId === item.id) return;
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "move";
                    const bounds = event.currentTarget.getBoundingClientRect();
                    const placement: AccessOrderPlacement = event.clientY >= bounds.top + bounds.height / 2 ? "after" : "before";
                    setDropTarget((current) => current?.id === item.id && current.placement === placement ? current : { id: item.id, placement });
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    if (draggedId && draggedId !== item.id) {
                      const bounds = event.currentTarget.getBoundingClientRect();
                      const placement: AccessOrderPlacement = event.clientY >= bounds.top + bounds.height / 2 ? "after" : "before";
                      mutation.reset();
                      setItems((current) => moveAccessOrderItem(current, activeModel, draggedId, item.id, placement));
                      if (mode === "relative") moveRelative(draggedId, placement, item.id);
                    }
                    setDraggedId(null);
                    setDropTarget(null);
                  }}
                  aria-label={`${index + 1}. ${item.planName}${item.subscriptionScopeRef ? ` from ${item.subscriptionScopeRef}` : ""}`}
                >
                  <div className="access-order-rank" aria-hidden="true">
                    <span className="access-order-drag-handle">⠿</span>
                    <strong>{String(index + 1).padStart(2, "0")}</strong>
                  </div>

                  <div className="access-order-source-body">
                    <div className="access-order-source-summary">
                      <div className="access-order-source-identity">
                        <strong>{item.planName}</strong>
                        {item.subscriptionScopeRef ? <code title={item.subscriptionScopeRef}>{item.subscriptionScopeRef}</code> : <span className="muted">Scope unavailable</span>}
                      </div>
                      <StatusBadge tone={item.status === "available" ? "good" : item.status === "invalid_configuration" ? "bad" : "warn"}>
                        {item.status === "available"
                          ? "Available"
                          : item.configurationError === "overlapping_active_subscriptions"
                            ? "Overlapping active Subscriptions"
                            : item.configurationError === "multiple_entry_access_points"
                              ? "Multiple entry AccessPoints"
                              : item.configurationError === "entry_access_point_missing"
                                ? "Entry AccessPoint missing"
                                : "Unavailable"}
                      </StatusBadge>
                    </div>

                    <dl className="access-order-source-meta">
                      <div>
                        <dt>Subscription</dt>
                        <dd>{item.currentSubscriptionId ? <code title={item.currentSubscriptionId}>{item.currentSubscriptionId}</code> : <span>No active Subscription</span>}</dd>
                      </div>
                      <div>
                        <dt>AccessPoint</dt>
                        <dd>{item.accessPoint ? <><strong>{item.accessPoint.name}</strong><AccessPointDescription description={item.accessPoint.description} /><code title={item.accessPoint.id}>{item.accessPoint.id}</code></> : <span>No current entry AccessPoint</span>}</dd>
                      </div>
                    </dl>
                  </div>

                  <div className="access-order-move-actions" role="group" aria-label={`Move ${item.planName}`}>
                    {mode === "relative" ? <Button variant="outline" size="icon" aria-label={`Move ${item.planName} to first`} title="Move to first" disabled={isPending} onClick={() => moveRelative(item.id, "before", null)}>
                      <span aria-hidden="true">⇈</span>
                    </Button> : null}
                    <Button variant="outline" size="icon" aria-label={`Move ${item.planName} up`} title="Move up" disabled={isPending || (index === 0 && !previousOrderId)} onClick={() => moveByOffset(item.id, -1)}>
                      <span aria-hidden="true">↑</span>
                    </Button>
                    <Button variant="outline" size="icon" aria-label={`Move ${item.planName} down`} title="Move down" disabled={isPending || (index === activeGroup.length - 1 && !nextOrderId)} onClick={() => moveByOffset(item.id, 1)}>
                      <span aria-hidden="true">↓</span>
                    </Button>
                    {mode === "relative" ? <Button variant="outline" size="icon" aria-label={`Move ${item.planName} to last`} title="Move to last" disabled={isPending} onClick={() => moveRelative(item.id, "after", null)}>
                      <span aria-hidden="true">⇊</span>
                    </Button> : null}
                  </div>
                </li>
              );
            })}
          </ol>
        </CardContent>
      </Card>
    </section>
  );
}

function accessOrderSnapshot(items: AccessOrderItem[]) {
  return Array.from(new Set(items.map((item) => item.exposedModel))).reduce<Record<string, string[]>>((snapshot, model) => {
    snapshot[model] = items.filter((item) => item.exposedModel === model).map((item) => item.id);
    return snapshot;
  }, {});
}
