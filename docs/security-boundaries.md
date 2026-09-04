# Security boundaries

The source demonstrates these intended boundaries:

- Public Web does not expose Owner APIs.
- API keys authenticate Gateway calls and cannot access Admin APIs.
- Provider credentials and upstream URLs remain behind owner and runtime boundaries.
- Provider URLs are subject to SSRF checks before egress.
- Prompt bodies, Authorization headers, API keys and Provider secrets are excluded from ordinary logs and public responses.
- CPA remains the sole Provider Runtime.
- Billing and audit facts use explicit owning boundaries rather than generic persistence dispatch.

This document describes source boundaries. It does not certify a deployment, host configuration or production security posture.
