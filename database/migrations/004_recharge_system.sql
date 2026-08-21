BEGIN;

-- =========================================================
-- SISTEMA DE PUNTOS DE RECARGA
-- Espectaculares Meneses
-- =========================================================


-- =========================================================
-- 1. PUNTOS DE RECARGA
-- =========================================================

CREATE TABLE IF NOT EXISTS recharge_points (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    recharge_code text NOT NULL UNIQUE,

    name text NOT NULL,

    status text NOT NULL DEFAULT 'ACTIVE',

    created_at timestamptz NOT NULL DEFAULT now(),

    updated_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT recharge_points_status_check
        CHECK (
            status IN (
                'ACTIVE',
                'INACTIVE'
            )
        )
);


-- =========================================================
-- 2. TARJETAS ASIGNADAS A PUNTOS DE RECARGA
-- =========================================================

CREATE TABLE IF NOT EXISTS recharge_cards (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    card_id bigint NOT NULL UNIQUE,

    recharge_point_id uuid NOT NULL,

    status text NOT NULL DEFAULT 'ACTIVE',

    created_at timestamptz NOT NULL DEFAULT now(),

    updated_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT recharge_cards_card_id_fkey
        FOREIGN KEY (card_id)
        REFERENCES cards(card_id),

    CONSTRAINT recharge_cards_recharge_point_id_fkey
        FOREIGN KEY (recharge_point_id)
        REFERENCES recharge_points(id),

    CONSTRAINT recharge_cards_status_check
        CHECK (
            status IN (
                'ACTIVE',
                'BLOCKED',
                'INACTIVE'
            )
        )
);


CREATE INDEX IF NOT EXISTS recharge_cards_recharge_point_id_idx
    ON recharge_cards(recharge_point_id);


-- =========================================================
-- 3. SESIONES DE PUNTOS DE RECARGA EN DISPOSITIVOS
-- =========================================================

CREATE TABLE IF NOT EXISTS device_recharge_sessions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    device_id uuid NOT NULL,

    recharge_point_id uuid NOT NULL,

    opened_by_card_id bigint,

    started_at timestamptz NOT NULL DEFAULT now(),

    ended_at timestamptz,

    status text NOT NULL DEFAULT 'ACTIVE',

    CONSTRAINT device_recharge_sessions_device_id_fkey
        FOREIGN KEY (device_id)
        REFERENCES devices(id),

    CONSTRAINT device_recharge_sessions_recharge_point_id_fkey
        FOREIGN KEY (recharge_point_id)
        REFERENCES recharge_points(id),

    CONSTRAINT device_recharge_sessions_opened_by_card_id_fkey
        FOREIGN KEY (opened_by_card_id)
        REFERENCES cards(card_id),

    CONSTRAINT device_recharge_sessions_status_check
        CHECK (
            status IN (
                'ACTIVE',
                'CLOSED'
            )
        )
);


CREATE INDEX IF NOT EXISTS device_recharge_sessions_device_id_idx
    ON device_recharge_sessions(device_id);


CREATE INDEX IF NOT EXISTS device_recharge_sessions_recharge_point_id_idx
    ON device_recharge_sessions(recharge_point_id);


CREATE INDEX IF NOT EXISTS device_recharge_sessions_opened_by_card_id_idx
    ON device_recharge_sessions(opened_by_card_id);


CREATE UNIQUE INDEX IF NOT EXISTS
    device_recharge_sessions_one_active_per_device_idx

    ON device_recharge_sessions(device_id)

    WHERE
        status = 'ACTIVE'
        AND ended_at IS NULL;


-- =========================================================
-- 4. RELACIONAR TRANSACCIONES CON PUNTO DE RECARGA
-- =========================================================

ALTER TABLE transactions
ADD COLUMN IF NOT EXISTS recharge_point_id uuid;


DO $$
BEGIN

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname =
            'transactions_recharge_point_id_fkey'
    ) THEN

        ALTER TABLE transactions

        ADD CONSTRAINT
            transactions_recharge_point_id_fkey

        FOREIGN KEY (recharge_point_id)

        REFERENCES recharge_points(id);

    END IF;

END $$;


CREATE INDEX IF NOT EXISTS
    transactions_recharge_point_id_idx

    ON transactions(recharge_point_id);


COMMIT;