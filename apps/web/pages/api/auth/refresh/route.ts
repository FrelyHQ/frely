import { RelayError } from "@frely/core";
import { handle, services } from "../../../../lib/server";

export async function POST(request: Request) {
  return handle(request, async () => {
    await services();
    throw new RelayError("not_found", "Not found", 404);
  });
}
