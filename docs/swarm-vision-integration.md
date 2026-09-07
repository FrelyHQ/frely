# Swarm Vision development integration

This review snapshot already contains the generic Provider, AccessPoint,
pricing and billing path required to expose a Swarm virtual model. The
integration is configuration, not a second Vision runtime inside Frely.

## Development request path

```text
Caller
  → Frely `POST /v1/responses`
      → API-key authentication
      → AccessPoint and entitlement resolution
      → price and billing admission
      → `openai-compatible` Provider dispatch
  → Swarm `POST /v1/responses`
      → `vision-basic` virtual-model execution
  → configured model API (`gpt-5.6-luna` by default)
```

Frely owns the public model entry, routing and billing. Swarm owns the
virtual-model execution and the backing-model credential. Frely must receive
only a Swarm service token; it must never receive `MODEL_API_KEY`.

## Reference configuration

For the hackathon development demo:

1. Start the public Swarm snapshot and expose its `/v1` base to Frely.
2. Create an `openai-compatible` Provider in Frely.
3. Set the Provider base URL to the Swarm `/v1` base.
4. Store the Swarm service token as that Provider's CPA-managed credential.
5. Enable the Provider model `vision-basic`.
6. Create an AccessPoint whose exposed model is `vision-basic` and whose
   target is the Swarm Provider model.
7. Configure an enabled AccessPoint price and include the AccessPoint in the
   demo Plan before enabling it.
8. Call Frely with the caller's Frely API key and an OpenAI Responses request
   containing `input_image`.

The caller key authenticates access to Frely. The Swarm service token
authenticates Frely's Provider dispatch. The backing-model key is read only by
Swarm. These are three different credentials and cannot be substituted for
one another.

The Swarm snapshot also accepts direct local calls for runtime testing. A
direct call bypasses Frely admission and billing, so it is not evidence of a
paid-model flow.

## Snapshot limit

This repository is a source-review snapshot. It does not include the private
deployment topology, credentials, or a complete seeded local database. The
configuration above documents the supported boundary and the intended demo
wiring; it does not turn this snapshot into the canonical commercial runtime.

The minimum Vision milestone covers Responses-compatible execution. MCP
remains a Swarm-owned surface, but no MCP pass-through is claimed by this
snapshot until that interface is implemented and verified separately.
