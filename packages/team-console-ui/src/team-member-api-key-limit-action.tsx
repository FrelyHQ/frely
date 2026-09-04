"use client";

import { useForm, useStore } from "@tanstack/react-form";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@frely/ui/components/button";
import { Input } from "@frely/ui/components/input";
import type { TeamUserRow } from "./index.js";
import type { TeamMemberApiKeyLimitActionPort, UpdateTeamMemberApiKeyLimitInput } from "./team-member-action-model.js";

export function TeamMemberApiKeyLimitAction({
  user,
  actionPort,
}: {
  user: TeamUserRow;
  actionPort: TeamMemberApiKeyLimitActionPort;
}) {
  const form = useForm({ defaultValues: { value: String(user.apiKeyLimit) } });
  const value = useStore(form.store, (state) => state.values.value);
  const mutation = useMutation<unknown, Error, UpdateTeamMemberApiKeyLimitInput>({
    mutationFn: (input) => actionPort.updateApiKeyLimit(input),
    retry: false,
    onSuccess: () => actionPort.onUpdated(),
  });

  return (
    <div className="limit-control">
      <Input
        aria-label={`${user.email} API key limit`}
        inputMode="numeric"
        min={0}
        max={1000}
        type="number"
        value={value}
        disabled={mutation.isPending}
        onChange={(event) => form.setFieldValue("value", event.target.value)}
      />
      <Button type="button" size="sm" variant="secondary" disabled={mutation.isPending || value === String(user.apiKeyLimit)} onClick={() => mutation.mutate({ userId: user.id, teamId: user.teamId, apiKeyLimit: Number(value) })}>
        {mutation.isPending ? "Saving..." : "Save"}
      </Button>
      {mutation.error ? <span className="inline-error" role="alert">{mutation.error instanceof Error ? mutation.error.message : "Failed to update limit"}</span> : null}
    </div>
  );

}
