-- ============================================================
-- 030_card_manual_review_quarantine.sql
-- Meneses Feria
--
-- Objetivo:
--   1) Mantener una cuarentena explícita en cards.
--   2) Guardar una fotografía forense cuando /transactions/reconcile
--      detecte MANUAL_REVIEW_REQUIRED.
--   3) No modificar automáticamente NFC, cards.balance ni Ledger V2.
--
-- IMPORTANTE:
--   Esta migración solo crea la estructura de datos.
--   El bloqueo efectivo de recargas/cobros/devoluciones se implementará
--   en el backend en el siguiente paso.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. CUARENTENA EN LA TARJETA
-- ------------------------------------------------------------

ALTER TABLE cards
    ADD COLUMN IF NOT EXISTS financial_hold boolean NOT NULL DEFAULT false;

ALTER TABLE cards
    ADD COLUMN IF NOT EXISTS financial_hold_reason text;

ALTER TABLE cards
    ADD COLUMN IF NOT EXISTS financial_hold_at timestamptz;

-- ------------------------------------------------------------
-- 2. SNAPSHOT FORENSE DE INCIDENTES
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS card_financial_incidents (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    card_id bigint NOT NULL
        REFERENCES cards(card_id),

    activation_id uuid,

    transaction_id uuid NOT NULL
        REFERENCES transactions(id),

    detected_at timestamptz NOT NULL DEFAULT now(),

    incident_type text NOT NULL DEFAULT 'MANUAL_REVIEW_REQUIRED',

    -- Quién/dispositivo observó físicamente la tarjeta.
    device_code text,

    -- Snapshot físico NFC.
    nfc_balance bigint NOT NULL,
    nfc_counter bigint NOT NULL,

    -- Snapshot de cards en PostgreSQL al momento del incidente.
    server_balance bigint NOT NULL,
    server_counter bigint NOT NULL,

    -- Snapshot de Financial Ledger V2 para la activación vigente.
    ledger_balance bigint NOT NULL,

    -- Estados que la transacción esperaba.
    expected_before_balance bigint NOT NULL,
    expected_before_counter bigint NOT NULL,
    expected_after_balance bigint NOT NULL,
    expected_after_counter bigint NOT NULL,

    -- Snapshot de la transacción para análisis posterior.
    transaction_type text,
    transaction_amount bigint,
    promotion_id uuid,
    transaction_status_before text,

    failure_reason text NOT NULL
        DEFAULT 'Reconciliación: estado físico inesperado.',

    CONSTRAINT card_financial_incidents_type_check
        CHECK (incident_type = 'MANUAL_REVIEW_REQUIRED'),

    CONSTRAINT card_financial_incidents_nfc_balance_check
        CHECK (nfc_balance >= 0),

    CONSTRAINT card_financial_incidents_nfc_counter_check
        CHECK (nfc_counter >= 0),

    CONSTRAINT card_financial_incidents_server_balance_check
        CHECK (server_balance >= 0),

    CONSTRAINT card_financial_incidents_server_counter_check
        CHECK (server_counter >= 0),

    CONSTRAINT card_financial_incidents_ledger_balance_check
        CHECK (ledger_balance >= 0),

    CONSTRAINT card_financial_incidents_before_balance_check
        CHECK (expected_before_balance >= 0),

    CONSTRAINT card_financial_incidents_before_counter_check
        CHECK (expected_before_counter >= 0),

    CONSTRAINT card_financial_incidents_after_balance_check
        CHECK (expected_after_balance >= 0),

    CONSTRAINT card_financial_incidents_after_counter_check
        CHECK (expected_after_counter >= 0),

    -- Una transacción problemática debe producir una sola fotografía
    -- forense. Reintentos de reconcile no deben duplicar evidencia.
    CONSTRAINT card_financial_incidents_transaction_unique
        UNIQUE (transaction_id)
);

CREATE INDEX IF NOT EXISTS card_financial_incidents_card_idx
    ON card_financial_incidents(card_id, detected_at DESC);

CREATE INDEX IF NOT EXISTS card_financial_incidents_detected_idx
    ON card_financial_incidents(detected_at DESC);

CREATE INDEX IF NOT EXISTS cards_financial_hold_idx
    ON cards(card_id)
    WHERE financial_hold = true;

-- ------------------------------------------------------------
-- 3. VALIDACIONES DE CONSISTENCIA DE LA CUARENTENA
-- ------------------------------------------------------------

ALTER TABLE cards
    DROP CONSTRAINT IF EXISTS cards_financial_hold_reason_check;

ALTER TABLE cards
    ADD CONSTRAINT cards_financial_hold_reason_check
    CHECK (
        (
            financial_hold = false
            AND financial_hold_reason IS NULL
            AND financial_hold_at IS NULL
        )
        OR
        (
            financial_hold = true
            AND financial_hold_reason IS NOT NULL
            AND financial_hold_at IS NOT NULL
        )
    );

COMMIT;
