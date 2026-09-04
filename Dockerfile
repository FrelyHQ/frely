# syntax=docker/dockerfile:1.19

FROM node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS node-build

FROM golang:1.26-bookworm@sha256:e8c859f5632dcfde7b32d2012b4351728f6437930887c2f6a91ea242459e5514 AS cli-proxy-api-builder
WORKDIR /src
COPY ops/cliproxy/upstream/v7.2.145/CLIProxyAPI-v7.2.145.tar.gz /tmp/CLIProxyAPI-v7.2.145.tar.gz
COPY ops/cliproxy/upstream/v7.2.145/SHA256SUMS /tmp/SHA256SUMS
RUN cd /tmp && sha256sum --check SHA256SUMS && tar -xzf CLIProxyAPI-v7.2.145.tar.gz -C /src --strip-components=1
COPY ops/cliproxy/upstream/v7.2.145/patches/friday-evidence.patch /tmp/friday-evidence.patch
RUN git apply --check --unidiff-zero /tmp/friday-evidence.patch && git apply --unidiff-zero /tmp/friday-evidence.patch
COPY ops/cliproxy/upstream/v7.2.145/overlay/ /src/
RUN gofmt -w internal/api/middleware/cpa_basic_evidence.go internal/api/middleware/cpa_basic_evidence_test.go && \
    test -z "$(gofmt -l internal/api/middleware/cpa_basic_evidence.go internal/api/middleware/cpa_basic_evidence_test.go)" && \
    go test -run '^TestCPABasicEvidence' ./internal/api/middleware && \
    go test ./internal/api/handlers/management
RUN go mod download
RUN CGO_ENABLED=1 GOOS=linux go build -buildvcs=false \
    -ldflags="-s -w -X 'main.Version=v7.2.145' -X 'main.Commit=d9cea89' -X 'main.BuildDate=2026-08-28T09:30:55Z'" \
    -o /out/CLIProxyAPI ./cmd/server/

FROM eceasy/cli-proxy-api:v7.2.145@sha256:b90fcd2282e8b8da9ee05d531fb92e5215ac8340722f8842adb47bb7120226fd AS cli-proxy-api-runtime
COPY --from=cli-proxy-api-builder /out/CLIProxyAPI /CLIProxyAPI/CLIProxyAPI

FROM oven/bun:1.4.0-alpine AS deps
WORKDIR /app
ARG BUN_VERSION=1.4.0
ARG FRIDAY_RELAY_RELEASE=local
COPY --from=node-build /usr/local/bin/node /usr/local/bin/node
RUN test "$BUN_VERSION" = "1.4.0" && apk add --no-cache g++ git make python3 zstd

COPY bun.lock bunfig.toml ./
COPY package.json tsconfig.base.json tsconfig.json ./
COPY patches/@tanstack%2Fstart-server-core@1.169.31.patch ./patches/@tanstack%2Fstart-server-core@1.169.31.patch
RUN mkdir -p apps/admin apps/cliproxy-control apps/cliproxy-egress apps/gateway apps/hub apps/web \
  packages/application packages/application-operations packages/audit packages/auth packages/authority packages/billing packages/capture packages/config packages/console-ui packages/core packages/db-ops packages/entitlement \
  packages/gateway packages/identity packages/model-access packages/observability packages/postgres \
  packages/pricing packages/provider-runtime packages/providers packages/request-execution packages/team-console-ui \
  packages/tenancy packages/tenancy-context packages/testkit packages/ui packages/ui-application
