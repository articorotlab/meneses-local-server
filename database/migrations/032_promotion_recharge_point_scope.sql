/*
 * ============================================================
 * 032_promotion_recharge_point_scope.sql
 * ============================================================
 *
 * OBJETIVO
 * -------
 *
 * Permitir que una promoción pueda aplicar:
 *
 *   ALL      = a todos los puntos de recarga.
 *   SELECTED = únicamente a puntos de recarga seleccionados.
 *
 * Esta migración es ADITIVA:
 *
 * - NO modifica balances.
 * - NO modifica counters.
 * - NO modifica transacciones históricas.
 * - NO modifica checkouts históricos.
 * - NO cambia montos de promociones existentes.
 *
 * Compatibilidad:
 *
 * Todas las promociones existentes quedan con scope='ALL',
 * conservando exactamente su comportamiento actual.
 *
 * La tabla promotion_recharge_points representa únicamente
 * las asignaciones de promociones con scope='SELECTED'.
 *
 * IMPORTANTE:
 *
 * La ausencia de filas en promotion_recharge_points NO
 * significa "todos". El alcance global se representa
 * explícitamente mediante promotions.scope='ALL'.
 * ============================================================
 */

BEGIN;


/*
 * ============================================================
 * 1. ALCANCE DE LA PROMOCIÓN
 * ============================================================
 */

ALTER TABLE promotions
ADD COLUMN IF NOT EXISTS scope text
NOT NULL
DEFAULT 'ALL';


/*
 * La constraint se agrega de forma segura para permitir
 * reejecutar la migración durante desarrollo.
 */

DO $$

BEGIN

    IF NOT EXISTS (

        SELECT 1
        FROM pg_constraint
        WHERE conname =
            'promotions_scope_check'

    ) THEN

        ALTER TABLE promotions

        ADD CONSTRAINT
            promotions_scope_check

        CHECK (
            scope IN (
                'ALL',
                'SELECTED'
            )
        );

    END IF;

END

$$;


/*
 * ============================================================
 * 2. RELACIÓN PROMOTION <-> RECHARGE POINT
 * ============================================================
 *
 * Una promoción SELECTED puede estar disponible en uno o
 * múltiples puntos de recarga.
 *
 * Un punto de recarga puede tener múltiples promociones.
 * ============================================================
 */

CREATE TABLE IF NOT EXISTS promotion_recharge_points (

    promotion_id uuid NOT NULL,

    recharge_point_id uuid NOT NULL,

    created_at timestamptz NOT NULL
        DEFAULT now(),

    CONSTRAINT promotion_recharge_points_pkey
        PRIMARY KEY (
            promotion_id,
            recharge_point_id
        ),

    CONSTRAINT promotion_recharge_points_promotion_fk
        FOREIGN KEY (
            promotion_id
        )
        REFERENCES promotions(id)
        ON DELETE CASCADE,

    CONSTRAINT promotion_recharge_points_recharge_point_fk
        FOREIGN KEY (
            recharge_point_id
        )
        REFERENCES recharge_points(id)
        ON DELETE RESTRICT
);


/*
 * ============================================================
 * 3. ÍNDICE POR PUNTO DE RECARGA
 * ============================================================
 *
 * La PK ya permite búsquedas eficientes comenzando por
 * promotion_id.
 *
 * Este índice soporta el caso operacional inverso:
 *
 *   "¿Qué promociones corresponden a esta TAQUILLA?"
 * ============================================================
 */

CREATE INDEX IF NOT EXISTS
promotion_recharge_points_recharge_point_idx

ON promotion_recharge_points(
    recharge_point_id
);


/*
 * ============================================================
 * 4. COMPATIBILIDAD CON PROMOCIONES EXISTENTES
 * ============================================================
 *
 * El DEFAULT 'ALL' ya cubre las filas existentes al agregar
 * la columna.
 *
 * Dejamos este UPDATE explícito como defensa para bases de
 * desarrollo que pudieran haber pasado por una versión
 * intermedia de esta migración.
 * ============================================================
 */

UPDATE promotions
SET scope = 'ALL'
WHERE scope IS NULL;


COMMIT;
