# Budgets feature

Admin Budget Policies and Governance Budgets are owned by this feature.

- `app/owner/plans-and-budgets/*/page.tsx` owns authentication, repository reads, sensitive-data boundaries, and RSC assembly.
- RSC props are the sole owner of policy and assignment lists. This feature does not duplicate those lists into Query cache or component state.
- `api/` owns typed calls to existing Admin Route Handlers. Mutations use TanStack Query with `retry: false`, then refresh the RSC once after success.
- `form/` owns TanStack Form values, deterministic transforms, and lightweight client validators. Server validation remains authoritative.
- `table/` owns TanStack Table columns with stable policy/assignment IDs; rendering reuses the console UI table wrapper.
- Budget semantics, permissions, append-only facts, API paths, database schema, and repository behavior are unchanged.
