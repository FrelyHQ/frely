import { queryOptions } from "@tanstack/react-query";
import { fetchApiTestInputs } from "../api/api-test-api";
import { apiTestQueryKeys } from "./api-test-query-keys";

export const apiTestInputsQueryOptions = queryOptions({ queryKey: apiTestQueryKeys.inputs(), queryFn: ({ signal }) => fetchApiTestInputs(signal), staleTime: 30_000, retry: false });
