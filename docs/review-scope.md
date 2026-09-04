# Review scope

This is a source-review snapshot, not a complete distribution.

## Included

- First-party applications and packages.
- Prisma schema and committed migrations.
- CPA source adaptation and its upstream license.
- Representative tests for core boundaries.
- Main Docker and Compose topology for architectural context.

## Excluded

- Local E2E orchestration.
- Production release and deployment workflows.
- Host, topology, traffic-control and credential operations.
- Private data, captures, backups and incident records.
- Internal agent and project-governance configuration.

The absence of E2E files is intentional. The goal is to help judges understand the implementation, not to claim complete production or local-runtime reproducibility.

Some internal symbols, protocol headers, migration text, environment variables and database identifiers retain legacy `Friday`, `FRIDAY_RELAY_*` or `friday_relay` naming for compatibility. These identifiers do not change the public Frely product name.
