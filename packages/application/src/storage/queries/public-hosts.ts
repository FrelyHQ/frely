import type { InstancePublicHost, InstancePublicHostPage } from "../public-host.js";
import { normalizeDirectoryPage, normalizeDirectoryPageSize } from "./pagination.js";

const SELECT_PUBLIC_HOST = `
  SELECT id, hostname, enabled, created_by_user_id AS createdByUserId,
    updated_by_user_id AS updatedByUserId, created_at AS createdAt, updated_at AS updatedAt
  FROM instance_public_hosts
`;
