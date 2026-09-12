-- 029_allow_admin_created_card_returns.sql
BEGIN;

CREATE OR REPLACE FUNCTION public.financial_authorize_card_return(
    p_idempotency_key text,
    p_device_id uuid,
    p_card_id bigint,
    p_uid text,
    p_returned_by_role text,
    p_returned_by_card_id bigint,
    p_recharge_point_id uuid
)
RETURNS TABLE(
    operation_id uuid,
    card_id bigint,
    activation_id uuid,
    uid text,
    balance_before bigint,
    counter_before bigint,
    refund_amount bigint,
    discarded_cash bigint,
    discarded_promotional bigint,
    discarded_admin_credit bigint,
    discarded_legacy bigint,
    duplicated boolean
)
LANGUAGE plpgsql
AS $function$
DECLARE
    v_existing customer_card_return_operations%ROWTYPE;
    v_card cards%ROWTYPE;
    v_activation customer_card_activations%ROWTYPE;
    v_cash bigint := 0;
    v_promotional bigint := 0;
    v_admin_credit bigint := 0;
    v_legacy bigint := 0;
    v_ledger_total bigint := 0;
    v_refund_amount bigint := 0;
    v_operation customer_card_return_operations%ROWTYPE;
BEGIN
    IF p_idempotency_key IS NULL
       OR length(trim(p_idempotency_key)) = 0 THEN
        RAISE EXCEPTION 'INVALID_IDEMPOTENCY_KEY';
    END IF;

    IF p_uid IS NULL
       OR length(trim(p_uid)) = 0 THEN
        RAISE EXCEPTION 'INVALID_UID';
    END IF;

    IF p_returned_by_role NOT IN ('ADMIN', 'RECHARGE') THEN
        RAISE EXCEPTION 'INVALID_RETURN_ROLE';
    END IF;

    SELECT *
    INTO v_existing
    FROM customer_card_return_operations cro
    WHERE cro.idempotency_key = p_idempotency_key
    LIMIT 1;

    IF FOUND THEN
        RETURN QUERY
        SELECT
            v_existing.id,
            v_existing.card_id,
            v_existing.activation_id,
            v_existing.uid,
            v_existing.balance_before,
            v_existing.counter_before,
            v_existing.refund_amount,
            v_existing.discarded_cash,
            v_existing.discarded_promotional,
            v_existing.discarded_admin_credit,
            v_existing.discarded_legacy,
            true;
        RETURN;
    END IF;

    SELECT *
    INTO v_card
    FROM cards c
    WHERE c.card_id = p_card_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'CARD_NOT_FOUND';
    END IF;

    IF v_card.card_type <> 'CUSTOMER' THEN
        RAISE EXCEPTION 'CARD_NOT_CUSTOMER';
    END IF;

    IF upper(trim(v_card.uid)) <> upper(trim(p_uid)) THEN
        RAISE EXCEPTION 'UID_MISMATCH';
    END IF;

    IF v_card.status <> 'ACTIVE' THEN
        RAISE EXCEPTION 'CARD_NOT_ACTIVE';
    END IF;

    IF v_card.current_activation_id IS NULL THEN
        RAISE EXCEPTION 'CARD_HAS_NO_ACTIVE_ACTIVATION';
    END IF;

    SELECT *
    INTO v_activation
    FROM customer_card_activations a
    WHERE a.id = v_card.current_activation_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'ACTIVATION_NOT_FOUND';
    END IF;

    IF v_activation.card_id <> v_card.card_id THEN
        RAISE EXCEPTION 'ACTIVATION_CARD_MISMATCH';
    END IF;

    IF v_activation.status <> 'ACTIVE' THEN
        RAISE EXCEPTION 'ACTIVATION_NOT_ACTIVE';
    END IF;

    -- Política de reembolso:
    -- 1) cuota conocida -> devolver exactamente activation_fee.
    -- 2) activación creada por ADMIN con cuota desconocida -> permitir reset, devolver $0.
    -- 3) cualquier otro fee desconocido -> bloquear para revisión ADMIN.
    IF v_activation.activation_fee_known THEN
        v_refund_amount := v_activation.activation_fee;
    ELSIF v_activation.activated_by_role = 'ADMIN' THEN
        v_refund_amount := 0;
    ELSE
        RAISE EXCEPTION 'ACTIVATION_FEE_UNKNOWN';
    END IF;

    SELECT
        COALESCE(SUM(cfl.remaining_amount) FILTER (WHERE cfl.fund_type = 'CASH'), 0),
        COALESCE(SUM(cfl.remaining_amount) FILTER (WHERE cfl.fund_type = 'PROMOTIONAL'), 0),
        COALESCE(SUM(cfl.remaining_amount) FILTER (WHERE cfl.fund_type = 'ADMIN_CREDIT'), 0),
        COALESCE(SUM(cfl.remaining_amount) FILTER (WHERE cfl.fund_type = 'LEGACY'), 0)
    INTO
        v_cash,
        v_promotional,
        v_admin_credit,
        v_legacy
    FROM card_fund_lots cfl
    WHERE cfl.card_id = v_card.card_id
      AND cfl.activation_id = v_activation.id
      AND cfl.remaining_amount > 0;

    v_ledger_total := v_cash + v_promotional + v_admin_credit + v_legacy;

    IF v_ledger_total <> v_card.balance THEN
        RAISE EXCEPTION
            'CARD_RETURN_LEDGER_MISMATCH: card_balance=% ledger_balance=%',
            v_card.balance,
            v_ledger_total;
    END IF;

    INSERT INTO customer_card_return_operations (
        idempotency_key,
        device_id,
        card_id,
        activation_id,
        uid,
        returned_by_role,
        returned_by_card_id,
        recharge_point_id,
        activation_fee,
        refund_amount,
        balance_before,
        counter_before,
        discarded_cash,
        discarded_promotional,
        discarded_admin_credit,
        discarded_legacy,
        status
    )
    VALUES (
        trim(p_idempotency_key),
        p_device_id,
        v_card.card_id,
        v_activation.id,
        upper(trim(v_card.uid)),
        p_returned_by_role,
        p_returned_by_card_id,
        p_recharge_point_id,
        v_activation.activation_fee,
        v_refund_amount,
        v_card.balance,
        v_card.transaction_counter,
        v_cash,
        v_promotional,
        v_admin_credit,
        v_legacy,
        'AUTHORIZED'
    )
    RETURNING *
    INTO v_operation;

    RETURN QUERY
    SELECT
        v_operation.id,
        v_operation.card_id,
        v_operation.activation_id,
        v_operation.uid,
        v_operation.balance_before,
        v_operation.counter_before,
        v_operation.refund_amount,
        v_operation.discarded_cash,
        v_operation.discarded_promotional,
        v_operation.discarded_admin_credit,
        v_operation.discarded_legacy,
        false;
END;
$function$;

COMMIT;
