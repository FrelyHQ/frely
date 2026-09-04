"use client";

import { useRouter } from "@admin/navigation";
import * as React from "react";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@frely/ui/components/button";
import { updateAuthorityProductLifecycle } from "../api/authority-product-api";

export function AuthorityProductLifecycleActions({ id, lifecycle }: { id: string; lifecycle: string }) {
  const router = useRouter();
  const mutation = useMutation({ mutationFn: updateAuthorityProductLifecycle, retry: false, onSuccess: () => router.refresh() });
  if (lifecycle === "closed") return null;

  return <div className="row-actions">
    <Button type="button" variant="secondary" disabled={mutation.isPending} onClick={() => mutation.mutate({ id, lifecycle: lifecycle === "draft" ? "listed" : "closed" })}>{mutation.isPending ? "Saving..." : lifecycle === "draft" ? "List" : "Close"}</Button>
    {mutation.error ? <span className="field-error">{mutation.error instanceof Error ? mutation.error.message : "Authority Product update failed"}</span> : null}
  </div>;
}
