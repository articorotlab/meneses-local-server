BEGIN;

-- =========================================================
-- 020_financial_credit_engine.sql
--
-- Financial Ledger V2 - CREDIT engine
--
-- Materializa en card_fund_lots los créditos asociados
-- a una transacción.
--
-- Ejemplos:
--
-- RECHARGE desde TAQUILLA
--   ledger_action = CREDIT
--   credit_fund_type = CASH
--
-- RECHARGE desde ADMIN
--   ledger_action = CREDIT
--   credit_fund_type = ADMIN_CREDIT
--
-- IMPORTANTE:
-- Esta función NO actualiza cards.balance.
-- Esa responsabilidad continúa en el protocolo existente
-- CONFIRM / RECONCILE.
-- =========================================================


-- =========================================================
-- 1. EVITAR DUPLICAR UN MISMO TIPO DE FONDO
--    PARA LA MISMA TRANSACCIÓN
--
-- Esto permitirá más adelante que una promoción genere:
--
-- transaction X
--   CASH          500
--   PROMOTIONAL   200
--
-- pero impedirá:
--
-- transaction X
--   CASH          500
--   CASH          500   <- duplicado
-- =========================================================

CREATE UNIQUE INDEX
card_fund_lots_source_transaction_type_unique_idx

ON card_fund_lots (
    source_transaction_id,
    fund_type
)

WHERE source_transaction_id IS NOT NULL;


-- =========================================================
-- 2. FUNCIÓN DE COMMIT DE UN CRÉDITO
-- =========================================================

CREATE OR REPLACE FUNCTION
financial_commit_credit(
    p_transaction_id uuid
)
RETURNS void

LANGUAGE plpgsql

AS $$

DECLARE

    v_transaction
        transactions%ROWTYPE;

BEGIN

    /*
     * Bloqueamos la transacción.
     */

    SELECT *
    INTO v_transaction

    FROM transactions

    WHERE id =
        p_transaction_id

    FOR UPDATE;


    IF NOT FOUND THEN

        RAISE EXCEPTION
            'FINANCIAL_TRANSACTION_NOT_FOUND: %',
            p_transaction_id;

    END IF;


    /*
     * Las transacciones legacy/no migradas no requieren
     * comportamiento financiero nuevo.
     */

    IF v_transaction.ledger_action IS NULL THEN

        RETURN;

    END IF;


    /*
     * Esta función sólo materializa CREDIT.
     */

    IF v_transaction.ledger_action <> 'CREDIT' THEN

        RETURN;

    END IF;


    IF v_transaction.activation_id IS NULL THEN

        RAISE EXCEPTION
            'FINANCIAL_ACTIVATION_REQUIRED: transaction=%',
            p_transaction_id;

    END IF;


    IF v_transaction.credit_fund_type IS NULL THEN

        RAISE EXCEPTION
            'FINANCIAL_CREDIT_TYPE_REQUIRED: transaction=%',
            p_transaction_id;

    END IF;


    /*
     * De momento sólo admitimos los créditos que ya
     * conocemos.
     *
     * PROMOTIONAL se utilizará cuando implementemos
     * promociones.
     */

    IF v_transaction.credit_fund_type NOT IN (
        'CASH',
        'PROMOTIONAL',
        'ADMIN_CREDIT'
    ) THEN

        RAISE EXCEPTION
            'FINANCIAL_INVALID_CREDIT_TYPE: transaction=% type=%',
            p_transaction_id,
            v_transaction.credit_fund_type;

    END IF;


    /*
     * Idempotencia.
     *
     * Si este tipo de fondo ya fue materializado para
     * esta transacción, no volvemos a crearlo.
     */

    IF EXISTS (
        SELECT 1

        FROM card_fund_lots

        WHERE source_transaction_id =
            p_transaction_id

          AND fund_type =
            v_transaction.credit_fund_type
    ) THEN

        RETURN;

    END IF;


    INSERT INTO card_fund_lots (
        card_id,
        activation_id,
        fund_type,
        original_amount,
        remaining_amount,
        source_transaction_id,
        promotion_id,
        created_at
    )

    VALUES (
        v_transaction.card_id,
        v_transaction.activation_id,
        v_transaction.credit_fund_type,
        v_transaction.amount,
        v_transaction.amount,
        v_transaction.id,
        NULL,
        now()
    );

END;

$$;


COMMIT;