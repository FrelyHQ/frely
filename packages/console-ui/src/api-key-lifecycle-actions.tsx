"use client";

import { Button } from "@frely/ui/components/button";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { PortalMenu } from "./portal-menu.js";
import { consoleErrorMessage } from "./api-error.js";
import { resolveConsoleMessage, type ConsoleMessageResolver } from "./messages.js";
import type { ApiKeyAction, ApiKeyActionPort, RunApiKeyActionInput } from "./api-key-action-model.js";
import type { ConsoleApiKey } from "./index.js";

export function ApiKeyLifecycleActions({
  apiKey,
  actionPort,
  messageResolver,
}: {
  apiKey: ConsoleApiKey;
  actionPort: ApiKeyActionPort;
  messageResolver?: ConsoleMessageResolver;
}) {
  const [copyFeedback, setCopyFeedback] = useState("");
  const mutation = useMutation<void, Error, RunApiKeyActionInput>({
    mutationFn: (input) => actionPort.runApiKeyAction(input),
    retry: false,
    onMutate: () => setCopyFeedback(""),
    onSuccess: (_result, input) => {
      if (input.action === "copy") {
        setCopyFeedback("API key copied");
        return;
      }
      return actionPort.onDeleted();
    },
  });
  const pendingAction = mutation.isPending ? mutation.variables.action : null;
  const actions = apiKeyActions(apiKey.status);

  if (actions.length === 0) return null;

  return (
    <div className="api-key-action-menu">
      <PortalMenu
        triggerClassName="action-menu-trigger"
        contentClassName="action-menu-content"
        triggerContent="..."
        ariaLabel="API key actions"
        menuAriaLabel="API key actions menu"
        tooltip="API key actions"
      >
        {actions.map((action) => (
          <Button
            className="action-menu-item"
            key={action}
            type="button"
            size="sm"
            variant={action === "delete" ? "destructive" : "ghost"}
            disabled={Boolean(pendingAction)}
            onClick={() => {
              mutation.mutate({ apiKeyId: apiKey.id, action });
            }}
            role="menuitem"
          >
            {pendingAction === action ? pendingLabel(action) : actionLabel(action)}
          </Button>
        ))}
      </PortalMenu>
      <span className="sr-only" role="status" aria-live="polite">{copyFeedback}</span>
      {mutation.error ? <span className="inline-error" role="alert" data-clarity-mask="true">{consoleErrorMessage(mutation.error, resolveConsoleMessage(messageResolver, "api_key.update_failed", "Failed to update API key"))}</span> : null}
    </div>
  );
}

function apiKeyActions(status: ConsoleApiKey["status"]): ApiKeyAction[] {
  if (status === "Active") return ["copy", "delete"];
  if (status === "Disabled") return ["delete"];
  return [];
}

function actionLabel(action: ApiKeyAction) {
  return action === "copy" ? "Copy" : "Delete";
}

function pendingLabel(action: ApiKeyAction) {
  return action === "copy" ? "Copying..." : "Deleting...";
}