COPY apps/admin/package.json ./apps/admin/package.json
COPY apps/cliproxy-control/package.json ./apps/cliproxy-control/package.json
COPY apps/cliproxy-egress/package.json ./apps/cliproxy-egress/package.json
COPY apps/gateway/package.json ./apps/gateway/package.json
COPY apps/hub/package.json ./apps/hub/package.json
COPY apps/pi-tunnel/package.json ./apps/pi-tunnel/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY packages/application/package.json ./packages/application/package.json
COPY packages/application-operations/package.json ./packages/application-operations/package.json
COPY packages/audit/package.json ./packages/audit/package.json
COPY packages/auth/package.json ./packages/auth/package.json
COPY packages/authority/package.json ./packages/authority/package.json
COPY packages/billing/package.json ./packages/billing/package.json
COPY packages/capture/package.json ./packages/capture/package.json
COPY packages/config/package.json ./packages/config/package.json
COPY packages/console-ui/package.json ./packages/console-ui/package.json
COPY packages/core/package.json ./packages/core/package.json
COPY packages/db-ops/package.json ./packages/db-ops/package.json
COPY packages/entitlement/package.json ./packages/entitlement/package.json
COPY packages/gateway/package.json ./packages/gateway/package.json
COPY packages/identity/package.json ./packages/identity/package.json
COPY packages/model-access/package.json ./packages/model-access/package.json
COPY packages/observability/package.json ./packages/observability/package.json
COPY packages/pi-tunnel/package.json ./packages/pi-tunnel/package.json
COPY packages/postgres/package.json ./packages/postgres/package.json
COPY packages/pricing/package.json ./packages/pricing/package.json
COPY packages/provider-runtime/package.json ./packages/provider-runtime/package.json
COPY packages/providers/package.json ./packages/providers/package.json
COPY packages/request-execution/package.json ./packages/request-execution/package.json
COPY packages/team-console-ui/package.json ./packages/team-console-ui/package.json
COPY packages/tenancy/package.json ./packages/tenancy/package.json
COPY packages/tenancy-context/package.json ./packages/tenancy-context/package.json
COPY packages/testkit/package.json ./packages/testkit/package.json
COPY packages/ui/package.json ./packages/ui/package.json
COPY packages/ui-application/package.json ./packages/ui-application/package.json
RUN bun install --offline --frozen-lockfile --no-progress --concurrent-scripts 4

FROM deps AS builder
ARG FRIDAY_RELAY_DOCKER_WORKSPACE_CONCURRENCY=auto
COPY apps ./apps
COPY packages ./packages
COPY scripts/verify-shared-ui-bundle-budget.mjs scripts/shared-ui-bundle-budgets.json ./scripts/
COPY scripts/run-workspaces.mjs scripts/workspace-output-cleanup.mjs scripts/bun-service-artifact.mjs scripts/stage-patched-dependency-sources.mjs scripts/ensure-bun-root-links.mjs ./scripts/
COPY config.example.json ./config.example.json
COPY config.production.example.json ./config.production.example.json
RUN bun scripts/ensure-bun-root-links.mjs && mkdir -p node_modules/@dsnp && \
  ln -sfn ../.bun/node_modules/@dsnp/parquetjs node_modules/@dsnp/parquetjs && \
  for package in canonicalize fast-json-patch jsonwebtoken llm-bridge thrift undici zod; do \
    ln -sfn ".bun/node_modules/$package" "node_modules/$package"; \
  done
RUN bun scripts/run-workspaces.mjs --script build --concurrency "$FRIDAY_RELAY_DOCKER_WORKSPACE_CONCURRENCY" \
      --exclude @frely/admin \
      --exclude @frely/console-ui \
      --exclude @frely/team-console-ui \
      --exclude @frely/testkit \
      --exclude @frely/ui \
      --exclude @frely/web

FROM builder AS frontend-builder
COPY scripts/generate-ui-surface-registries.mjs scripts/verify-shared-ui-bundle-budget.mjs scripts/shared-ui-bundle-budgets.json ./scripts/
COPY scripts/frontend-build-contract-lib.mjs scripts/audit-frontend-build-contract.mjs scripts/audit-frontend-artifact-closure.mjs ./scripts/
COPY scripts/build-frontend-app.mjs scripts/build-tanstack-start-artifact.mjs scripts/tanstack-start-runtime-serve.mjs ./scripts/
COPY scripts/fixtures/next-app-paths-manifest.json ./scripts/fixtures/
COPY scripts/run-build-memory-probe.mjs ./scripts/run-build-memory-probe.mjs
COPY ops/build/frontend-build-contracts.json ./ops/build/frontend-build-contracts.json

FROM frontend-builder AS admin-builder
RUN --mount=type=cache,id=friday-relay-vite-admin,target=/app/apps/admin/.vite-cache \
    bun scripts/build-frontend-app.mjs \
      --manifest ops/build/frontend-build-contracts.json \
      --app admin \
      --workspace-root /app

FROM frontend-builder AS web-builder
RUN --mount=type=cache,id=friday-relay-vite-web,target=/app/apps/web/.vite-cache \
    bun scripts/build-frontend-app.mjs \
      --manifest ops/build/frontend-build-contracts.json \
      --app web \
      --workspace-root /app

FROM builder AS gateway-deploy
RUN bun scripts/bun-service-artifact.mjs --package @frely/gateway --output /out/gateway

FROM builder AS hub-deploy
RUN bun scripts/bun-service-artifact.mjs --package @frely/hub --output /out/hub

