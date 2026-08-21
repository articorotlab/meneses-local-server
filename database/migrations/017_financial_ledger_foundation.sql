BEGIN;

-- =========================================================
-- 017_financial_ledger_foundation.sql
--
-- Financial Ledger V2 - Foundation
--
-- Esta migración es deliberadamente ADITIVA.
-- No cambia todavía el comportamiento actual de:
--   - recargas
--   - cobros
--   - NFC
--   - reconciliación
--
-- Prepara:
--   1. ciclos/activaciones de tarjetas CUSTOMER
--   2. promociones
--   3. lotes de fondos
--   4. desglose de consumo por transacción
--   5. auditoría de devoluciones/reset
--
-- LEGACY se utiliza únicamente para representar saldo
-- existente antes de Financial Ledger V2 cuya procedencia
-- exacta no puede reconstruirse con certeza.
-- =========================================================


-- =========================================================
-- 1. CUSTOMER CARD ACTIVATIONS
-- =========================================================

CREATE TABLE customer_card_activations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    card_id bigint NOT NULL
        REFERENCES cards(card_id),

    activation_number integer NOT NULL,

    activation_fee bigint NOT NULL,

    status text NOT NULL DEFAULT 'ACTIVE',

    activated_by_role text,
    activated_by_card_id bigint
        REFERENCES cards(card_id),

    recharge_point_id uuid
        REFERENCES recharge_points(id),

    started_at timestamptz NOT NULL DEFAULT now(),
    ended_at timestamptz,

    created_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT customer_card_activations_number_check
        CHECK (activation_number > 0),

    CONSTRAINT customer_card_activations_fee_check
        CHECK (activation_fee >= 0),

    CONSTRAINT customer_card_activations_status_check
        CHECK (status IN ('ACTIVE', 'RETURNED', 'CLOSED')),

    CONSTRAINT customer_card_activations_actor_role_check
        CHECK (
            activated_by_role IS NULL
            OR activated_by_role IN ('ADMIN', 'RECHARGE', 'MIGRATION')
        ),

    CONSTRAINT customer_card_activations_card_number_key
        UNIQUE (card_id, activation_number)
);

CREATE UNIQUE INDEX customer_card_activations_one_active_per_card_idx
    ON customer_card_activations(card_id)
    WHERE status = 'ACTIVE';

CREATE INDEX customer_card_activations_card_id_idx
    ON customer_card_activations(card_id);

CREATE INDEX customer_card_activations_started_at_idx
    ON customer_card_activations(started_at DESC);


-- =========================================================
-- 2. PROMOTIONS
-- =========================================================

CREATE TABLE promotions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    name text NOT NULL,

    cash_amount bigint NOT NULL,
    promotional_amount bigint NOT NULL,

    active boolean NOT NULL DEFAULT true,

    created_by_admin_card_id bigint
        REFERENCES cards(card_id),

    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT promotions_name_check
        CHECK (length(trim(name)) > 0),

    CONSTRAINT promotions_cash_amount_check
        CHECK (cash_amount > 0),

    CONSTRAINT promotions_promotional_amount_check
        CHECK (promotional_amount >= 0)
);

CREATE INDEX promotions_active_idx
    ON promotions(active);

CREATE INDEX promotions_created_at_idx
    ON promotions(created_at DESC);


-- =========================================================
-- 3. CARD FUND LOTS
--
-- Cada entrada de fondos genera uno o más lotes.
--
-- Ejemplo promoción:
--   CASH          +500
--   PROMOTIONAL   +200
--
-- Ejemplo ADMIN:
--   ADMIN_CREDIT  +100
--
-- LEGACY:
--   únicamente para migración inicial.
-- =========================================================

CREATE TABLE card_fund_lots (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    card_id bigint NOT NULL
        REFERENCES cards(card_id),

    activation_id uuid NOT NULL
        REFERENCES customer_card_activations(id),

    fund_type text NOT NULL,

    original_amount bigint NOT NULL,
    remaining_amount bigint NOT NULL,

    source_transaction_id uuid
        REFERENCES transactions(id),

    promotion_id uuid
        REFERENCES promotions(id),

    created_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT card_fund_lots_type_check
        CHECK (
            fund_type IN (
                'CASH',
                'PROMOTIONAL',
                'ADMIN_CREDIT',
                'LEGACY'
            )
        ),

    CONSTRAINT card_fund_lots_original_amount_check
        CHECK (original_amount >= 0),

    CONSTRAINT card_fund_lots_remaining_amount_check
        CHECK (
            remaining_amount >= 0
            AND remaining_amount <= original_amount
        )
);

CREATE INDEX card_fund_lots_card_activation_idx
    ON card_fund_lots(card_id, activation_id);

