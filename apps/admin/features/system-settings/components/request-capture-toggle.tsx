"use client";

import { useRouter } from "@admin/navigation";
import { Checkbox } from "@frely/ui/components/checkbox";
import { useMutation } from "@tanstack/react-query";
import { StatusBadge } from "../../../pages/owner/_components/ui";
import { updateRequestCaptureSetting } from "../api/request-capture-api";

export function RequestCaptureToggle({ initialEnabled }: { initialEnabled: boolean }) {
  const router = useRouter();
  const mutation = useMutation({
    mutationFn: updateRequestCaptureSetting,
    retry: false,
    onSuccess: () => router.refresh()
  });
  const enabled = mutation.data?.enabled ?? initialEnabled;

  return <div className="toggle-row">
    <StatusBadge tone={enabled ? "warn" : "neutral"}>{enabled ? "Enabled" : "Disabled"}</StatusBadge>
    <label>
      <Checkbox checked={enabled} disabled={mutation.isPending} onCheckedChange={(checked) => mutation.mutate(checked === true)} />
      Request Capture
    </label>
    {mutation.isPending ? <span className="muted">Saving...</span> : null}
    {mutation.isSuccess ? <span className="muted">Saved</span> : null}
    {mutation.error ? <span className="field-error">{mutation.error instanceof Error ? mutation.error.message : "Save failed"}</span> : null}
  </div>;
}
