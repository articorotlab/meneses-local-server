BEGIN;

-- =========================================================
-- 021_financial_debit_engine.sql
--
-- Financial Ledger V2 - DEBIT engine
--
-- AUTHORIZE:
--   financial_reserve_debit()
--
-- CONFIRM / RECONCILE AFTER:
--   financial_commit_debit()
--
-- FAIL / RECONCILE BEFORE:
--   financial_release_debit()
--
-- Prioridad:
--
--   1. LEGACY
--   2. CASH
--   3. PROMOTIONAL
--   4. ADMIN_CREDIT
-- =========================================================


-- =========================================================
-- 1. RESERVAR FONDOS
-- =========================================================

CREATE OR REPLACE FUNCTION
financial_reserve_debit(
    p_transaction_id uuid
)
RETURNS void

LANGUAGE plpgsql

AS $$

DECLARE

    v_transaction
        transactions%ROWTYPE;

    v_lot record;

    v_remaining bigint;

    v_available bigint;

    v_take bigint;

BEGIN

    /*
     * Bloquear transacción.
     */

    SELECT *
    INTO v_transaction

    FROM transactions

    WHERE id =
        p_transaction_id

    FOR UPDATE;


    IF NOT FOUND THEN

        RAISE EXCEPTION
            'FINANCIAL_TRANSACTION_NOT_FOUND: %',
            p_transaction_id;

    END IF;


    /*
     * Legacy / transacción no migrada.
     */

    IF v_transaction.ledger_action IS NULL THEN
        RETURN;
    END IF;


    IF v_transaction.ledger_action <> 'DEBIT' THEN
        RETURN;
    END IF;


    IF v_transaction.activation_id IS NULL THEN

        RAISE EXCEPTION
            'FINANCIAL_ACTIVATION_REQUIRED: transaction=%',
            p_transaction_id;

    END IF;


    /*
     * Idempotencia:
     * si ya existen reservas abiertas, no duplicarlas.
     */

    IF EXISTS (
        SELECT 1

        FROM transaction_fund_reservations

        WHERE transaction_id =
            p_transaction_id

          AND status =
            'RESERVED'
    ) THEN

        RETURN;

    END IF;


    v_remaining :=
        v_transaction.amount;


    /*
     * Seleccionar lotes en orden:
     *
     * LEGACY
     * CASH
     * PROMOTIONAL
     * ADMIN_CREDIT
     *
     * y FIFO dentro de cada tipo.
     */

    FOR v_lot IN

        SELECT
            f.id,
            f.fund_type,
            f.remaining_amount,
            f.created_at

        FROM card_fund_lots f

        WHERE f.card_id =
            v_transaction.card_id

          AND f.activation_id =
            v_transaction.activation_id

          AND f.remaining_amount > 0

        ORDER BY
            financial_fund_priority(
                f.fund_type
            ),
            f.created_at,
            f.id

        FOR UPDATE

    LOOP

        EXIT WHEN
            v_remaining <= 0;


        /*
         * Restar reservas abiertas de otras
         * transacciones que usan el mismo lote.
         */

        SELECT
            GREATEST(
                v_lot.remaining_amount
                -
                COALESCE(
                    SUM(r.amount)
                        FILTER (
                            WHERE r.status = 'RESERVED'
                        ),
                    0
                ),
                0
            )

        INTO
            v_available

        FROM transaction_fund_reservations r

        WHERE r.fund_lot_id =
            v_lot.id;


        /*
         * Si no existe ninguna reserva, SUM sobre cero filas
         * puede impedir devolver fila útil.
         *
         * Recalculamos explícitamente en ese caso.
         */

        IF v_available IS NULL THEN

            v_available :=
                v_lot.remaining_amount;

        END IF;


        IF v_available <= 0 THEN
            CONTINUE;
        END IF;


        v_take :=
            LEAST(
                v_remaining,
                v_available
            );


        INSERT INTO transaction_fund_reservations (
            transaction_id,
            fund_lot_id,
            fund_type,
            amount,
            status
        )
        VALUES (
            p_transaction_id,
            v_lot.id,
            v_lot.fund_type,
            v_take,
            'RESERVED'
        );


        v_remaining :=
            v_remaining
            -
            v_take;

    END LOOP;


    /*
     * No alcanzaron fondos clasificados.
     *
     * Borramos las reservas de esta operación y abortamos.
     */

    IF v_remaining > 0 THEN

        DELETE FROM transaction_fund_reservations

        WHERE transaction_id =
            p_transaction_id

          AND status =
            'RESERVED';


        RAISE EXCEPTION
            'FINANCIAL_INSUFFICIENT_FUNDS: transaction=% missing=%',
            p_transaction_id,
            v_remaining;

    END IF;

