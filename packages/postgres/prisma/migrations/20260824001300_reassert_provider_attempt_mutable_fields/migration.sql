DROP TRIGGER IF EXISTS "request_provider_attempts_immutable_update" ON "request_provider_attempts";
CREATE TRIGGER "request_provider_attempts_immutable_update"
BEFORE UPDATE ON "request_provider_attempts"
FOR EACH ROW EXECUTE FUNCTION "friday_relay_reject_immutable_update"(
  'Provider Attempt identity cannot be updated',
  'outcome', 'failure_class', 'output_committed', 'trusted_usage_source', 'ended_at',
  'cost_exposure', 'final_usage_evidence', 'usage_settled', 'reconciliation_reason'
);
