import { queryOptions } from "@tanstack/react-query";
import { fetchProviderDialogData } from "../api/provider-api";
import { providerQueryKeys } from "./provider-query-keys";

export function providerDialogQueryOptions(enabled: boolean) {
  return queryOptions({
    queryKey: providerQueryKeys.dialogData(),
    queryFn: ({ signal }) => fetchProviderDialogData(signal),
    enabled,
    staleTime: 60_000
  });
}
