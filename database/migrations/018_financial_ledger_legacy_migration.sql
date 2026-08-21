BEGIN;

-- =========================================================
-- 018_financial_ledger_legacy_migration.sql
--
-- Migra las CUSTOMER existentes al nuevo modelo.
--
-- Reglas:
-- - crea activación #1 para cada CUSTOMER existente;
-- - preserva exactamente cards.balance;
-- - crea un único fondo LEGACY equivalente al saldo actual;
-- - enlaza transactions históricas a la activación creada;
-- - marca si conocemos o no el costo real de activación.
-- =========================================================


-- =========================================================
-- 1. SABER SI EL FEE HISTÓRICO ES CONOCIDO
-- =========================================================

ALTER TABLE customer_card_activations
ADD COLUMN activation_fee_known boolean
NOT NULL
DEFAULT true;


-- =========================================================
-- 2. CREAR ACTIVACIONES INICIALES
-- =========================================================

INSERT INTO customer_card_activations (
    card_id,
    activation_number,
    activation_fee,
    activation_fee_known,
    status,
    activated_by_role,
    activated_by_card_id,
    recharge_point_id,
    started_at
)
SELECT
    c.card_id,
    1,

    COALESCE(
        creation.amount,
        0
    ) AS activation_fee,

    CASE
        WHEN creation.id IS NOT NULL
            THEN true
        ELSE false
    END AS activation_fee_known,

    'ACTIVE',

    CASE
        WHEN creation.id IS NOT NULL
            THEN creation.actor_role
        ELSE 'MIGRATION'
    END,

    CASE
        WHEN creation.id IS NOT NULL
            THEN creation.actor_card_id
        ELSE NULL
    END,

    CASE
        WHEN creation.id IS NOT NULL
            THEN creation.recharge_point_id
        ELSE NULL
    END,

    COALESCE(
        creation.created_at,
        c.created_at
    )

FROM cards c

LEFT JOIN LATERAL (
    SELECT
        t.id,
        t.amount,
        t.actor_role,
        t.actor_card_id,
        t.recharge_point_id,
        t.created_at

    FROM transactions t

    WHERE t.card_id = c.card_id
      AND t.transaction_type = 'CARD_CREATED'
      AND t.card_write_status = 'CONFIRMED'

    ORDER BY t.created_at ASC

    LIMIT 1
) creation
ON true

WHERE c.card_type = 'CUSTOMER'

AND NOT EXISTS (
    SELECT 1
    FROM customer_card_activations a
    WHERE a.card_id = c.card_id
      AND a.status = 'ACTIVE'
);


-- =========================================================
-- 3. ENLAZAR cards.current_activation_id
-- =========================================================

UPDATE cards c

SET current_activation_id = a.id

FROM customer_card_activations a

WHERE c.card_id = a.card_id

  AND c.card_type = 'CUSTOMER'

  AND a.status = 'ACTIVE'

  AND c.current_activation_id IS NULL;


-- =========================================================
-- 4. ENLAZAR TRANSACCIONES HISTÓRICAS
--
-- Como todavía no existían ciclos de devolución,
-- todas las transacciones CUSTOMER históricas conocidas
-- pertenecen a esta activación inicial.
-- =========================================================

UPDATE transactions t

SET activation_id = c.current_activation_id

FROM cards c

WHERE t.card_id = c.card_id

  AND c.card_type = 'CUSTOMER'

  AND c.current_activation_id IS NOT NULL

  AND t.activation_id IS NULL;


-- =========================================================
-- 5. CREAR FONDO LEGACY PARA SALDO ACTUAL
--
-- No intentamos reconstruir la composición histórica.
-- El saldo actual se preserva exactamente.
-- =========================================================

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
SELECT
    c.card_id,
    c.current_activation_id,
    'LEGACY',
    c.balance,
    c.balance,
    NULL,
    NULL,
    now()

FROM cards c

WHERE c.card_type = 'CUSTOMER'

  AND c.current_activation_id IS NOT NULL

  AND c.balance > 0

  AND NOT EXISTS (
    SELECT 1
    FROM card_fund_lots f
    WHERE f.card_id = c.card_id
      AND f.activation_id = c.current_activation_id
  );


-- =========================================================
-- 6. VALIDACIONES INTERNAS
-- =========================================================

DO $$
DECLARE
    v_card_balance_total bigint;
    v_ledger_balance_total bigint;
    v_customer_count integer;
    v_activation_count integer;
BEGIN

    SELECT
        COALESCE(
            SUM(balance),
            0
        )
    INTO v_card_balance_total
    FROM cards
    WHERE card_type = 'CUSTOMER';


    SELECT
        COALESCE(
            SUM(remaining_amount),
            0
        )
    INTO v_ledger_balance_total
    FROM card_fund_lots;


    IF v_card_balance_total <> v_ledger_balance_total THEN

        RAISE EXCEPTION
            'LEGACY_BALANCE_MISMATCH: cards=% ledger=%',
            v_card_balance_total,
            v_ledger_balance_total;

    END IF;


    SELECT COUNT(*)
    INTO v_customer_count
    FROM cards
    WHERE card_type = 'CUSTOMER';


    SELECT COUNT(*)
    INTO v_activation_count
    FROM customer_card_activations
    WHERE status = 'ACTIVE';


    IF v_customer_count <> v_activation_count THEN

        RAISE EXCEPTION
            'LEGACY_ACTIVATION_COUNT_MISMATCH: cards=% activations=%',
            v_customer_count,
            v_activation_count;

    END IF;

END
$$;


COMMIT;