FROM builder AS providers-deploy
RUN bun scripts/bun-service-artifact.mjs --package @frely/providers --output /out/providers

FROM builder AS cliproxy-egress-deploy
RUN bun scripts/bun-service-artifact.mjs --package @frely/cliproxy-egress --output /out/cliproxy-egress

FROM builder AS cliproxy-control-deploy
RUN bun scripts/bun-service-artifact.mjs --package @frely/cliproxy-control --output /out/cliproxy-control

FROM builder AS db-ops-deploy
RUN bun scripts/bun-service-artifact.mjs --package @frely/db-ops --output /out/db-ops --include-prisma-cli

FROM oven/bun:1.4.0-alpine AS gateway-runtime-base
WORKDIR /app
ENV NODE_ENV=production
COPY --from=gateway-deploy /out/gateway ./
COPY --from=builder /app/config.example.json ./config.example.json
COPY --from=builder /app/config.production.example.json ./config.production.example.json
RUN find . -name package.json -type f -exec chmod 0644 {} + && \
  find packages/postgres/prisma -type d -exec chmod 0755 {} + && \
  find packages/postgres/prisma -type f -exec chmod 0644 {} + && \
  find node_modules -depth \( \
    -path '*/node_modules/better-sqlite3' -o \
    -path '*/node_modules/sqlite3' -o \
    -path '*/node_modules/@op-engineering/op-sqlite' -o \
    -path '*/node_modules/expo-sqlite' \
  \) -exec rm -rf {} + && \
  bun -e "if (typeof require('node:zlib').createZstdCompress !== 'function') throw new Error('Bun Zstd support is required')"
EXPOSE 43000
CMD ["bun", "apps/gateway/dist/server.js"]

FROM oven/bun:1.4.0-alpine AS gateway-runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=gateway-deploy /out/gateway ./
COPY --from=builder /app/config.example.json ./config.example.json
COPY --from=builder /app/config.production.example.json ./config.production.example.json
RUN find . -name package.json -type f -exec chmod 0644 {} + && \
  find packages/postgres/prisma -type d -exec chmod 0755 {} + && \
  find packages/postgres/prisma -type f -exec chmod 0644 {} + && \
  find node_modules -depth \( \
    -path '*/node_modules/better-sqlite3' -o \
    -path '*/node_modules/sqlite3' -o \
    -path '*/node_modules/@op-engineering/op-sqlite' -o \
    -path '*/node_modules/expo-sqlite' \
  \) -exec rm -rf {} + && \
  bun -e "if (typeof require('node:zlib').createZstdCompress !== 'function') throw new Error('Bun Zstd support is required')"
EXPOSE 43000
CMD ["bun", "apps/gateway/dist/server.js"]

FROM oven/bun:1.4.0-alpine AS cliproxy-egress-runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=cliproxy-egress-deploy /out/cliproxy-egress ./
RUN find . -name package.json -type f -exec chmod 0644 {} +
USER bun
EXPOSE 8318
CMD ["bun", "apps/cliproxy-egress/dist/server.js"]

FROM oven/bun:1.4.0-alpine AS cliproxy-control-runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=cliproxy-control-deploy /out/cliproxy-control ./
RUN find . -name package.json -type f -exec chmod 0644 {} + && \
  if test -d packages/postgres/prisma; then \
    find packages/postgres/prisma -type d -exec chmod 0755 {} + && \
    find packages/postgres/prisma -type f -exec chmod 0644 {} +; \
  fi && \
  mkdir -p /var/lib/cliproxy-control && chown bun:bun /var/lib/cliproxy-control && \
  find node_modules -depth \( \
    -path '*/node_modules/better-sqlite3' -o \
    -path '*/node_modules/sqlite3' -o \
    -path '*/node_modules/@op-engineering/op-sqlite' -o \
    -path '*/node_modules/expo-sqlite' \
  \) -exec rm -rf {} +
USER bun
EXPOSE 8319
CMD ["bun", "apps/cliproxy-control/dist/server.js"]

