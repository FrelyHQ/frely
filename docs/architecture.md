# Architecture

Frely is the control plane that exposes authenticated model access and coordinates Provider execution. The public Web and restricted Admin surfaces use application boundaries instead of sharing persistence access.

## Request path

1. A client sends an API-key request to the Gateway.
2. The Gateway resolves the caller's visible AccessPoint and entitlement path.
3. Frely-owned policy checks run before provider side effects.
4. The Gateway dispatches the admitted request through the CPA contract.
5. CPA performs Provider-specific protocol work and returns execution evidence.
   For the hackathon Vision demo, the selected `openai-compatible` Provider
   endpoint is the public Swarm snapshot's Responses API.
6. Frely records allowlisted request, usage, billing, audit and timing facts.

CPA is the only Provider Runtime. Relay code coordinates the call but does not implement a second Provider tokenizer, Provider protocol runtime or Provider-specific evidence producer.

In this snapshot's demo terminology, Swarm is the upstream virtual-model
runtime. It runs `vision-basic` and keeps the backing-model key; Frely remains
the authenticated, priced model entry. See [Swarm Vision development
integration](swarm-vision-integration.md).

## Service boundaries

- `apps/web`: public Landing, authentication and User Console.
- `apps/admin`: restricted Owner Console and Admin API.
- `apps/gateway`: public `/v1/*` request boundary.
- `apps/cliproxy-control` and `apps/cliproxy-egress`: narrow CPA control and egress services.
- `packages/postgres`: Prisma schema, migrations and database primitives.
- `packages/model-access`: Provider, AccessPoint and resolution rules.
- `packages/billing`, `packages/entitlement` and `packages/pricing`: commercial and usage policies.

See [modules](modules.md) for the source map.
