BEGIN;

-- =========================================================
-- RECHARGE POINT SETUP
-- =========================================================
--
-- Permite crear una taquilla desde ADMIN antes de que
-- exista físicamente su tarjeta RECHARGE.
--
-- Flujo:
--
-- PENDING_SETUP
--      ↓
-- tarjeta RECHARGE confirmada
--      ↓
-- ACTIVE
-- =========================================================


-- =========================================================
-- STATUS DE RECHARGE POINTS
-- =========================================================

ALTER TABLE recharge_points
DROP CONSTRAINT IF EXISTS recharge_points_status_check;


ALTER TABLE recharge_points
ADD CONSTRAINT recharge_points_status_check
CHECK (
    status IN (
        'PENDING_SETUP',
        'ACTIVE',
        'INACTIVE'
    )
);


-- =========================================================
-- UNA TARJETA RECHARGE ACTIVA POR TAQUILLA
-- =========================================================
--
-- Nuestro modelo actual considera:
--
-- 1 taquilla = 1 credencial RECHARGE activa.
--
-- En el futuro, si el cliente necesitara tarjetas
-- duplicadas para una misma taquilla, podremos cambiar
-- esta regla.
-- =========================================================

CREATE UNIQUE INDEX IF NOT EXISTS
    recharge_cards_one_active_per_point_idx
ON recharge_cards(recharge_point_id)
WHERE status = 'ACTIVE';


-- =========================================================
-- UNA CONFIGURACIÓN PENDIENTE POR TAQUILLA
-- =========================================================

CREATE UNIQUE INDEX IF NOT EXISTS
    card_registrations_one_pending_recharge_point_idx
ON card_registrations(recharge_point_id)
WHERE
    target_card_type = 'RECHARGE'
    AND status = 'PENDING';


COMMIT;