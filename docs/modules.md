# Modules

| Area | Paths | Review purpose |
| --- | --- | --- |
| Public and owner surfaces | `apps/web`, `apps/admin` | Inspect user and owner workflows. |
| Gateway | `apps/gateway`, `packages/gateway` | Inspect API-key admission and request coordination. |
| Model access | `packages/model-access` | Inspect Provider and AccessPoint resolution. |
| Provider contract | `packages/provider-runtime`, `packages/providers` | Inspect CPA invocation boundaries and evidence handling. |
| Identity and tenancy | `packages/auth`, `packages/identity`, `packages/tenancy`, `packages/tenancy-context` | Inspect principals, Teams and permissions. |
| Commercial model | `packages/entitlement`, `packages/billing`, `packages/pricing` | Inspect Plans, budgets, prices and usage. |
| Persistence | `packages/postgres`, `packages/application` | Inspect schema, migrations and application operations. |
| Evidence | `packages/audit`, `packages/observability`, `packages/capture` | Inspect audit, metrics and optional capture boundaries. |
