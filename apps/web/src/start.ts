import { isNotFound, isRedirect } from "@tanstack/react-router";
import { createMiddleware, createStart } from "@tanstack/react-start";

const INTERNAL_SERVER_FUNCTION_ERROR = Object.freeze({ code: "internal_server_error" as const });

const errorRedaction = createMiddleware().server(async ({ next }) => {
  try {
    return await next();
  } catch (error) {
    if (isRedirect(error) || isNotFound(error)) throw error;
    process.stdout.write(`${JSON.stringify({ event: "web.request.failed", code: "internal_server_error" })}\n`);
    throw new Error("internal_server_error");
  }
});

const serverFunctionErrorBoundary = createMiddleware({ type: "function" }).server(async ({ next }) => {
  try {
    return await next();
  } catch (error) {
    if (error instanceof Response || isRedirect(error) || isNotFound(error)) throw error;
    process.stdout.write(`${JSON.stringify({ event: "web.server_function.failed", code: "internal_server_error" })}\n`);
    throw INTERNAL_SERVER_FUNCTION_ERROR;
  }
});

export const startInstance = createStart(() => ({
  requestMiddleware: [errorRedaction],
  functionMiddleware: [serverFunctionErrorBoundary],
}));
