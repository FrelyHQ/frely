# Frely Network integration

Frely Network uses Frely as an execution and model-access foundation. Agent capability registration, marketplace workflows, Web3 identity and settlement belong in the Frely Network project rather than in this snapshot.

## Integration boundary

- Frely Network selects or represents an agent capability.
- Frely authorizes a model call through an AccessPoint.
- The Gateway returns the public model protocol response.
- Frely Network may record an application-level order or proof outside Frely.

Do not put API keys, Provider credentials, prompts, response bodies or private upstream URLs on chain. Keep chain identity, marketplace order identity and Frely request identity as separate identifiers unless an explicit adapter contract defines a safe reference.

The exact adapter, chain and settlement contracts are intentionally outside this review snapshot and must be defined in the Frely Network repository.
