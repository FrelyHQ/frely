# Credits feature

## Ownership

- `app/owner/credits/page.tsx` owns authentication, repository reads, private-data redaction and RSC assembly.
- RSC props are the sole owner of products, channels, listings, topups and credit directory rows. Credits does not create duplicate GET queries or component list state.
- `components/` owns TanStack Form, TanStack Table and interactive controls.
- `api/` owns typed calls to the existing Admin Route Handler. Every write, review and upload is a TanStack Query mutation with `retry: false`; success performs one RSC refresh and never applies optimistic accounting updates.
- `form/` owns browser-local values, lightweight validators and pure API DTO conversion. Authorization, payment rules, append-only facts and all authoritative validation remain server-side.

Payment instruction uploads stay in the private Admin API and are never placed in Query cache, logs, audit metadata or public responses. Credit and topup facts are not edited in place by this feature.

User 详情页的 ledger adjustment 表单同样归属本 feature。浏览器只转换显示金额为整数 units 并做轻量必填检查；余额、透支、event type、actor、append-only 和审计规则仍由现有 Admin API 权威校验，mutation 不重试且不做乐观更新。
