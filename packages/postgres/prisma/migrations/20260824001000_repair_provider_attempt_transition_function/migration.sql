CREATE OR REPLACE FUNCTION "friday_relay_validate_provider_attempt_terminal"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.outcome = 'pending' THEN
    IF OLD.outcome <> 'pending'
       OR OLD.cost_exposure <> 'not_started'
       OR NEW.cost_exposure <> 'accruing'
       OR NEW.ended_at IS NOT NULL
       OR NEW.failure_class IS NOT NULL
       OR NEW.trusted_usage_source IS NOT NULL
       OR NEW.usage_settled <> 0
       OR NEW.final_usage_evidence <> 'pending'
    THEN
      RAISE EXCEPTION 'Provider Attempt dispatch transition is invalid' USING ERRCODE = '55000';
    END IF;
  ELSIF OLD.usage_settled = 1
     OR NEW.outcome NOT IN ('succeeded','failed','aborted')
     OR NEW.ended_at IS NULL
     OR (NEW.outcome = 'succeeded' AND NEW.failure_class IS NOT NULL)
     OR (NEW.outcome = 'failed' AND NEW.failure_class IS NULL)
     OR (NEW.outcome = 'aborted' AND NEW.failure_class IS NOT NULL)
     OR (NEW.usage_settled = 0 AND NEW.final_usage_evidence <> 'pending')
     OR (NEW.usage_settled = 1 AND (NEW.cost_exposure <> 'stopped' OR NEW.final_usage_evidence <> 'final' OR NEW.trusted_usage_source IS NULL))
  THEN
    RAISE EXCEPTION 'Provider Attempt terminal transition is invalid' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;
