BEGIN;

-- =========================================================
-- 027_customer_card_return_confirm_conflict_fix.sql
--
-- Corrige la segunda ambigüedad detectada en
-- financial_confirm_card_return().
--
-- En una función RETURNS TABLE, activation_id también existe
-- como variable PL/pgSQL de salida. Por eso:
--
--   ON CONFLICT (activation_id)
--
-- resulta ambiguo en ejecución.
--
-- Usamos directamente el constraint único ya existente:
--
--   customer_card_returns_activation_unique
--
-- Esta migración NO modifica tarjetas, saldos ni operaciones.
-- Solo reemplaza la función.
-- =========================================================

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

    WHERE c.card_id =
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

    ON CONFLICT ON CONSTRAINT
        customer_card_returns_activation_unique
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

COMMIT;
