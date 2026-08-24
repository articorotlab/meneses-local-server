BEGIN;

-- =========================================================
-- 023_multi_credit_engine.sql
--
-- Financial Ledger V2 - Multi Credit Engine
--
-- Extiende financial_commit_credit() para soportar:
--
-- 1. Créditos normales existentes:
--
--      CASH
--      ADMIN_CREDIT
--
-- 2. Créditos compuestos:
--
--      CASH          500
--      PROMOTIONAL   200
--
--    dentro de una sola transacción de 700.
--
-- Retrocompatibilidad:
--
-- Si NO existen transaction_credit_components para una
-- transacción, se conserva exactamente el comportamiento
-- anterior basado en transactions.credit_fund_type.
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

    v_component record;

    v_component_count integer;

    v_component_total bigint;

BEGIN

    -- =====================================================
    -- BLOQUEAR TRANSACCIÓN
    -- =====================================================

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


    -- =====================================================
    -- TRANSACCIONES LEGACY
    -- =====================================================

    IF v_transaction.ledger_action IS NULL THEN

        RETURN;

    END IF;


    -- =====================================================
    -- SÓLO CREDIT
    -- =====================================================

    IF v_transaction.ledger_action <> 'CREDIT' THEN

        RETURN;

    END IF;


    -- =====================================================
    -- ACTIVACIÓN OBLIGATORIA
    -- =====================================================

    IF v_transaction.activation_id IS NULL THEN

        RAISE EXCEPTION
            'FINANCIAL_ACTIVATION_REQUIRED: transaction=%',
            p_transaction_id;

    END IF;


    -- =====================================================
    -- BUSCAR COMPONENTES
    -- =====================================================

    SELECT
        COUNT(*)::integer,
        COALESCE(
            SUM(amount),
            0
        )::bigint

    INTO
        v_component_count,
        v_component_total

    FROM transaction_credit_components

    WHERE transaction_id =
        p_transaction_id;


    -- =====================================================
    -- MULTI CREDIT
    -- =====================================================

    IF v_component_count > 0 THEN

        -- -------------------------------------------------
        -- La suma de componentes debe coincidir exactamente
        -- con el saldo acreditado por la transacción.
        -- -------------------------------------------------

        IF v_component_total <>
           v_transaction.amount THEN

            RAISE EXCEPTION
                'FINANCIAL_CREDIT_COMPONENT_TOTAL_MISMATCH: transaction=% transaction_amount=% components_total=%',
                p_transaction_id,
                v_transaction.amount,
                v_component_total;

        END IF;


        -- -------------------------------------------------
        -- Si hay PROMOTIONAL, la transacción debe estar
        -- relacionada con una promoción.
        -- -------------------------------------------------

        IF EXISTS (

            SELECT 1

            FROM transaction_credit_components

            WHERE transaction_id =
                p_transaction_id

              AND fund_type =
                'PROMOTIONAL'

        )
        AND v_transaction.promotion_id IS NULL THEN

            RAISE EXCEPTION
                'FINANCIAL_PROMOTION_REQUIRED: transaction=%',
                p_transaction_id;

        END IF;


        -- -------------------------------------------------
        -- Ningún componente puede apuntar a una promoción
        -- distinta a la registrada en transactions.
        -- -------------------------------------------------

        IF EXISTS (

            SELECT 1

            FROM transaction_credit_components

            WHERE transaction_id =
                p_transaction_id

              AND promotion_id IS NOT NULL

              AND promotion_id IS DISTINCT FROM
                  v_transaction.promotion_id

        ) THEN

            RAISE EXCEPTION
                'FINANCIAL_PROMOTION_MISMATCH: transaction=%',
                p_transaction_id;

        END IF;


        -- -------------------------------------------------
        -- Crear un lote por componente.
        --
        -- Ejemplo:
        --
        -- CASH          500
        -- PROMOTIONAL   200
        --
        -- Ambos pertenecen a la misma transacción.
        -- -------------------------------------------------

        FOR v_component IN

            SELECT
                id,
                fund_type,
                amount,
                promotion_id

            FROM transaction_credit_components

            WHERE transaction_id =
                p_transaction_id

            ORDER BY
                financial_fund_priority(
                    fund_type
                ),
                created_at,
                id

        LOOP

            -- ---------------------------------------------
            -- Protección adicional del tipo financiero.
            -- ---------------------------------------------

            IF v_component.fund_type NOT IN (
                'CASH',
                'PROMOTIONAL',
                'ADMIN_CREDIT'
            ) THEN

                RAISE EXCEPTION
                    'FINANCIAL_INVALID_CREDIT_TYPE: transaction=% type=%',
                    p_transaction_id,
                    v_component.fund_type;

            END IF;


            -- ---------------------------------------------
            -- Idempotencia por transaction + fund_type.
            -- ---------------------------------------------

            IF NOT EXISTS (

                SELECT 1

                FROM card_fund_lots

                WHERE source_transaction_id =
                    p_transaction_id

                  AND fund_type =
                    v_component.fund_type

            ) THEN

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
                    v_component.fund_type,
                    v_component.amount,
                    v_component.amount,
                    v_transaction.id,

                    COALESCE(
                        v_component.promotion_id,
                        v_transaction.promotion_id
                    ),

                    now()
                );

            END IF;

        END LOOP;


        RETURN;

    END IF;


    -- =====================================================
    -- COMPORTAMIENTO LEGACY / SINGLE CREDIT
    --
    -- Conserva exactamente el funcionamiento que ya
    -- utilizamos para:
    --
    -- TAQUILLA
    --   → CASH
    --
    -- ADMIN
    --   → ADMIN_CREDIT
    -- =====================================================

    IF v_transaction.credit_fund_type IS NULL THEN

        RAISE EXCEPTION
            'FINANCIAL_CREDIT_TYPE_REQUIRED: transaction=%',
            p_transaction_id;

    END IF;


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


    -- =====================================================
    -- IDEMPOTENCIA DEL CRÉDITO SIMPLE
    -- =====================================================

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
        v_transaction.promotion_id,
        now()
    );

END;

$$;


COMMIT;