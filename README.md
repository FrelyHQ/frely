# Frely

> [!IMPORTANT]
> This repository is a project snapshot prepared specifically for Frely Network hackathon judging and technical review. It is not the canonical private repository or a production deployment package.

The snapshot provides a sanitized view of Frely's architecture, domain boundaries and core implementation for reviewers.

## What this snapshot shows

- Authenticated model access through the Gateway.
- Provider and AccessPoint separation.
- Team, identity and API-key boundaries.
- Plan, budget, usage and billing concepts.
- Audit and observability boundaries.
- User and Owner console structure.
- Prisma schema and migration lineage.
- The development boundary for routing a billed `vision-basic` AccessPoint to
  the public Swarm virtual-model snapshot.

## What this snapshot does not provide

- Full Local Docker end-to-end reproduction.
- Production deployment, host, traffic-control or credential operations.
- Private incident history, release history or operational runbooks.
- A guarantee that every included service is ready for production use.

Start with the [reviewer guide](docs/reviewer-guide.md), then read the
[architecture](docs/architecture.md), [Swarm Vision development integration](docs/swarm-vision-integration.md),
and [Frely Network integration notes](docs/frely-network-integration.md).

The source snapshot version is 0.64.1. The source relationship is recorded in [SNAPSHOT_PROVENANCE.json](SNAPSHOT_PROVENANCE.json).

## License

First-party source is provided under the Apache License 2.0. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
