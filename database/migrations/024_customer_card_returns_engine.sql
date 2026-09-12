BEGIN;

-- =========================================================
-- 024_customer_card_returns_engine.sql
--
-- Motor seguro para devolución / reset de tarjetas CUSTOMER.
--
-- Objetivos:
--
-- 1. No alterar el ingreso histórico de la taquilla.
-- 2. Registrar por separado el efectivo devuelto por la
--    activación de la tarjeta.
-- 3. Registrar exactamente qué saldo se elimina:
--      CASH
--      PROMOTIONAL
--      ADMIN_CREDIT
--      LEGACY
-- 4. Permitir reutilizar posteriormente la misma tarjeta
--    física mediante una nueva customer_card_activation.
-- 5. Mantener flujo seguro:
--      AUTHORIZE -> escritura NFC -> CONFIRM
--
-- IMPORTANTE:
-- Ejecutar esta migración NO devuelve ni resetea ninguna
-- tarjeta existente.
-- =========================================================


-- =========================================================
-- 1. AMPLIAR AUDITORÍA DEFINITIVA DE DEVOLUCIONES
-- =========================================================

ALTER TABLE customer_card_returns
    ADD COLUMN IF NOT EXISTS device_id uuid
        REFERENCES devices(id);

ALTER TABLE customer_card_returns
    ADD COLUMN IF NOT EXISTS balance_before bigint;

ALTER TABLE customer_card_returns
    ADD COLUMN IF NOT EXISTS counter_before bigint;

ALTER TABLE customer_card_returns
    ADD COLUMN IF NOT EXISTS counter_after bigint NOT NULL DEFAULT 0;

ALTER TABLE customer_card_returns
    ADD COLUMN IF NOT EXISTS uid text;


ALTER TABLE customer_card_returns
    DROP CONSTRAINT IF EXISTS customer_card_returns_balance_before_check;

ALTER TABLE customer_card_returns
    ADD CONSTRAINT customer_card_returns_balance_before_check
        CHECK (
            balance_before IS NULL
            OR balance_before >= 0
        );


ALTER TABLE customer_card_returns
    DROP CONSTRAINT IF EXISTS customer_card_returns_counter_before_check;

ALTER TABLE customer_card_returns
    ADD CONSTRAINT customer_card_returns_counter_before_check
        CHECK (
            counter_before IS NULL
            OR counter_before >= 0
        );


ALTER TABLE customer_card_returns
    DROP CONSTRAINT IF EXISTS customer_card_returns_counter_after_check;

ALTER TABLE customer_card_returns
    ADD CONSTRAINT customer_card_returns_counter_after_check
        CHECK (
            counter_after >= 0
        );


CREATE INDEX IF NOT EXISTS
    customer_card_returns_device_idx
ON customer_card_returns(device_id);


-- =========================================================
-- 2. OPERACIONES PENDIENTES DE DEVOLUCIÓN
--
-- Una devolución NO debe hacerse definitiva hasta que
-- Android haya escrito y verificado la tarjeta física.
-- =========================================================

CREATE TABLE IF NOT EXISTS customer_card_return_operations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    idempotency_key text NOT NULL UNIQUE,

    device_id uuid NOT NULL
        REFERENCES devices(id),

    card_id bigint NOT NULL
        REFERENCES cards(card_id),

    activation_id uuid NOT NULL
        REFERENCES customer_card_activations(id),

    uid text NOT NULL,

    returned_by_role text NOT NULL,

    returned_by_card_id bigint
        REFERENCES cards(card_id),

    recharge_point_id uuid
        REFERENCES recharge_points(id),

    activation_fee bigint NOT NULL,
    refund_amount bigint NOT NULL,

    balance_before bigint NOT NULL,
    counter_before bigint NOT NULL,

    discarded_cash bigint NOT NULL DEFAULT 0,
    discarded_promotional bigint NOT NULL DEFAULT 0,
    discarded_admin_credit bigint NOT NULL DEFAULT 0,
    discarded_legacy bigint NOT NULL DEFAULT 0,

    status text NOT NULL DEFAULT 'AUTHORIZED',

    authorized_at timestamptz NOT NULL DEFAULT now(),
    confirmed_at timestamptz,
    failed_at timestamptz,
    failure_reason text,

    CONSTRAINT customer_card_return_operations_role_check
        CHECK (
            returned_by_role IN (
                'ADMIN',
                'RECHARGE'
            )
        ),

    CONSTRAINT customer_card_return_operations_status_check
        CHECK (
            status IN (
                'AUTHORIZED',
                'CONFIRMED',
                'FAILED'
            )
        ),

    CONSTRAINT customer_card_return_operations_activation_fee_check
        CHECK (
            activation_fee >= 0
        ),

    CONSTRAINT customer_card_return_operations_refund_check
        CHECK (
            refund_amount >= 0
        ),

    CONSTRAINT customer_card_return_operations_balance_check
        CHECK (
            balance_before >= 0
        ),

    CONSTRAINT customer_card_return_operations_counter_check
        CHECK (
            counter_before >= 0
        ),

    CONSTRAINT customer_card_return_operations_discarded_cash_check
        CHECK (
            discarded_cash >= 0
        ),

    CONSTRAINT customer_card_return_operations_discarded_promotional_check
        CHECK (
            discarded_promotional >= 0
        ),

    CONSTRAINT customer_card_return_operations_discarded_admin_check
        CHECK (
            discarded_admin_credit >= 0
        ),

    CONSTRAINT customer_card_return_operations_discarded_legacy_check
        CHECK (
            discarded_legacy >= 0
        )
);


