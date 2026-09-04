# Admin Pricing feature

## Data ownership

- The route remains an RSC boundary: it authenticates Admin access and reads the initial Provider, ProviderModel, AccessPoint, price-history, and owner-profit view models directly from the repository.
- RSC props remain the sole authority for Provider costs and AccessPoint prices. The client keeps only draft, filter, dialog, notice, and selection state; mutation responses are used for feedback only and one `router.refresh()` reconciles the route.
- The OpenAI public reference candidate is the only Query-owned read. Its key contains no credential or request body, it is loaded explicitly, and it never mutates a draft automatically.
- All writes are typed Query mutations with `retry: false`. There are no optimistic price or status updates.

## Price history and security boundary

- Creating a changed Provider cost or AccessPoint sale price always posts a new immutable price record. The UI has no edit/delete operation for price content.
- Disabling a price uses only the existing controlled status transition. It does not rewrite tiers, amounts, ownership, or historical billing snapshots.
- Reference prices and direct target costs are suggestions copied into independent drafts. A Provider-model target uses its enabled Provider cost; an AccessPoint target uses that target AccessPoint's enabled sale price. AccessPoint prices remain decoupled from later target cost changes.
- TanStack Form validators improve draft feedback only. Route handlers and repositories remain authoritative for Admin authorization, numeric/tier validation, enabled-history constraints, and append-only enforcement.
- No Provider credential, Authorization value, billing fact, ledger fact, prompt, request body, or private capture enters Query keys/cache or the pricing DTOs.
