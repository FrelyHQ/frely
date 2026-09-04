import type { AccessOrderItem, SaveAccessOrderInput } from "../types";

export type AccessOrderPlacement = "before" | "after";

export function moveAccessOrderItem(items: AccessOrderItem[], model: string, draggedId: string, targetId: string, placement: AccessOrderPlacement = "before") {
  if (draggedId === targetId) return items;
  const group = items.filter((item) => item.exposedModel === model);
  const dragged = group.find((item) => item.id === draggedId);
  if (!dragged) return items;
  const nextGroup = group.filter((item) => item.id !== draggedId);
  const targetIndex = nextGroup.findIndex((item) => item.id === targetId);
  const insertIndex = targetIndex < 0 ? nextGroup.length : targetIndex + (placement === "after" ? 1 : 0);
  nextGroup.splice(insertIndex, 0, dragged);
  let cursor = 0;
  return items.map((item) => item.exposedModel === model ? nextGroup[cursor++]! : item);
}

export function moveAccessOrderItemByOffset(items: AccessOrderItem[], model: string, itemId: string, offset: -1 | 1) {
  const group = items.filter((item) => item.exposedModel === model);
  const currentIndex = group.findIndex((item) => item.id === itemId);
  const targetIndex = currentIndex + offset;
  if (currentIndex < 0 || targetIndex < 0 || targetIndex >= group.length) return items;
  const nextGroup = [...group];
  [nextGroup[currentIndex], nextGroup[targetIndex]] = [nextGroup[targetIndex]!, nextGroup[currentIndex]!];
  let cursor = 0;
  return items.map((item) => item.exposedModel === model ? nextGroup[cursor++]! : item);
}

export function hasAccessOrderChanged(items: AccessOrderItem[], model: string, savedOrder: string[]) {
  const currentOrder = items.filter((item) => item.exposedModel === model).map((item) => item.id);
  return currentOrder.length !== savedOrder.length || currentOrder.some((id, index) => id !== savedOrder[index]);
}

export function toSaveAccessOrderInput(items: AccessOrderItem[], model: string): SaveAccessOrderInput { return { model, orderedPlanScopeIds: items.filter((item) => item.exposedModel === model).map((item) => item.id) }; }
