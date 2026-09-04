"use client";

import { ApiKeyActionDialog } from "@frely/console-ui/client";
import type { ConsoleUser } from "@frely/console-ui";
import { useRouter } from "@admin/navigation";
import { createAdminApiKey } from "../api/api-key-api";

export function AdminApiKeyCreateAction({
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
      createApiKey: createAdminApiKey,
      onCreated: (result) => {
        if (result.id) router.push(`${detailHrefBase}${encodeURIComponent(result.id)}`);
        else router.refresh();
      },
    }}
  />;
}
