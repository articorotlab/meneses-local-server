BEGIN;

-- =========================================================
-- 025_customer_card_returns_engine_fix.sql
--
-- Corrige referencias ambiguas dentro de las funciones
-- PL/pgSQL de devolución de tarjetas.
--
-- La causa:
-- RETURNS TABLE define variables de salida como card_id,
-- activation_id, etc. Las consultas SQL internas deben usar
-- aliases explícitos para no chocar con esos nombres.
--
-- Esta migración NO modifica tarjetas, saldos ni operaciones.
-- Solo reemplaza las funciones.
-- =========================================================

CREATE OR REPLACE FUNCTION financial_authorize_card_return(
    p_idempotency_key text,
    p_device_id uuid,
    p_card_id bigint,
    p_uid text,
    p_returned_by_role text,
    p_returned_by_card_id bigint,
    p_recharge_point_id uuid
)
RETURNS TABLE (
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
AS $$
DECLARE
    v_existing customer_card_return_operations%ROWTYPE;

    v_card cards%ROWTYPE;

    v_activation customer_card_activations%ROWTYPE;

    v_cash bigint := 0;
    v_promotional bigint := 0;
    v_admin_credit bigint := 0;
    v_legacy bigint := 0;

    v_ledger_total bigint := 0;

    v_operation customer_card_return_operations%ROWTYPE;
BEGIN

    IF p_idempotency_key IS NULL
       OR length(trim(p_idempotency_key)) = 0 THEN

        RAISE EXCEPTION
            'INVALID_IDEMPOTENCY_KEY';
    END IF;


    IF p_uid IS NULL
       OR length(trim(p_uid)) = 0 THEN

        RAISE EXCEPTION
            'INVALID_UID';
    END IF;


    IF p_returned_by_role NOT IN (
        'ADMIN',
        'RECHARGE'
    ) THEN

        RAISE EXCEPTION
            'INVALID_RETURN_ROLE';
    END IF;


    -- -----------------------------------------------------
    -- IDEMPOTENCIA
    -- -----------------------------------------------------

    SELECT *
    INTO v_existing
    FROM customer_card_return_operations cro
    WHERE cro.idempotency_key =
          p_idempotency_key
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


    -- -----------------------------------------------------
    -- TARJETA
    -- -----------------------------------------------------

    SELECT *
    INTO v_card
    FROM cards c
    WHERE c.card_id =
          p_card_id
    FOR UPDATE;


    IF NOT FOUND THEN

        RAISE EXCEPTION
            'CARD_NOT_FOUND';
    END IF;


    IF v_card.card_type <> 'CUSTOMER' THEN

        RAISE EXCEPTION
            'CARD_NOT_CUSTOMER';
    END IF;


    IF upper(trim(v_card.uid)) <>
       upper(trim(p_uid)) THEN

        RAISE EXCEPTION
            'UID_MISMATCH';
    END IF;


    IF v_card.status <> 'ACTIVE' THEN

        RAISE EXCEPTION
            'CARD_NOT_ACTIVE';
    END IF;


    IF v_card.current_activation_id IS NULL THEN

        RAISE EXCEPTION
            'CARD_HAS_NO_ACTIVE_ACTIVATION';
    END IF;


    -- -----------------------------------------------------
    -- ACTIVACIÓN ACTUAL
    -- -----------------------------------------------------

    SELECT *
    INTO v_activation
    FROM customer_card_activations a
    WHERE a.id =
          v_card.current_activation_id
    FOR UPDATE;


    IF NOT FOUND THEN

        RAISE EXCEPTION
            'ACTIVATION_NOT_FOUND';
    END IF;


    IF v_activation.card_id <>
       v_card.card_id THEN

        RAISE EXCEPTION
            'ACTIVATION_CARD_MISMATCH';
    END IF;


    IF v_activation.status <> 'ACTIVE' THEN

        RAISE EXCEPTION
            'ACTIVATION_NOT_ACTIVE';
    END IF;


    IF NOT v_activation.activation_fee_known THEN

        RAISE EXCEPTION
            'ACTIVATION_FEE_UNKNOWN';
    END IF;


    -- -----------------------------------------------------
    -- COMPOSICIÓN EXACTA DEL SALDO
    -- -----------------------------------------------------

    SELECT
        COALESCE(
            SUM(cfl.remaining_amount)
            FILTER (
                WHERE cfl.fund_type =
                      'CASH'
            ),
            0
        ),

        COALESCE(
            SUM(cfl.remaining_amount)
            FILTER (
                WHERE cfl.fund_type =
                      'PROMOTIONAL'
            ),
            0
        ),

        COALESCE(
            SUM(cfl.remaining_amount)
            FILTER (
                WHERE cfl.fund_type =
                      'ADMIN_CREDIT'
            ),
            0
        ),

        COALESCE(
            SUM(cfl.remaining_amount)
            FILTER (
                WHERE cfl.fund_type =
                      'LEGACY'
            ),
            0
        )

    INTO
        v_cash,
        v_promotional,
        v_admin_credit,
        v_legacy

    FROM card_fund_lots cfl

    WHERE cfl.card_id =
          v_card.card_id

      AND cfl.activation_id =
          v_activation.id

      AND cfl.remaining_amount >
          0;


    v_ledger_total :=
        v_cash +
        v_promotional +
        v_admin_credit +
        v_legacy;


    IF v_ledger_total <>
       v_card.balance THEN

        RAISE EXCEPTION
            'CARD_RETURN_LEDGER_MISMATCH: card_balance=% ledger_balance=%',
            v_card.balance,
            v_ledger_total;
    END IF;


    -- -----------------------------------------------------
    -- CREAR AUTORIZACIÓN
    --
    -- refund_amount es EXACTAMENTE activation_fee.
    -- El saldo restante NO se entrega al cliente.
    -- -----------------------------------------------------

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
        v_activation.activation_fee,

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
$$;

CREATE OR REPLACE FUNCTION financial_confirm_card_return(
    p_operation_id uuid,
    p_device_id uuid,
    p_card_id bigint,
    p_uid text
)
RETURNS TABLE (
    return_id uuid,
    operation_id uuid,
    card_id bigint,
    activation_id uuid,
    refund_amount bigint,
    discarded_cash bigint,
    discarded_promotional bigint,
    discarded_admin_credit bigint,
    discarded_legacy bigint,
    duplicated boolean
)
LANGUAGE plpgsql
AS $$
DECLARE
    v_operation customer_card_return_operations%ROWTYPE;

    v_card cards%ROWTYPE;

    v_return customer_card_returns%ROWTYPE;
BEGIN

    SELECT *
    INTO v_operation
    FROM customer_card_return_operations cro
    WHERE cro.id =
          p_operation_id
    FOR UPDATE;


    IF NOT FOUND THEN

        RAISE EXCEPTION
            'CARD_RETURN_OPERATION_NOT_FOUND';
    END IF;


    IF v_operation.device_id <>
       p_device_id THEN

        RAISE EXCEPTION
            'CARD_RETURN_DEVICE_MISMATCH';
    END IF;


    IF v_operation.card_id <>
       p_card_id THEN

        RAISE EXCEPTION
            'CARD_RETURN_CARD_MISMATCH';
    END IF;


    IF upper(trim(v_operation.uid)) <>
       upper(trim(p_uid)) THEN

        RAISE EXCEPTION
            'CARD_RETURN_UID_MISMATCH';
    END IF;


    -- -----------------------------------------------------
    -- CONFIRMACIÓN REPETIDA
    -- -----------------------------------------------------

    IF v_operation.status =
       'CONFIRMED' THEN

        SELECT *
        INTO v_return
        FROM customer_card_returns ccr
        WHERE ccr.activation_id =
              v_operation.activation_id
        LIMIT 1;


        IF NOT FOUND THEN

            RAISE EXCEPTION
                'CARD_RETURN_CONFIRMED_WITHOUT_AUDIT_ROW';
        END IF;


        RETURN QUERY
        SELECT
            v_return.id,
            v_operation.id,
            v_operation.card_id,
            v_operation.activation_id,
            v_operation.refund_amount,
            v_operation.discarded_cash,
            v_operation.discarded_promotional,
            v_operation.discarded_admin_credit,
            v_operation.discarded_legacy,
            true;

        RETURN;
    END IF;


    IF v_operation.status <>
       'AUTHORIZED' THEN

        RAISE EXCEPTION
            'CARD_RETURN_OPERATION_NOT_AUTHORIZED';
    END IF;


    -- -----------------------------------------------------
    -- REVALIDAR TARJETA EN SERVIDOR
    -- -----------------------------------------------------

    SELECT *
    INTO v_card
    FROM cards c
    WHERE c.card_id =
          v_operation.card_id
    FOR UPDATE;


    IF NOT FOUND THEN

        RAISE EXCEPTION
            'CARD_NOT_FOUND';
    END IF;


    IF v_card.card_type <>
       'CUSTOMER' THEN

        RAISE EXCEPTION
            'CARD_NOT_CUSTOMER';
    END IF;


    IF upper(trim(v_card.uid)) <>
       upper(trim(v_operation.uid)) THEN

        RAISE EXCEPTION
            'UID_MISMATCH';
    END IF;


    IF v_card.current_activation_id <>
       v_operation.activation_id THEN

        RAISE EXCEPTION
            'CARD_ACTIVATION_CHANGED';
    END IF;


    IF v_card.balance <>
       v_operation.balance_before THEN

        RAISE EXCEPTION
            'CARD_BALANCE_CHANGED_AFTER_RETURN_AUTHORIZATION';
    END IF;


    IF v_card.transaction_counter <>
       v_operation.counter_before THEN

        RAISE EXCEPTION
            'CARD_COUNTER_CHANGED_AFTER_RETURN_AUTHORIZATION';
    END IF;


    -- -----------------------------------------------------
    -- DESCARTAR SALDO ACTUAL
    -- -----------------------------------------------------

    UPDATE card_fund_lots cfl

    SET remaining_amount =
        0

    WHERE cfl.card_id =
          v_operation.card_id

      AND cfl.activation_id =
          v_operation.activation_id

      AND cfl.remaining_amount >
          0;


    -- -----------------------------------------------------
    -- CERRAR ACTIVACIÓN
    -- -----------------------------------------------------

    UPDATE customer_card_activations cca

    SET
        status =
            'RETURNED',

        ended_at =
            now()

    WHERE cca.id =
          v_operation.activation_id

      AND cca.status =
          'ACTIVE';


    IF NOT FOUND THEN

        RAISE EXCEPTION
            'ACTIVE_ACTIVATION_NOT_FOUND_DURING_CONFIRM';
    END IF;


    -- -----------------------------------------------------
    -- DEJAR TARJETA FÍSICA DISPONIBLE PARA REUTILIZACIÓN
    --
    -- El card_id y UID se conservan.
    -- La próxima alta creará activation_number + 1.
    -- -----------------------------------------------------

    UPDATE cards c

    SET
        status =
            'INACTIVE',

        balance =
            0,

        transaction_counter =
            0,

        current_activation_id =
            NULL,

        updated_at =
            now()

    WHERE cfl.card_id =
          v_operation.card_id;


    -- -----------------------------------------------------
    -- AUDITORÍA DEFINITIVA
    -- -----------------------------------------------------

    INSERT INTO customer_card_returns (
        card_id,
        activation_id,

        returned_by_role,
        returned_by_card_id,

        recharge_point_id,
        device_id,

        activation_fee,
        refund_amount,

        discarded_cash,
        discarded_promotional,
        discarded_admin_credit,
        discarded_legacy,

        balance_before,
        counter_before,
        counter_after,

        uid,

        returned_at
    )
    VALUES (
        v_operation.card_id,
        v_operation.activation_id,

        v_operation.returned_by_role,
        v_operation.returned_by_card_id,

        v_operation.recharge_point_id,
        v_operation.device_id,

        v_operation.activation_fee,
        v_operation.refund_amount,

        v_operation.discarded_cash,
        v_operation.discarded_promotional,
        v_operation.discarded_admin_credit,
        v_operation.discarded_legacy,

        v_operation.balance_before,
        v_operation.counter_before,
        0,

        v_operation.uid,

        now()
    )

    ON CONFLICT (
        activation_id
    )
    DO UPDATE

    SET
        returned_at =
            customer_card_returns.returned_at

    RETURNING *
    INTO v_return;


    UPDATE customer_card_return_operations cro

    SET
        status =
            'CONFIRMED',

        confirmed_at =
            now(),

        failed_at =
            NULL,

        failure_reason =
            NULL

    WHERE cro.id =
          v_operation.id;


    RETURN QUERY
    SELECT
        v_return.id,
        v_operation.id,
        v_operation.card_id,
        v_operation.activation_id,
        v_operation.refund_amount,
        v_operation.discarded_cash,
        v_operation.discarded_promotional,
        v_operation.discarded_admin_credit,
        v_operation.discarded_legacy,
        false;
END;
$$;

CREATE OR REPLACE FUNCTION financial_fail_card_return(
    p_operation_id uuid,
    p_device_id uuid,
    p_reason text
)
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
    v_updated integer;
BEGIN

    UPDATE customer_card_return_operations cro

    SET
        status =
            'FAILED',

        failed_at =
            now(),

        failure_reason =
            COALESCE(
                NULLIF(
                    trim(p_reason),
                    ''
                ),
                'Fallo reportado por dispositivo.'
            )

    WHERE cro.id =
          p_operation_id

      AND cro.device_id =
          p_device_id

      AND cro.status =
          'AUTHORIZED';


    GET DIAGNOSTICS
        v_updated =
            ROW_COUNT;


    RETURN
        v_updated = 1;
END;
$$;

COMMIT;
