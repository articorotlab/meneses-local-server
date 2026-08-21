BEGIN;

-- =========================================================
-- SISTEMA ADMIN
-- Espectaculares Meneses
-- =========================================================


-- =========================================================
-- 1. SECUENCIA PARA CARD ID
-- =========================================================
--
-- Hasta ahora:
--
-- 1 = CUSTOMER
-- 2 = GAME
-- 3 = RECHARGE
-- 4 = ADMIN bootstrap
--
-- Después ADMIN podrá pedir automáticamente:
--
-- 5, 6, 7, 8...
-- =========================================================

CREATE SEQUENCE IF NOT EXISTS card_id_seq;

SELECT setval(
    'card_id_seq',
    GREATEST(
        (
            SELECT COALESCE(MAX(card_id), 0)
            FROM cards
        ),
        1
    ),
    true
);

ALTER SEQUENCE card_id_seq
OWNED BY cards.card_id;

ALTER TABLE cards
ALTER COLUMN card_id
SET DEFAULT nextval('card_id_seq');


-- =========================================================
-- 2. SESIONES ADMIN
-- =========================================================

CREATE TABLE IF NOT EXISTS device_admin_sessions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    device_id uuid NOT NULL
        REFERENCES devices(id),

    admin_card_id bigint NOT NULL
        REFERENCES cards(card_id),

    started_at timestamptz NOT NULL DEFAULT now(),

    ended_at timestamptz,

    status text NOT NULL DEFAULT 'ACTIVE'
        CHECK (
            status IN (
                'ACTIVE',
                'CLOSED'
            )
        )
);


CREATE INDEX IF NOT EXISTS
    device_admin_sessions_device_id_idx
ON device_admin_sessions(device_id);


CREATE INDEX IF NOT EXISTS
    device_admin_sessions_admin_card_id_idx
ON device_admin_sessions(admin_card_id);


CREATE UNIQUE INDEX IF NOT EXISTS
    device_admin_sessions_one_active_per_device_idx
ON device_admin_sessions(device_id)
WHERE
    status = 'ACTIVE'
    AND ended_at IS NULL;


-- =========================================================
-- 3. REGISTRO SEGURO DE NUEVAS TARJETAS
-- =========================================================
--
-- Flujo:
--
-- ADMIN solicita creación
-- ↓
-- servidor reserva Card ID
-- ↓
-- PENDING
-- ↓
-- Android escribe NFC
-- ↓
-- Android verifica NFC
-- ↓
-- servidor confirma
-- ↓
-- se crea cards(...)
-- ↓
-- CONFIRMED
-- =========================================================

CREATE TABLE IF NOT EXISTS card_registrations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    idempotency_key text NOT NULL UNIQUE,

    device_id uuid NOT NULL
        REFERENCES devices(id),

    admin_card_id bigint NOT NULL
        REFERENCES cards(card_id),

    target_uid text NOT NULL,

    target_card_type text NOT NULL
        CHECK (
            target_card_type IN (
                'CUSTOMER',
                'GAME',
                'RECHARGE',
                'ADMIN'
            )
        ),

    reserved_card_id bigint NOT NULL UNIQUE,

    status text NOT NULL DEFAULT 'PENDING'
        CHECK (
            status IN (
                'PENDING',
                'CONFIRMED',
                'FAILED'
            )
        ),

    created_at timestamptz NOT NULL DEFAULT now(),

    confirmed_at timestamptz,

    failed_at timestamptz,

    failure_reason text
);


CREATE INDEX IF NOT EXISTS
    card_registrations_target_uid_idx
ON card_registrations(target_uid);


CREATE INDEX IF NOT EXISTS
    card_registrations_device_id_idx
ON card_registrations(device_id);


CREATE INDEX IF NOT EXISTS
    card_registrations_admin_card_id_idx
ON card_registrations(admin_card_id);


COMMIT;