import { RelayError } from "@frely/core";
import { parseServiceProductDirectoryApiState } from "../../../../features/commerce/lib/service-product-url-state";
import { handle, json, services } from "../../../../lib/server";

export async function GET(request: Request) {
  return handle(request, async () => {
    const { asyncTenancy, application} = await services();
    await asyncTenancy.requireUser(request.headers);
    const state = parseServiceProductDirectoryApiState(new URL(request.url).searchParams);
    if (!state) {
      throw new RelayError("invalid_service_product_directory_query", "Service product directory accepts q (up to 100 characters) and page (1-10000)", 400);
    }
    return json(await application.billingQueries.pageEnabledServiceProducts(state));
  });
}
