import { defineConfig } from "prisma/config";

const offlineGenerateUrl = "postgresql://invalid:invalid@127.0.0.1:1/friday_relay_prisma_offline";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  // Validation and client generation do not connect. The unreachable fallback
  // keeps those deterministic while every database command still fails closed
  // unless the project PostgreSQL connection is supplied explicitly.
  datasource: {
    url: process.env.FRIDAY_RELAY_PG_CONNECTION_STRING ?? offlineGenerateUrl,
  },
});
