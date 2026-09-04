import type {
  GatewayCommands as ApplicationGatewayCommands,
  GatewayQueries as ApplicationGatewayQueries,
} from "@frely/application/runtime";

/** Read-only capabilities available to the Gateway request path. */
export interface GatewayQueries extends ApplicationGatewayQueries {}

/** Write-only capabilities available to the Gateway request path. */
export interface GatewayCommands extends ApplicationGatewayCommands {
  settleProviderUsage: ApplicationGatewayCommands["settleProviderUsage"];
}

type AssertNever<Value extends never> = Value;
type _GatewayCapabilitiesDoNotOverlap = AssertNever<Extract<keyof GatewayQueries, keyof GatewayCommands>>;
type _GatewayCapabilitiesDoNotExposeTransactions = AssertNever<Extract<
  keyof GatewayQueries | keyof GatewayCommands,
  "withTransaction" | "withRetriedTransaction" | "transaction" | "contextTransactions" | "prisma" | "repository"
>>;
