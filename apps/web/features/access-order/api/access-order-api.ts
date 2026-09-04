import { readConsoleApiResponse } from "@frely/console-ui/api-error";
import type { MoveAccessOrderInput, SaveAccessOrderInput } from "../types";

export async function saveAccessOrder({ model, orderedPlanScopeIds }: SaveAccessOrderInput) {
  const response = await fetch(`/api/user/access-order/${encodeURIComponent(model)}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ orderedPlanScopeIds }) });
  await readConsoleApiResponse<unknown>(response, "Failed to save access order");
  return { model };
}

export async function moveAccessOrder({ model, orderId, placement, anchorId }: MoveAccessOrderInput) {
  const response = await fetch(`/api/user/access-order/${encodeURIComponent(model)}/${encodeURIComponent(orderId)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ placement, anchorId })
  });
  await readConsoleApiResponse<unknown>(response, "Failed to move access order source");
  return { model, orderId };
}
