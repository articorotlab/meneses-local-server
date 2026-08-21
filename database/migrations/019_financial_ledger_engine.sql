BEGIN;

-- =========================================================
-- 019_financial_ledger_engine.sql
--
-- Financial Ledger V2 - Transaction Engine Foundation
--
-- Prepara el protocolo:
--
-- AUTHORIZE
--   -> reserva fondos
--
-- CONFIRM
--   -> consume reservas
--   -> crea allocations definitivas
--
-- FAIL / RECONCILE BEFORE
--   -> libera reservas
--
-- RECONCILE AFTER
--   -> consume reservas
--
-- Prioridad de consumo definida:
--
--   1. LEGACY
--   2. CASH
--   3. PROMOTIONAL
--   4. ADMIN_CREDIT
--
-- Esta migración todavía NO modifica las rutas Node.
-- =========================================================


-- =========================================================
-- 1. RESERVAS TEMPORALES DE FONDOS
-- =========================================================

CREATE TABLE transaction_fund_reservations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    transaction_id uuid NOT NULL
        REFERENCES transactions(id),

    fund_lot_id uuid NOT NULL
        REFERENCES card_fund_lots(id),

    fund_type text NOT NULL,

    amount bigint NOT NULL,

    status text NOT NULL DEFAULT 'RESERVED',

    created_at timestamptz NOT NULL DEFAULT now(),
    resolved_at timestamptz,

    CONSTRAINT transaction_fund_reservations_type_check
        CHECK (
            fund_type IN (
                'LEGACY',
                'CASH',
                'PROMOTIONAL',
                'ADMIN_CREDIT'
            )
        ),

    CONSTRAINT transaction_fund_reservations_amount_check
        CHECK (amount > 0),

    CONSTRAINT transaction_fund_reservations_status_check
        CHECK (
            status IN (
                'RESERVED',
                'COMMITTED',
                'RELEASED'
            )
        ),

    CONSTRAINT transaction_fund_reservations_unique_lot
        UNIQUE (
            transaction_id,
            fund_lot_id
        )
);


CREATE INDEX transaction_fund_reservations_transaction_idx
    ON transaction_fund_reservations(transaction_id);


CREATE INDEX transaction_fund_reservations_lot_idx
    ON transaction_fund_reservations(fund_lot_id);


CREATE INDEX transaction_fund_reservations_open_idx
    ON transaction_fund_reservations(transaction_id)
    WHERE status = 'RESERVED';


-- =========================================================
-- 2. METADATOS DEL LEDGER EN TRANSACTIONS
--
-- ledger_action:
--
-- CREDIT
--   RECHARGE que agrega fondos.
--
-- DEBIT
--   CHARGE / ADJUSTMENT que consume fondos.
--
-- credit_fund_type:
--
-- Para CREDIT indica qué clase de saldo será creado al
-- confirmar la transacción.
--
-- Ejemplos:
--
-- RECHARGE de TAQUILLA:
--   CREDIT / CASH
--
-- RECHARGE de ADMIN:
--   CREDIT / ADMIN_CREDIT
--
-- =========================================================

ALTER TABLE transactions
ADD COLUMN ledger_action text;


ALTER TABLE transactions
ADD COLUMN credit_fund_type text;


ALTER TABLE transactions
ADD CONSTRAINT transactions_ledger_action_check
CHECK (
    ledger_action IS NULL
    OR ledger_action IN (
        'CREDIT',
        'DEBIT'
    )
);


ALTER TABLE transactions
ADD CONSTRAINT transactions_credit_fund_type_check
CHECK (
    credit_fund_type IS NULL
    OR credit_fund_type IN (
        'CASH',
        'PROMOTIONAL',
        'ADMIN_CREDIT',
        'LEGACY'
    )
);


-- =========================================================
-- 3. COHERENCIA CREDIT / DEBIT
-- =========================================================

ALTER TABLE transactions
ADD CONSTRAINT transactions_ledger_credit_consistency_check
CHECK (
    ledger_action IS NULL

    OR (
        ledger_action = 'CREDIT'
        AND credit_fund_type IS NOT NULL
    )

    OR (
        ledger_action = 'DEBIT'
        AND credit_fund_type IS NULL
    )
);


CREATE INDEX transactions_ledger_action_idx
    ON transactions(ledger_action);


CREATE INDEX transactions_credit_fund_type_idx
    ON transactions(credit_fund_type);


-- =========================================================
-- 4. FUNCIÓN DE PRIORIDAD DE FONDOS
--
-- Centralizamos la prioridad para que no quede repetida
-- arbitrariamente en diferentes queries.
-- =========================================================

CREATE OR REPLACE FUNCTION financial_fund_priority(
    p_fund_type text
)
RETURNS integer
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
    SELECT
        CASE p_fund_type
            WHEN 'LEGACY'
                THEN 1

            WHEN 'CASH'
                THEN 2

            WHEN 'PROMOTIONAL'
                THEN 3

            WHEN 'ADMIN_CREDIT'
                THEN 4

            ELSE 999
        END;
$$;


-- =========================================================
-- 5. VISTA DE SALDOS POR TARJETA / ACTIVACIÓN
--
-- Facilita auditoría y pruebas.
-- =========================================================

CREATE VIEW customer_card_fund_balances AS

SELECT
    c.card_id,
    c.current_activation_id AS activation_id,

    COALESCE(
        SUM(f.remaining_amount),
        0
    ) AS total_balance,

    COALESCE(
        SUM(f.remaining_amount)
            FILTER (
                WHERE f.fund_type = 'LEGACY'
            ),
        0
    ) AS legacy_balance,

    COALESCE(
        SUM(f.remaining_amount)
            FILTER (
                WHERE f.fund_type = 'CASH'
            ),
        0
    ) AS cash_balance,

    COALESCE(
        SUM(f.remaining_amount)
            FILTER (
                WHERE f.fund_type = 'PROMOTIONAL'
            ),
        0
    ) AS promotional_balance,

    COALESCE(
        SUM(f.remaining_amount)
            FILTER (
                WHERE f.fund_type = 'ADMIN_CREDIT'
            ),
        0
    ) AS admin_credit_balance

FROM cards c

LEFT JOIN card_fund_lots f
    ON f.card_id = c.card_id
   AND f.activation_id =
       c.current_activation_id

WHERE c.card_type = 'CUSTOMER'

GROUP BY
    c.card_id,
    c.current_activation_id;


-- =========================================================
-- 6. VALIDACIÓN DEL LEDGER EXISTENTE
--
-- Antes de permitir COMMIT verificamos que las tarjetas
-- migradas sigan coincidiendo con el ledger.
-- =========================================================

DO $$
DECLARE
    v_mismatches integer;
BEGIN

    SELECT
        COUNT(*)

    INTO
        v_mismatches

    FROM cards c

    JOIN customer_card_fund_balances b
        ON b.card_id = c.card_id

    WHERE c.card_type = 'CUSTOMER'

      AND c.current_activation_id IS NOT NULL

      AND c.balance <> b.total_balance;


    IF v_mismatches > 0 THEN

        RAISE EXCEPTION
            'FINANCIAL_LEDGER_BALANCE_MISMATCH: % CUSTOMER cards differ from ledger',
            v_mismatches;

    END IF;

END
$$;


COMMIT;