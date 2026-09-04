import { queryOptions } from "@tanstack/react-query";
import { fetchAccessResolutionInputs } from "../api/access-resolution-api";
import { accessResolutionQueryKeys } from "./access-resolution-query-keys";

export const accessResolutionInputsQueryOptions = queryOptions({
  queryKey: accessResolutionQueryKeys.inputs(),
  queryFn: ({ signal }) => fetchAccessResolutionInputs(signal),
  staleTime: 30_000,
  retry: false
});