CREATE INDEX card_fund_lots_available_idx
    ON card_fund_lots(card_id, activation_id, fund_type, created_at)
    WHERE remaining_amount > 0;

CREATE INDEX card_fund_lots_source_transaction_idx
    ON card_fund_lots(source_transaction_id);

CREATE INDEX card_fund_lots_promotion_idx
    ON card_fund_lots(promotion_id);


-- =========================================================
-- 4. TRANSACTION FUND ALLOCATIONS
--
-- Registra exactamente qué tipo de dinero consumió
-- una transacción CHARGE.
--
-- Ejemplo:
-- juego cobra $100:
--
-- CASH          $60
-- PROMOTIONAL   $40
-- =========================================================

CREATE TABLE transaction_fund_allocations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    transaction_id uuid NOT NULL
        REFERENCES transactions(id),

    fund_lot_id uuid NOT NULL
        REFERENCES card_fund_lots(id),

    fund_type text NOT NULL,

    amount bigint NOT NULL,

    created_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT transaction_fund_allocations_type_check
        CHECK (
            fund_type IN (
                'CASH',
                'PROMOTIONAL',
                'ADMIN_CREDIT',
                'LEGACY'
            )
        ),

    CONSTRAINT transaction_fund_allocations_amount_check
        CHECK (amount > 0),

    CONSTRAINT transaction_fund_allocations_unique_lot
        UNIQUE (transaction_id, fund_lot_id)
);

CREATE INDEX transaction_fund_allocations_transaction_idx
    ON transaction_fund_allocations(transaction_id);

CREATE INDEX transaction_fund_allocations_type_idx
    ON transaction_fund_allocations(fund_type);


-- =========================================================
-- 5. CUSTOMER CARD RETURNS
--
-- Auditoría permanente de cada devolución/reset.
--
-- refund_amount:
--   exactamente lo pagado por el cliente por ESA activación.
--
-- discarded_*:
--   fondos que todavía estaban disponibles cuando la tarjeta
--   fue devuelta.
-- =========================================================

CREATE TABLE customer_card_returns (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    card_id bigint NOT NULL
        REFERENCES cards(card_id),

    activation_id uuid NOT NULL
        REFERENCES customer_card_activations(id),

    returned_by_role text NOT NULL,

    returned_by_card_id bigint
        REFERENCES cards(card_id),

    recharge_point_id uuid
        REFERENCES recharge_points(id),

    activation_fee bigint NOT NULL,
    refund_amount bigint NOT NULL,

    discarded_cash bigint NOT NULL DEFAULT 0,
    discarded_promotional bigint NOT NULL DEFAULT 0,
    discarded_admin_credit bigint NOT NULL DEFAULT 0,
    discarded_legacy bigint NOT NULL DEFAULT 0,

    returned_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT customer_card_returns_role_check
        CHECK (returned_by_role IN ('ADMIN', 'RECHARGE')),

    CONSTRAINT customer_card_returns_activation_fee_check
        CHECK (activation_fee >= 0),

    CONSTRAINT customer_card_returns_refund_check
        CHECK (refund_amount >= 0),

    CONSTRAINT customer_card_returns_discarded_cash_check
        CHECK (discarded_cash >= 0),

    CONSTRAINT customer_card_returns_discarded_promotional_check
        CHECK (discarded_promotional >= 0),

    CONSTRAINT customer_card_returns_discarded_admin_check
        CHECK (discarded_admin_credit >= 0),

    CONSTRAINT customer_card_returns_discarded_legacy_check
        CHECK (discarded_legacy >= 0),

    CONSTRAINT customer_card_returns_activation_unique
        UNIQUE (activation_id)
);

CREATE INDEX customer_card_returns_card_id_idx
    ON customer_card_returns(card_id);

CREATE INDEX customer_card_returns_recharge_point_idx
    ON customer_card_returns(recharge_point_id);

CREATE INDEX customer_card_returns_returned_at_idx
    ON customer_card_returns(returned_at DESC);


-- =========================================================
-- 6. LINK TRANSACTIONS TO ACTIVATION
--
-- Nullable durante la transición para no romper las
-- transacciones históricas.
-- =========================================================

ALTER TABLE transactions
    ADD COLUMN activation_id uuid
        REFERENCES customer_card_activations(id);

CREATE INDEX transactions_activation_id_idx
    ON transactions(activation_id);


-- =========================================================
-- 7. LINK CURRENT CUSTOMER CARD TO ACTIVE ACTIVATION
--
-- Nullable durante migración.
-- =========================================================

ALTER TABLE cards
    ADD COLUMN current_activation_id uuid
        REFERENCES customer_card_activations(id);

CREATE INDEX cards_current_activation_id_idx
    ON cards(current_activation_id);


COMMIT;