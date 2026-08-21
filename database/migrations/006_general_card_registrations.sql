BEGIN;

-- =========================================================
-- GENERALIZAR REGISTRO DE TARJETAS
-- =========================================================
--
-- Antes card_registrations pertenecía exclusivamente
-- a ADMIN.
--
-- Ahora una creación puede ser iniciada por:
--
-- ADMIN
-- RECHARGE / TAQUILLA
--
-- Conservamos admin_card_id temporalmente por compatibilidad
-- con las operaciones anteriores.
-- =========================================================


ALTER TABLE card_registrations
ALTER COLUMN admin_card_id
DROP NOT NULL;


ALTER TABLE card_registrations
ADD COLUMN IF NOT EXISTS actor_role text;


ALTER TABLE card_registrations
ADD COLUMN IF NOT EXISTS actor_card_id bigint;


ALTER TABLE card_registrations
ADD COLUMN IF NOT EXISTS recharge_point_id uuid;


-- =========================================================
-- FOREIGN KEYS
-- =========================================================

DO $$
BEGIN

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname =
            'card_registrations_actor_card_id_fkey'
    ) THEN

        ALTER TABLE card_registrations

        ADD CONSTRAINT
            card_registrations_actor_card_id_fkey

        FOREIGN KEY (actor_card_id)
        REFERENCES cards(card_id);

    END IF;

END
$$;


DO $$
BEGIN

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname =
            'card_registrations_recharge_point_id_fkey'
    ) THEN

        ALTER TABLE card_registrations

        ADD CONSTRAINT
            card_registrations_recharge_point_id_fkey

        FOREIGN KEY (recharge_point_id)
        REFERENCES recharge_points(id);

    END IF;

END
$$;


-- =========================================================
-- BACKFILL DE REGISTROS ANTERIORES
-- =========================================================
--
-- Todo lo creado antes de esta migración fue ADMIN.
-- =========================================================

UPDATE card_registrations

SET
    actor_role = 'ADMIN',
    actor_card_id = admin_card_id

WHERE actor_role IS NULL;


-- =========================================================
-- ACTOR OBLIGATORIO
-- =========================================================

ALTER TABLE card_registrations
ALTER COLUMN actor_role
SET NOT NULL;


ALTER TABLE card_registrations
ALTER COLUMN actor_card_id
SET NOT NULL;


-- =========================================================
-- CHECK DE ROL
-- =========================================================

DO $$
BEGIN

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname =
            'card_registrations_actor_role_check'
    ) THEN

        ALTER TABLE card_registrations

        ADD CONSTRAINT
            card_registrations_actor_role_check

        CHECK (
            actor_role IN (
                'ADMIN',
                'RECHARGE'
            )
        );

    END IF;

END
$$;


-- =========================================================
-- INDEXES
-- =========================================================

CREATE INDEX IF NOT EXISTS
    card_registrations_actor_card_id_idx
ON card_registrations(actor_card_id);


CREATE INDEX IF NOT EXISTS
    card_registrations_actor_role_idx
ON card_registrations(actor_role);


CREATE INDEX IF NOT EXISTS
    card_registrations_recharge_point_id_idx
ON card_registrations(recharge_point_id);


COMMIT;