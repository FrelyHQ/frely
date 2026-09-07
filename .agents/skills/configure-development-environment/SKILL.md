---
name: configure-development-environment
description: Configure or repair a Frely Relay checkout for local development. Use for onboarding, dependency setup, ignored environment and secret files, Compose inputs, missing-variable failures, or host/container workflow changes; never treat it as production configuration.
---

# Configure Relay Development Environment

Prepare the smallest local environment needed for the developer's task and leave a clear account of what is configured, what is running, and which external inputs are still missing.

Relay is Frely's authenticated model gateway and billing plane. It resolves access, forwards requests to configured providers such as Swarm, records usage, and bills the request. Virtual-model and Agent execution belongs in Swarm; do not move that runtime or its private implementation credentials into Relay while configuring this repository.

## Establish the target

1. Start at the repository root and read the applicable repository instructions and current Git status. Preserve every pre-existing change.
2. Identify the requested mode: code and tests only, host processes with local dependencies, or the selected Docker Compose stack. If the request does not say, choose the least expansive mode that supports the immediate task and state the assumption.
3. A request to configure the environment authorizes local configuration and validation, not starting long-running services, changing tracked templates, provisioning hosted resources, or configuring production. Do those only when the user also requests them.

## Derive the contract from this checkout

Inspect the active branch instead of relying on a remembered variable list:

- `package.json` and `bun.lock` define the JavaScript toolchain and available commands.
- `.env.example` defines the public local-environment surface.
- The selected `docker-compose*.yml` files define interpolation, service DNS names, ports, profiles, secrets, dependencies, and health checks for that mode.
- `packages/config`, `packages/postgres`, and the affected app's runtime-config loader define parsing, defaults, exclusivity rules, and required values.
- The README and focused app documentation explain operator intent but do not override executable validation.

Honor explicit user and repository instructions first. When checked-in authorities disagree, stop before inventing a value: identify the exact conflict and either use the executable contract with a stated assumption or request the missing decision when the choice changes behavior.

## Configure safely

1. Verify the installed Bun and Node versions against `package.json`. Use Bun for dependency work and run `bun install --frozen-lockfile` only when dependencies need installation or verification; do not rewrite the lockfile as part of setup.
2. If `.env` is absent, create it from the current example. If it exists, preserve all existing values and comments, compare keys without displaying their values, and add only confirmed missing entries. Never replace a developer's environment wholesale.
3. Confirm every local environment or secret path is ignored with `git check-ignore` before writing sensitive data. Never print secret values, place them in command arguments that will be logged, or add them to tracked examples.
4. Do not invent provider credentials, hosted endpoints, payment data, or production-like values. Generate a secret only when the checked-in runtime explicitly accepts arbitrary local development material; write it without echoing it, restrict file permissions where supported, and say which key or file was populated without revealing the value. Otherwise report the exact input the developer must supply.
5. Keep network coordinates consistent with the chosen mode. Host processes usually need host-published addresses, while Compose services need container DNS names. Derive the PostgreSQL connection string and provider or Swarm endpoint from the same mode instead of mixing both namespaces.
6. Treat a Swarm model endpoint as a Relay upstream. Configure only the Relay-side reference and admission material required by the active contract; do not claim that the Swarm runtime itself is configured or healthy.

## Validate the result

- For every selected Compose file set, run `docker compose ... config --quiet`; avoid commands that render interpolated secrets. If services were explicitly requested, use their declared health checks and bounded logs to verify them.
- Run the narrowest applicable repository command from `package.json` or the affected workspace. Do not imply that dependency installation alone validates runtime configuration.
- Recheck Git status and verify no secret or generated dependency tree became tracked.
- Report separately: files created or updated, tool and dependency status, static configuration validity, service health, unresolved external inputs, and commands the developer can run next. Call the environment production-ready only if a separate production workflow actually established that fact.
