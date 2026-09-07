# Domain model

The core model separates upstream connectivity, visible access and commercial entitlement.

| Concept | Meaning | Main source |
| --- | --- | --- |
| Provider | Upstream connection and model catalog; the Vision demo points an `openai-compatible` Provider at Swarm | `packages/providers` |
| AccessPoint | User-visible model access capability | `packages/model-access` |
| Access Resolution | Deterministic decision for a principal or API key | `packages/model-access`, `packages/gateway` |
| Team | Tenant and membership boundary | `packages/tenancy` |
| Plan / Subscription | Usage entitlement and lifecycle | `packages/entitlement` |
| Budget / Usage | Admission limits and provider usage facts | `packages/billing`, `packages/request-execution` |
| Audit | Allowlisted activity evidence | `packages/audit` |

A Provider is not a public model entry point. An AccessPoint exposes a model only after visibility and entitlement checks. Provider credentials and upstream URLs are not part of lower-scope projections.

For `vision-basic`, the Swarm service token is a Provider transport
credential. The backing `MODEL_API_KEY` belongs to Swarm and is not a Frely
Provider credential. The caller uses a separate Frely API key to reach the
AccessPoint.