FROM oven/bun:1.4.0-alpine AS web-runtime-base
WORKDIR /app
ENV NODE_ENV=production
COPY --from=web-builder --chown=bun:bun /app/apps/web/.output/runtime ./
RUN test "$(bun --version)" = "1.4.0" && \
  find . -name package.json -type f -exec chmod 0644 {} + && \
  if find . -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.cts' -o -name '*.mts' -o -name '*.map' \) -print -quit | grep -q .; then \
    echo 'TypeScript source or source map leaked into Web runtime artifact' >&2; \
    exit 1; \
  fi; \
  if test -e apps/admin || test -e src; then \
    echo 'application source leaked into Web runtime artifact' >&2; \
    exit 1; \
  fi; \
  for package in vite typescript @vitejs/plugin-react @tanstack/router-plugin @tanstack/router-generator @tanstack/start-plugin-core next; do \
    test ! -e "node_modules/$package" || { echo "build-only package leaked into Web runtime artifact: $package" >&2; exit 1; }; \
  done; \
  bun -e "if (typeof require('node:zlib').createZstdCompress !== 'function') throw new Error('Bun Zstd support is required')"
RUN --mount=from=frontend-builder,source=/app,target=/audit-source,ro \
  bun /audit-source/scripts/audit-frontend-artifact-closure.mjs \
    --manifest /audit-source/ops/build/frontend-build-contracts.json \
    --app web \
    --artifact-root /app
USER bun
EXPOSE 43001
CMD ["bun", "serve.mjs"]

FROM web-runtime-base AS web-runtime
FROM oven/bun:1.4.0-alpine AS admin-runtime-base
WORKDIR /app
ENV NODE_ENV=production
COPY --from=admin-builder --chown=bun:bun /app/apps/admin/.output/runtime ./
RUN test "$(bun --version)" = "1.4.0" && \
  find . -name package.json -type f -exec chmod 0644 {} + && \
  if find . -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.cts' -o -name '*.mts' -o -name '*.map' \) -print -quit | grep -q .; then \
    echo 'TypeScript source or source map leaked into Admin runtime artifact' >&2; \
    exit 1; \
  fi; \
  if test -e apps/web || test -e src; then \
    echo 'application source leaked into Admin runtime artifact' >&2; \
    exit 1; \
  fi; \
  for package in vite typescript @vitejs/plugin-react @tanstack/router-plugin @tanstack/router-generator @tanstack/start-plugin-core; do \
    test ! -e "node_modules/$package" || { echo "build-only package leaked into Admin runtime artifact: $package" >&2; exit 1; }; \
  done; \
  bun -e "if (typeof require('node:zlib').createZstdCompress !== 'function') throw new Error('Bun Zstd support is required')"
RUN --mount=from=frontend-builder,source=/app,target=/audit-source,ro \
  bun /audit-source/scripts/audit-frontend-artifact-closure.mjs \
    --manifest /audit-source/ops/build/frontend-build-contracts.json \
    --app admin \
    --artifact-root /app
USER bun
EXPOSE 43002
CMD ["bun", "serve.mjs"]

FROM admin-runtime-base AS admin-runtime
FROM postgres:18.4-alpine@sha256:9a8afca54e7861fd90fab5fdf4c42477a6b1cb7d293595148e674e0a3181de15 AS db-ops-runtime-base
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /usr/local/bin/bun /usr/local/bin/bun
RUN apk add --no-cache zstd && \
  test "$(pg_dump --version)" = "pg_dump (PostgreSQL) 18.4" && \
  test "$(psql --version)" = "psql (PostgreSQL) 18.4"
COPY --from=db-ops-deploy /out/db-ops ./
RUN find . -name package.json -type f -exec chmod 0644 {} + && \
  chmod 0644 packages/postgres/prisma.config.ts && \
  find packages/postgres/prisma -type d -exec chmod 0755 {} + && \
  find packages/postgres/prisma -type f -exec chmod 0644 {} + && \
  find node_modules -depth \( \
    -path '*/node_modules/better-sqlite3' -o \
    -path '*/node_modules/sqlite3' -o \
    -path '*/node_modules/@op-engineering/op-sqlite' -o \
    -path '*/node_modules/expo-sqlite' \
  \) -exec rm -rf {} + && \
  bun --cwd packages/postgres -e "require('pg'); if (typeof require('node:zlib').createZstdCompress !== 'function') throw new Error('Bun Zstd support is required')" && \
  bun --cwd packages/db-ops --input-type=module -e "import { accessSync } from 'node:fs'; import { resolvePostgresPrismaRuntimeArtifacts as resolve } from '@frely/postgres/runtime-artifacts'; const { prismaCliEntry, prismaConfig, schema, migrationsRoot } = resolve(); for (const path of [prismaCliEntry, prismaConfig, schema, migrationsRoot]) accessSync(path);"
FROM db-ops-runtime-base AS db-ops-runtime
ENTRYPOINT ["bun", "packages/db-ops/dist/cli-postgres.js"]
