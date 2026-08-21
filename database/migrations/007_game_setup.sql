BEGIN;

-- =========================================================
-- GAME SETUP
-- =========================================================
--
-- Permite crear juegos desde ADMIN antes de que exista
-- físicamente su tarjeta GAME.
--
-- Flujo:
--
-- PENDING_SETUP
--      ↓
-- tarjeta GAME confirmada
--      ↓
-- ACTIVE
-- =========================================================


-- =========================================================
-- GAMES STATUS
-- =========================================================
--
-- Si games.status ya existe con un CHECK que solamente
-- permite ACTIVE/INACTIVE, lo reemplazamos.
-- =========================================================

ALTER TABLE games
DROP CONSTRAINT IF EXISTS games_status_check;


ALTER TABLE games
ADD CONSTRAINT games_status_check
CHECK (
    status IN (
        'PENDING_SETUP',
        'ACTIVE',
        'INACTIVE'
    )
);


-- =========================================================
-- CARD REGISTRATIONS:
-- referencia opcional al juego que estamos configurando.
-- =========================================================

ALTER TABLE card_registrations
ADD COLUMN IF NOT EXISTS game_id uuid;


DO $$
BEGIN

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname =
            'card_registrations_game_id_fkey'
    ) THEN

        ALTER TABLE card_registrations

        ADD CONSTRAINT
            card_registrations_game_id_fkey

        FOREIGN KEY (game_id)
        REFERENCES games(id);

    END IF;

END
$$;


CREATE INDEX IF NOT EXISTS
    card_registrations_game_id_idx
ON card_registrations(game_id);


COMMIT;