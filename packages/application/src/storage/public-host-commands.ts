import { bindPostgresAuditCommands } from "@frely/audit/application-internal";
import { RelayError } from "@frely/core";
import type { PostgresClientOwner } from "@frely/postgres/server";
import type { InstancePublicHost, PublicHostCommandAudit, PublicHostCommands } from "./public-host.js";
import { PostgresApplicationOperations } from "./postgres-application-operations.js";

/** Named Public Host mutations. Business state and required success Audit share one root transaction. */
export class PublicHostApplicationCommands implements PublicHostCommands {
  constructor(private readonly owner: PostgresClientOwner) {}

  create(input: { row: InstancePublicHost; audit: PublicHostCommandAudit }): Promise<InstancePublicHost> {
    return this.owner.withTransaction(async (transaction) => {
      const operations = new PostgresApplicationOperations(this.owner, transaction);
      const saved = await operations.createPublicHostRecord(input.row);
      await bindPostgresAuditCommands(transaction).record({
        actor: input.audit.actor,
        action: "public_host.create",
        resource: { resourceType: "public_host", resourceId: saved.id },
        result: "success",
        source: "owner",
        requestId: input.audit.requestId,
        metadata: { hostname: saved.hostname },
      });
      return saved;
    });
  }

  update(input: {
    id: string;
    enabled: boolean;
    updatedByUserId: string;
    updatedAt: string;
    audit: PublicHostCommandAudit;
  }): Promise<InstancePublicHost> {
    return this.owner.withTransaction(async (transaction) => {
      const operations = new PostgresApplicationOperations(this.owner, transaction);
      const current = await operations.getPublicHostRecord(input.id);
      if (!current) throw new RelayError("public_host_not_found", "Public Host not found", 404);
      if (current.enabled === input.enabled) return current;
      const saved = await operations.updatePublicHostRecord(input);
      if (!saved) throw new RelayError("public_host_not_found", "Public Host not found", 404);
      await bindPostgresAuditCommands(transaction).record({
        actor: input.audit.actor,
        action: input.enabled ? "public_host.enable" : "public_host.disable",
        resource: { resourceType: "public_host", resourceId: input.id },
        result: "success",
        source: "owner",
        requestId: input.audit.requestId,
        metadata: { hostname: saved.hostname, previous: current.enabled, enabled: saved.enabled },
      });
      return saved;
    });
  }

  delete(input: { id: string; audit: PublicHostCommandAudit }): Promise<void> {
    return this.owner.withTransaction(async (transaction) => {
      const operations = new PostgresApplicationOperations(this.owner, transaction);
      const current = await operations.getPublicHostRecord(input.id);
      if (!current || !await operations.deletePublicHostRecord(input.id)) {
        throw new RelayError("public_host_not_found", "Public Host not found", 404);
      }
      await bindPostgresAuditCommands(transaction).record({
        actor: input.audit.actor,
        action: "public_host.delete",
        resource: { resourceType: "public_host", resourceId: input.id },
        result: "success",
        source: "owner",
        requestId: input.audit.requestId,
        metadata: { hostname: current.hostname },
      });
    });
  }
}
