# Reviewer guide

Read the following paths in order.

1. `README.md` for scope and limitations.
2. `docs/architecture.md` for the request path and service boundaries.
3. `packages/postgres/prisma/schema.prisma` for persistent concepts.
4. `packages/model-access/src` for Provider, AccessPoint and visibility rules.
5. `apps/gateway/src` and `packages/gateway/src` for request admission and streaming.
6. `packages/providers/src` for CPA invocation and evidence handling.
7. `packages/billing/src`, `packages/entitlement/src` and `packages/pricing/src` for commercial behavior.
8. `apps/web` and `apps/admin` for user and owner surfaces.

Representative root tests are listed in `scripts/run-review-tests.mjs`. Colocated tests under `apps/` and `packages/` remain with their source, but this snapshot does not promise that the entire test tree runs without additional environment setup.
