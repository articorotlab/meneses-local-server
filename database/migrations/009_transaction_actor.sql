BEGIN;

-- =========================================================
-- TRANSACTION ACTOR
-- =========================================================
--
-- Permite saber qué tipo de operador originó cada
-- transacción:
--
-- ADMIN
-- GAME
-- RECHARGE
--
-- Esto será fundamental para:
--
-- - Recargas desde ADMIN
-- - Ajustes administrativos
-- - Caja
-- - Reportes
-- - Auditoría
-- - Dashboard web futuro
-- =========================================================


ALTER TABLE transactions
ADD COLUMN IF NOT EXISTS actor_role text;


ALTER TABLE transactions
ADD COLUMN IF NOT EXISTS actor_card_id bigint;


-- =========================================================
-- ACTOR ROLE
-- =========================================================

ALTER TABLE transactions
DROP CONSTRAINT IF EXISTS transactions_actor_role_check;


ALTER TABLE transactions
ADD CONSTRAINT transactions_actor_role_check
CHECK (
    actor_role IS NULL
    OR actor_role IN (
        'ADMIN',
        'GAME',
        'RECHARGE'
    )
);


-- =========================================================
-- ACTOR CARD
-- =========================================================

DO $$
BEGIN

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname =
            'transactions_actor_card_id_fkey'
    ) THEN

        ALTER TABLE transactions

        ADD CONSTRAINT
            transactions_actor_card_id_fkey

        FOREIGN KEY (
            actor_card_id
        )

        REFERENCES cards(
            card_id
        );

    END IF;

END $$;


-- =========================================================
-- INDEXES
-- =========================================================

CREATE INDEX IF NOT EXISTS
    transactions_actor_role_idx

ON transactions(
    actor_role
);


CREATE INDEX IF NOT EXISTS
    transactions_actor_card_id_idx

ON transactions(
    actor_card_id
);


COMMIT;