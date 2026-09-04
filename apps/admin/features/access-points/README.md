# AccessPoints

The App Router page owns authentication, permission checks, repository reads,
sanitization, and initial assembly. This feature owns AccessPoint forms, dynamic
provider model-candidate reads, mutations, local filtering, and table state.

TanStack Query never caches credentials, provider configuration secrets, or
request bodies; model-candidate keys contain only the non-secret provider id.
Browser validation is interaction feedback only. Route handlers remain
authoritative for scope authorization, Provider/AccessPoint layered exposure,
cycle prevention, model catalog validation, SSRF protection, and audit rules.