CREATE INDEX IF NOT EXISTS
    customer_card_return_operations_card_idx
ON customer_card_return_operations(card_id);


CREATE INDEX IF NOT EXISTS
    customer_card_return_operations_activation_idx
ON customer_card_return_operations(activation_id);


CREATE INDEX IF NOT EXISTS
    customer_card_return_operations_recharge_point_idx
ON customer_card_return_operations(recharge_point_id);


CREATE INDEX IF NOT EXISTS
    customer_card_return_operations_status_idx
ON customer_card_return_operations(status);


-- Solo una devolución abierta por activación.
CREATE UNIQUE INDEX IF NOT EXISTS
    customer_card_return_operations_one_open_per_activation_idx
ON customer_card_return_operations(activation_id)
WHERE status = 'AUTHORIZED';


-- =========================================================
-- 3. FUNCIÓN DE AUTORIZACIÓN
--
-- Esta función:
-- - bloquea tarjeta + activación;
-- - exige CUSTOMER activa;
-- - exige current_activation_id correcto;
-- - exige activation_fee conocido;
-- - calcula composición exacta del saldo vigente;
-- - NO cambia todavía cards ni card_fund_lots.
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
    FROM customer_card_return_operations
    WHERE idempotency_key =
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
    FROM cards
    WHERE cards.card_id =
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
    FROM customer_card_activations
    WHERE id =
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
            SUM(remaining_amount)
            FILTER (
                WHERE fund_type =
                      'CASH'
            ),
            0
        ),

        COALESCE(
            SUM(remaining_amount)
            FILTER (
                WHERE fund_type =
                      'PROMOTIONAL'
            ),
            0
        ),

        COALESCE(
            SUM(remaining_amount)
            FILTER (
                WHERE fund_type =
                      'ADMIN_CREDIT'
            ),
            0
        ),

        COALESCE(
            SUM(remaining_amount)
            FILTER (
                WHERE fund_type =
                      'LEGACY'
            ),
            0
        )

    INTO
        v_cash,
        v_promotional,
        v_admin_credit,
        v_legacy

    FROM card_fund_lots

    WHERE card_id =
          v_card.card_id

      AND activation_id =
          v_activation.id

      AND remaining_amount >
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


-- =========================================================
-- 4. FUNCIÓN DE CONFIRMACIÓN
--
-- Debe llamarse SOLO después de que Android:
--
-- - haya escrito la tarjeta física;
-- - la haya leído nuevamente;
-- - haya comprobado:
--      mismo card_id
--      CUSTOMER
--      balance = 0
--      transaction_counter = 0
--
-- La confirmación:
-- - consume todos los lotes restantes;
-- - cierra activación;
-- - registra customer_card_returns;
-- - deja la tarjeta física reutilizable;
-- - NO modifica ingresos históricos de taquilla.
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
    FROM customer_card_return_operations
    WHERE id =
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
        FROM customer_card_returns
        WHERE activation_id =
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
    FROM cards
    WHERE cards.card_id =
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

    UPDATE card_fund_lots

    SET remaining_amount =
        0

    WHERE card_id =
          v_operation.card_id

      AND activation_id =
          v_operation.activation_id

      AND remaining_amount >
          0;


    -- -----------------------------------------------------
    -- CERRAR ACTIVACIÓN
    -- -----------------------------------------------------

    UPDATE customer_card_activations

    SET
        status =
            'RETURNED',

        ended_at =
            now()

    WHERE id =
          v_operation.activation_id

      AND status =
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

    UPDATE cards

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

    WHERE card_id =
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


    UPDATE customer_card_return_operations

    SET
        status =
            'CONFIRMED',

        confirmed_at =
            now(),

        failed_at =
            NULL,

        failure_reason =
            NULL

    WHERE id =
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


-- =========================================================
-- 5. FUNCIÓN DE FALLO
--
-- Si Android NO pudo escribir/verificar NFC:
-- - no se toca saldo;
-- - no se toca activación;
-- - solo se cierra la autorización.
-- =========================================================

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

    UPDATE customer_card_return_operations

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

    WHERE id =
          p_operation_id

      AND device_id =
          p_device_id

      AND status =
          'AUTHORIZED';


    GET DIAGNOSTICS
        v_updated =
            ROW_COUNT;


    RETURN
        v_updated = 1;
END;
$$;


-- =========================================================
-- 6. VISTA DE AUDITORÍA DE DEVOLUCIONES
--
-- Facilita reportes Web / Android.
-- =========================================================

CREATE OR REPLACE VIEW customer_card_returns_audit AS

SELECT
    r.id AS return_id,

    r.card_id,
    r.activation_id,

    a.activation_number,

    r.returned_by_role,
    r.returned_by_card_id,

    r.recharge_point_id,

    rp.recharge_code,
    rp.name AS recharge_point_name,

    r.device_id,

    d.device_code,
    d.name AS device_name,

    r.activation_fee,
    r.refund_amount,

    r.discarded_cash,
    r.discarded_promotional,
    r.discarded_admin_credit,
    r.discarded_legacy,

    (
        r.discarded_cash +
        r.discarded_promotional +
        r.discarded_admin_credit +
        r.discarded_legacy
    ) AS discarded_total,

    r.balance_before,
    r.counter_before,
    r.counter_after,

    r.uid,

    r.returned_at

FROM customer_card_returns r

JOIN customer_card_activations a
    ON a.id =
       r.activation_id

LEFT JOIN recharge_points rp
    ON rp.id =
       r.recharge_point_id

LEFT JOIN devices d
    ON d.id =
       r.device_id;


COMMIT;
