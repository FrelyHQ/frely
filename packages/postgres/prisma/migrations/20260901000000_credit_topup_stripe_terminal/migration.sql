ALTER TABLE "credit_topups"
  ADD COLUMN "payment_failed_at" text COLLATE "C";

ALTER TABLE "credit_topups"
  ADD CONSTRAINT "credit_topups_status_check"
  CHECK ("status" IN ('pending_payment', 'pending_review', 'expired', 'payment_failed', 'cancelled', 'rejected', 'credited', 'fulfilled', 'reversed'));

CREATE OR REPLACE FUNCTION "friday_relay_validate_credit_topup_status"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."status" IS DISTINCT FROM OLD."status"
    AND NOT (
      (OLD."status" = 'pending_payment' AND NEW."status" IN ('pending_review', 'expired', 'payment_failed', 'cancelled', 'credited', 'fulfilled'))
      OR (OLD."status" = 'pending_review' AND NEW."status" IN ('credited', 'fulfilled', 'rejected'))
      OR (OLD."status" = 'credited' AND NEW."status" = 'reversed')
      OR (OLD."status" = 'fulfilled' AND NEW."status" = 'reversed')
    )
  THEN
    RAISE EXCEPTION 'credit_topup status transition is invalid' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "credit_topups_status_transition" ON "credit_topups";
CREATE TRIGGER "credit_topups_status_transition"
  BEFORE UPDATE OF "status" ON "credit_topups"
  FOR EACH ROW EXECUTE FUNCTION "friday_relay_validate_credit_topup_status"();

DROP TRIGGER IF EXISTS "credit_topups_immutable_update" ON "credit_topups";
CREATE TRIGGER "credit_topups_immutable_update"
  BEFORE UPDATE ON "credit_topups"
  FOR EACH ROW EXECUTE FUNCTION "friday_relay_reject_immutable_update"(
    'credit_topups immutable fields cannot be updated',
    'status', 'transaction_reference', 'normalized_transaction_reference_hash', 'transaction_reference_tail',
    'claimed_paid_at', 'payment_submitted_at', 'expired_at', 'payment_failed_at',
    'confirmed_received_amount_units', 'ledger_event_id', 'card_id', 'credited_at',
    'reviewed_by_user_id', 'reviewed_at', 'review_note', 'admin_note', 'refund_note',
    'refund_recorded_by_user_id', 'refund_recorded_at', 'updated_at', 'cancelled_by_user_id',
    'cancelled_at', 'reversed_by_user_id', 'reversed_at', 'reversal_ledger_event_id', 'reversal_reason'
  );
