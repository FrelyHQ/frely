"use client";

import {
  ApiKeyActionDialog,
  ApiKeyLifecycleActions,
} from "@frely/console-ui/client";
import type { ConsoleApiKey, ConsoleUser } from "@frely/console-ui";
import { useRouter } from "@web/navigation";
import { createWebApiKey, runWebApiKeyAction } from "../api/api-key-api";

export function WebApiKeyCreateAction({
  user,
  detailHrefBase,
}: {
  user: ConsoleUser;
  detailHrefBase: string;
}) {
  const router = useRouter();
  return <ApiKeyActionDialog
    user={user}
    actionPort={{
      createApiKey: createWebApiKey,
      onCreated: (result) => {
        if (result.id) router.push(`${detailHrefBase}${encodeURIComponent(result.id)}`);
        else router.refresh();
      },
    }}
  />;
}

export function WebApiKeyLifecycleAction({ apiKey }: { apiKey: ConsoleApiKey }) {
  const router = useRouter();
  return <ApiKeyLifecycleActions
    apiKey={apiKey}
    actionPort={{
      runApiKeyAction: runWebApiKeyAction,
      onDeleted: () => router.refresh(),
    }}
  />;
}
