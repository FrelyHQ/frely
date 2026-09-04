"use client";

import { useState } from "react";
import { useForm } from "@tanstack/react-form";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@frely/ui/components/button";
import { Input } from "@frely/ui/components/input";
import { useRouter } from "@admin/navigation";
import { AdminDialog, ConsoleDialogFooter, StatusBadge } from "../../../pages/owner/_components/ui";
import { FormFieldFrame, FormSubmitError } from "../../_shared/form-fields";
import { createTeam } from "../api/team-api";
import { requiredTeamName } from "../form/team-form-values";

export function CreateTeamDialog() {
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(false);
  const mutation = useMutation({ mutationFn: createTeam, retry: false });
  const form = useForm({
    defaultValues: { name: "" },
    onSubmit: async ({ value }) => {
      await mutation.mutateAsync(value.name.trim());
      setIsOpen(false);
      form.reset();
      router.refresh();
    }
  });

  return <AdminDialog
    observabilityKey="team-create"
    titleId="create-team-title"
    eyebrow="Create Team"
    title="Set up a tenant scope for users, keys, and plan assignment."
    open={isOpen}
    trigger={<Button type="button">Create Team</Button>}
    onOpen={() => { mutation.reset(); form.reset(); setIsOpen(true); }}
    onClose={() => setIsOpen(false)}
    closeDisabled={mutation.isPending}
  >
      <form onSubmit={(event) => { event.preventDefault(); event.stopPropagation(); void form.handleSubmit(); }}>
        <div className="form-grid">
          <form.Field name="name" validators={{ onBlur: ({ value }) => requiredTeamName(value), onSubmit: ({ value }) => requiredTeamName(value) }}>
            {(field) => <FormFieldFrame label="Team Name *" description="Shown in tables, permissions, and audit views." errors={field.state.meta.errors}>
              <Input value={field.state.value} placeholder="Research Platform" disabled={mutation.isPending} onBlur={field.handleBlur} onChange={(event) => field.handleChange(event.target.value)} />
            </FormFieldFrame>}
          </form.Field>
        </div>
        <div className="embedded-section"><div className="panel-heading"><div><strong>Plan Assignment</strong><p>Open or replace the team plan from the Plans page after the team is created.</p></div><StatusBadge tone="warn">Hard stop only</StatusBadge></div><div className="rule-table"><div><strong>scope_ref</strong><span>team:new</span></div><div><strong>Plan status</strong><span>Not assigned</span></div></div></div>
        <ConsoleDialogFooter feedback={mutation.error instanceof Error ? <FormSubmitError message={mutation.error.message} /> : null}><Button type="button" variant="secondary" onClick={() => setIsOpen(false)} disabled={mutation.isPending}>Cancel</Button><Button type="submit" disabled={mutation.isPending}>{mutation.isPending ? "Creating..." : "Create Team"}</Button></ConsoleDialogFooter>
      </form>
    </AdminDialog>;
}
