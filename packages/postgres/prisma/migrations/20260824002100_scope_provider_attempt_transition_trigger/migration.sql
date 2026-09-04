-- ProviderAttempt lifecycle validation owns only lifecycle-field updates. Identity,
-- routing, price and stable-reference immutability remain owned by the separate
-- request_provider_attempts_immutable_update trigger.
DROP TRIGGER "request_provider_attempts_terminal_update" ON "request_provider_attempts";
CREATE TRIGGER "request_provider_attempts_terminal_update"
  BEFORE UPDATE OF
    "outcome", "failure_class", "output_committed", "trusted_usage_source", "ended_at",
    "cost_exposure", "final_usage_evidence", "usage_settled", "reconciliation_reason"
  ON "request_provider_attempts"
  FOR EACH ROW EXECUTE FUNCTION "friday_relay_validate_provider_attempt_terminal"();
