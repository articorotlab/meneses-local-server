BEGIN;

-- =========================================================
-- 022_promotions_foundation.sql
--
-- Financial Ledger V2 - Promotions Foundation
--
-- IMPORTANTE:
--
-- La tabla promotions YA existe desde la foundation
-- financiera anterior.
--
-- Esta migración:
--
--   - conserva la tabla promotions existente;
--   - agrega total_credit_amount;
--   - crea transaction_credit_components;
--   - agrega promotion_id a transactions;
--   - crea una vista de promociones activas.
--
-- Ejemplo:
--
-- Promoción:
--
--   cash_amount          = 500
--   promotional_amount   = 200
--   total_credit_amount  = 700
--
-- Una futura transacción podrá generar:
--
--   CASH          500
--   PROMOTIONAL   200
--
-- sin perder la trazabilidad de la promoción.
-- =========================================================


-- =========================================================
-- 1. TOTAL ACREDITADO DE LA PROMOCIÓN
-- =========================================================

ALTER TABLE promotions
ADD COLUMN IF NOT EXISTS total_credit_amount bigint
GENERATED ALWAYS AS (
    cash_amount
    +
    promotional_amount
) STORED;


-- =========================================================
-- 2. COMPONENTES DE CRÉDITO
--
-- Permite que una sola transacción CREDIT genere
-- múltiples tipos de saldo.
--
-- Ejemplos:
--
-- Recarga normal:
--
--   CASH 100
--
-- Recarga ADMIN:
--
--   ADMIN_CREDIT 100
--
-- Promoción:
--
--   CASH          500
--   PROMOTIONAL   200
-- =========================================================

CREATE TABLE IF NOT EXISTS transaction_credit_components (
    id uuid PRIMARY KEY
        DEFAULT gen_random_uuid(),

    transaction_id uuid NOT NULL
        REFERENCES transactions(id)
        ON DELETE CASCADE,

    fund_type text NOT NULL,

    amount bigint NOT NULL,

    promotion_id uuid
        REFERENCES promotions(id),

    created_at timestamptz NOT NULL
        DEFAULT now(),

    CONSTRAINT transaction_credit_components_type_check
        CHECK (
            fund_type IN (
                'CASH',
                'PROMOTIONAL',
                'ADMIN_CREDIT'
            )
        ),

    CONSTRAINT transaction_credit_components_amount_check
        CHECK (
            amount > 0
        ),

    CONSTRAINT transaction_credit_components_unique_type
        UNIQUE (
            transaction_id,
            fund_type
        ),

    CONSTRAINT transaction_credit_components_promotion_check
        CHECK (
            (
                fund_type = 'PROMOTIONAL'
                AND promotion_id IS NOT NULL
            )
            OR
            (
                fund_type <> 'PROMOTIONAL'
            )
        )
);


-- =========================================================
-- 3. ÍNDICES DE COMPONENTES
-- =========================================================

CREATE INDEX IF NOT EXISTS
transaction_credit_components_transaction_idx

ON transaction_credit_components(
    transaction_id
);


CREATE INDEX IF NOT EXISTS
transaction_credit_components_promotion_idx

ON transaction_credit_components(
    promotion_id
)

WHERE promotion_id IS NOT NULL;


-- =========================================================
-- 4. PROMOTION ID EN TRANSACTIONS
--
-- Esto permite identificar directamente qué promoción
-- originó una determinada recarga.
-- =========================================================

ALTER TABLE transactions
ADD COLUMN IF NOT EXISTS promotion_id uuid;


-- =========================================================
-- 5. FOREIGN KEY DE TRANSACTIONS -> PROMOTIONS
--
-- Se agrega de forma segura solamente si todavía
-- no existe.
-- =========================================================

DO $$

BEGIN

    IF NOT EXISTS (

        SELECT 1

        FROM pg_constraint

        WHERE conname =
            'transactions_promotion_id_fkey'

    ) THEN

        ALTER TABLE transactions

        ADD CONSTRAINT
            transactions_promotion_id_fkey

        FOREIGN KEY (
            promotion_id
        )

        REFERENCES promotions(id);

    END IF;

END

$$;


-- =========================================================
-- 6. ÍNDICE DE PROMOTION_ID
-- =========================================================

CREATE INDEX IF NOT EXISTS
transactions_promotion_id_idx

ON transactions(
    promotion_id
)

WHERE promotion_id IS NOT NULL;


-- =========================================================
-- 7. VISTA DE PROMOCIONES ACTIVAS
--
-- Conservamos el modelo existente:
--
-- active = true / false
--
-- en lugar de introducir otro campo status.
-- =========================================================

CREATE OR REPLACE VIEW active_promotions AS

SELECT
    id,
    name,
    cash_amount,
    promotional_amount,
    total_credit_amount,
    active,
    created_by_admin_card_id,
    created_at,
    updated_at

FROM promotions

WHERE active = true;


COMMIT;