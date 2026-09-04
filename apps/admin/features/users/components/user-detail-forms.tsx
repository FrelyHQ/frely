"use client";

import { useForm } from "@tanstack/react-form";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@frely/ui/components/button";
import { Card } from "@frely/ui/components/card";
import { Textarea } from "@frely/ui/components/textarea";
import { useRouter } from "@admin/navigation";
import { FormFieldFrame } from "../../_shared/form-fields";
import { updateUserAdminNote } from "../api/user-api";

export function AdminRoleBindings({ roleDetails, isPlatformOwner }: { roleDetails: string; isPlatformOwner: boolean }) {
  return (
    <Card className="panel admin-note-panel">
      <div className="panel-heading">
        <div>
          <h2>Role Bindings</h2>
          <p className="muted">Platform and team roles currently attached to this user.</p>
        </div>
      </div>
      <div className="detail-list">
        <div>
          <span>Current Roles</span>
          <strong>{roleDetails}</strong>
        </div>
      </div>
      <div className="form-footer">
        <span className="muted">{isPlatformOwner ? "owner @ platform" : "No Platform Owner role"}</span>
        <span className="muted">Platform admin is bootstrap-managed.</span>
      </div>
    </Card>
  );
}

export function UserAdminNoteForm({ userId, initialAdminNote }: { userId: string; initialAdminNote: string | null }) {
  const router = useRouter();
  const mutation = useMutation({
    mutationFn: updateUserAdminNote,
    retry: false,
    onSuccess: () => router.refresh(),
  });
  const form = useForm({
    defaultValues: { adminNote: initialAdminNote ?? "" },
    onSubmit: async ({ value }) => mutation.mutateAsync({ userId, adminNote: value.adminNote, failureLabel: "admin note" }),
  });

  return (
    <Card className="panel admin-note-panel">
      <div className="panel-heading">
        <div>
          <h2>Admin Note</h2>
          <p className="muted">Internal account note visible only in the admin console.</p>
        </div>
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void form.handleSubmit();
        }}
      >
        <form.Field
          name="adminNote"
          validators={{ onSubmit: ({ value }) => value.length <= 2000 ? undefined : "Admin note must be at most 2000 characters." }}
        >
          {(field) => (
            <>
              <FormFieldFrame label="Note" errors={field.state.meta.errors}>
                <Textarea
                  rows={5}
                  maxLength={2000}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.value)}
                  disabled={mutation.isPending}
                />
              </FormFieldFrame>
              <div className="form-footer">
                <span className="muted">{field.state.value.trim().length}/2000</span>
                <Button type="submit" disabled={mutation.isPending}>
                  {mutation.isPending ? "Saving..." : "Save Note"}
                </Button>
              </div>
            </>
          )}
        </form.Field>
        {mutation.error ? <div className="notice-box notice-bad" role="alert">{mutation.error.message}</div> : null}
        {mutation.isSuccess ? <div className="notice-box notice-good" role="status">Saved</div> : null}
      </form>
    </Card>
  );
}