END;

$$;


-- =========================================================
-- 2. COMMIT DEL DÉBITO
-- =========================================================

CREATE OR REPLACE FUNCTION
financial_commit_debit(
    p_transaction_id uuid
)
RETURNS void

LANGUAGE plpgsql

AS $$

DECLARE

    v_transaction
        transactions%ROWTYPE;

    v_reservation record;

BEGIN

    SELECT *
    INTO v_transaction

    FROM transactions

    WHERE id =
        p_transaction_id

    FOR UPDATE;


    IF NOT FOUND THEN

        RAISE EXCEPTION
            'FINANCIAL_TRANSACTION_NOT_FOUND: %',
            p_transaction_id;

    END IF;


    IF v_transaction.ledger_action IS NULL THEN
        RETURN;
    END IF;


    IF v_transaction.ledger_action <> 'DEBIT' THEN
        RETURN;
    END IF;


    /*
     * Si ya hay allocations, la operación ya fue
     * materializada.
     */

    IF EXISTS (
        SELECT 1

        FROM transaction_fund_allocations

        WHERE transaction_id =
            p_transaction_id
    ) THEN

        RETURN;

    END IF;


    /*
     * Exigir reservas.
     */

    IF NOT EXISTS (
        SELECT 1

        FROM transaction_fund_reservations

        WHERE transaction_id =
            p_transaction_id

          AND status =
            'RESERVED'
    ) THEN

        RAISE EXCEPTION
            'FINANCIAL_DEBIT_RESERVATION_REQUIRED: transaction=%',
            p_transaction_id;

    END IF;


    /*
     * Consumir cada lote reservado.
     */

    FOR v_reservation IN

        SELECT
            r.id,
            r.fund_lot_id,
            r.fund_type,
            r.amount

        FROM transaction_fund_reservations r

        WHERE r.transaction_id =
            p_transaction_id

          AND r.status =
            'RESERVED'

        ORDER BY
            financial_fund_priority(
                r.fund_type
            ),
            r.created_at,
            r.id

        FOR UPDATE

    LOOP

        /*
         * Bloqueo / decremento seguro.
         */

        UPDATE card_fund_lots

        SET
            remaining_amount =
                remaining_amount
                -
                v_reservation.amount

        WHERE id =
            v_reservation.fund_lot_id

          AND remaining_amount >=
              v_reservation.amount;


        IF NOT FOUND THEN

            RAISE EXCEPTION
                'FINANCIAL_RESERVED_FUNDS_NOT_AVAILABLE: transaction=% lot=%',
                p_transaction_id,
                v_reservation.fund_lot_id;

        END IF;


        /*
         * Auditoría definitiva.
         */

        INSERT INTO transaction_fund_allocations (
            transaction_id,
            fund_lot_id,
            fund_type,
            amount
        )
        VALUES (
            p_transaction_id,
            v_reservation.fund_lot_id,
            v_reservation.fund_type,
            v_reservation.amount
        );


        /*
         * Resolver reserva.
         */

        UPDATE transaction_fund_reservations

        SET
            status =
                'COMMITTED',

            resolved_at =
                now()

        WHERE id =
            v_reservation.id;

    END LOOP;

END;

$$;


-- =========================================================
-- 3. LIBERAR RESERVAS
-- =========================================================

CREATE OR REPLACE FUNCTION
financial_release_debit(
    p_transaction_id uuid
)
RETURNS void

LANGUAGE plpgsql

AS $$

BEGIN

    UPDATE transaction_fund_reservations

    SET
        status =
            'RELEASED',

        resolved_at =
            now()

    WHERE transaction_id =
        p_transaction_id

      AND status =
        'RESERVED';

END;

$$;


COMMIT;