-- Retire the external MCP Gateway runtime and its OAuth/credential state.
-- Historical MCP orchestration and billing facts remain append-only and are not dropped.

DROP TABLE IF EXISTS "mcp_access_tokens" CASCADE;
DROP TABLE IF EXISTS "mcp_authorization_codes" CASCADE;
DROP TABLE IF EXISTS "mcp_refresh_tokens" CASCADE;
DROP TABLE IF EXISTS "mcp_client_grants" CASCADE;
DROP TABLE IF EXISTS "mcp_oauth_clients" CASCADE;
DROP TABLE IF EXISTS "integration_oauth_states" CASCADE;
DROP TABLE IF EXISTS "external_integration_connections" CASCADE;

ALTER TABLE "api_keys" DROP CONSTRAINT IF EXISTS "api_keys_mcp_enabled_boolean_check";
ALTER TABLE "api_keys" DROP COLUMN IF EXISTS "mcp_enabled";
