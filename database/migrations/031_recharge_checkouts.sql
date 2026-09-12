/*
 * ============================================================
 * 031_recharge_checkouts.sql
 * ============================================================
 *
 * OBJETIVO
 * -------
 * Añadir una capa de operación/checkout para recargas CUSTOMER
 * sin modificar la semántica actual de transactions, Ledger V2,
 * card_registrations ni customer_card_activations.
 *
 * Esta migración es ADITIVA:
 * - NO altera columnas existentes.
 * - NO migra transacciones históricas.
 * - NO cambia balances.
 * - NO cambia counters.
 * - NO crea ni confirma operaciones financieras.
 *
 * payment_method describe CÓMO PAGÓ el cliente:
 *   CASH = efectivo físico
 *   CARD = tarjeta bancaria / terminal
 *
 * Esto NO reemplaza transactions.credit_fund_type.
 * En Ledger V2, credit_fund_type='CASH' sigue significando
 * crédito pagado por el cliente aunque físicamente pague con
 * tarjeta bancaria.
 * ============================================================
 */

BEGIN;

CREATE TABLE recharge_checkouts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    idempotency_key text NOT NULL,

    device_id uuid NOT NULL,
    actor_role text NOT NULL,
    actor_card_id bigint NOT NULL,
    recharge_point_id uuid,

    target_uid text NOT NULL,
    card_id bigint,

    /*
     * NEW      = UID nunca registrado.
     * EXISTING = CUSTOMER activa existente.
     * REUSED   = CUSTOMER devuelta correctamente y reutilizada.
     */
    card_path text NOT NULL,

    /*
     * Enlaces hacia los motores existentes.
     * El checkout orquesta, no reemplaza, esas operaciones.
     */
    registration_id uuid,
    activation_transaction_id uuid,
    recharge_transaction_id uuid,

    promotion_id uuid,

    /*
     * Snapshot económico:
     *
     * paid_recharge_amount
     *   Dinero real pagado por la recarga.
     *
     * promotional_credit_amount
     *   Crédito promocional regalado.
     *
     * credited_amount
     *   Incremento TOTAL que debe recibir el saldo NFC.
     *
     * activation_fee_amount
     *   Cuota de activación cobrada por TAQUILLA.
     *   ADMIN siempre usa 0.
     *
     * total_due_amount
     *   Total que TAQUILLA debe cobrar:
     *   paid_recharge_amount + activation_fee_amount.
     */
    paid_recharge_amount bigint NOT NULL DEFAULT 0,
    promotional_credit_amount bigint NOT NULL DEFAULT 0,
    credited_amount bigint NOT NULL,
    activation_fee_amount bigint NOT NULL DEFAULT 0,
    total_due_amount bigint NOT NULL DEFAULT 0,

    /*
     * Método físico de cobro:
     * CASH = efectivo
     * CARD = tarjeta bancaria / terminal
     *
     * Solo aplica a RECHARGE. ADMIN usa NULL.
     */
    payment_method text,

    /*
     * Estado lógico del checkout.
     */
    status text NOT NULL DEFAULT 'PENDING',

    failure_reason text,

    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    confirmed_at timestamptz,
    failed_at timestamptz,

    CONSTRAINT recharge_checkouts_device_fk
        FOREIGN KEY (device_id)
        REFERENCES devices(id)
        ON DELETE RESTRICT,

    CONSTRAINT recharge_checkouts_actor_card_fk
        FOREIGN KEY (actor_card_id)
        REFERENCES cards(card_id)
        ON DELETE RESTRICT,

    CONSTRAINT recharge_checkouts_recharge_point_fk
        FOREIGN KEY (recharge_point_id)
        REFERENCES recharge_points(id)
        ON DELETE RESTRICT,

    CONSTRAINT recharge_checkouts_card_fk
        FOREIGN KEY (card_id)
        REFERENCES cards(card_id)
        ON DELETE RESTRICT,

    CONSTRAINT recharge_checkouts_registration_fk
        FOREIGN KEY (registration_id)
        REFERENCES card_registrations(id)
        ON DELETE RESTRICT,

    CONSTRAINT recharge_checkouts_activation_transaction_fk
        FOREIGN KEY (activation_transaction_id)
        REFERENCES transactions(id)
        ON DELETE RESTRICT,

    CONSTRAINT recharge_checkouts_recharge_transaction_fk
        FOREIGN KEY (recharge_transaction_id)
        REFERENCES transactions(id)
        ON DELETE RESTRICT,

    CONSTRAINT recharge_checkouts_promotion_fk
        FOREIGN KEY (promotion_id)
        REFERENCES promotions(id)
        ON DELETE RESTRICT,

    CONSTRAINT recharge_checkouts_idempotency_key_check
        CHECK (length(btrim(idempotency_key)) > 0),

    CONSTRAINT recharge_checkouts_target_uid_check
        CHECK (length(btrim(target_uid)) > 0),

    CONSTRAINT recharge_checkouts_actor_role_check
        CHECK (actor_role IN ('ADMIN', 'RECHARGE')),

    CONSTRAINT recharge_checkouts_card_path_check
        CHECK (card_path IN ('NEW', 'EXISTING', 'REUSED')),

    CONSTRAINT recharge_checkouts_payment_method_check
        CHECK (
            payment_method IS NULL
            OR payment_method IN ('CASH', 'CARD')
        ),

    CONSTRAINT recharge_checkouts_status_check
        CHECK (
            status IN (
                'PENDING',
                'IN_PROGRESS',
                'CONFIRMED',
                'FAILED',
                'MANUAL_REVIEW_REQUIRED'
            )
        ),

    CONSTRAINT recharge_checkouts_paid_amount_check
        CHECK (paid_recharge_amount >= 0),

    CONSTRAINT recharge_checkouts_promotional_amount_check
        CHECK (promotional_credit_amount >= 0),

    CONSTRAINT recharge_checkouts_credited_amount_check
        CHECK (credited_amount > 0),

    CONSTRAINT recharge_checkouts_activation_fee_check
        CHECK (activation_fee_amount >= 0),

    CONSTRAINT recharge_checkouts_total_due_check
        CHECK (total_due_amount >= 0),

    /*
     * RECHARGE representa una venta real en TAQUILLA.
     */
    CONSTRAINT recharge_checkouts_recharge_semantics_check
        CHECK (
            actor_role <> 'RECHARGE'
            OR (
                recharge_point_id IS NOT NULL
                AND payment_method IN ('CASH', 'CARD')
                AND paid_recharge_amount > 0
                AND credited_amount =
                    paid_recharge_amount +
                    promotional_credit_amount
                AND total_due_amount =
                    paid_recharge_amount +
                    activation_fee_amount
            )
        ),

    /*
     * ADMIN puede otorgar crédito, pero no representa ingreso
     * físico de taquilla ni cuota de activación vendida.
     */
    CONSTRAINT recharge_checkouts_admin_semantics_check
        CHECK (
            actor_role <> 'ADMIN'
            OR (
                recharge_point_id IS NULL
                AND payment_method IS NULL
                AND paid_recharge_amount = 0
                AND promotional_credit_amount = 0
                AND activation_fee_amount = 0
                AND total_due_amount = 0
            )
        ),

    /*
     * Una CUSTOMER ya activa no debe cobrar activación.
     */
    CONSTRAINT recharge_checkouts_existing_activation_fee_check
        CHECK (
            card_path <> 'EXISTING'
            OR activation_fee_amount = 0
        ),

    CONSTRAINT recharge_checkouts_confirmed_timestamp_check
        CHECK (
            status <> 'CONFIRMED'
            OR confirmed_at IS NOT NULL
        ),

    CONSTRAINT recharge_checkouts_failed_timestamp_check
        CHECK (
            status <> 'FAILED'
            OR failed_at IS NOT NULL
        )
);


/*
 * Idempotencia lógica del checkout.
 */
CREATE UNIQUE INDEX recharge_checkouts_idempotency_key_uidx
    ON recharge_checkouts (idempotency_key);


/*
 * Una registration real solo puede pertenecer a un checkout.
 */
CREATE UNIQUE INDEX recharge_checkouts_registration_uidx
    ON recharge_checkouts (registration_id)
    WHERE registration_id IS NOT NULL;


/*
 * Una CARD_CREATED real solo puede pertenecer a un checkout.
 */
CREATE UNIQUE INDEX recharge_checkouts_activation_tx_uidx
    ON recharge_checkouts (activation_transaction_id)
    WHERE activation_transaction_id IS NOT NULL;


/*
 * Una RECHARGE real solo puede pertenecer a un checkout.
 */
CREATE UNIQUE INDEX recharge_checkouts_recharge_tx_uidx
    ON recharge_checkouts (recharge_transaction_id)
    WHERE recharge_transaction_id IS NOT NULL;


/*
 * PROTECCIÓN DE CONCURRENCIA / RECUPERACIÓN
 * ------------------------------------------
 *
 * Un UID puede tener como máximo UNA operación no resuelta.
 *
 * Esto evita:
 * - dos Ulefone operando simultáneamente el mismo UID;
 * - crear otro checkout después de una caída sin reconciliar;
 * - duplicar registro/recarga durante reintentos.
 *
 * MANUAL_REVIEW_REQUIRED también bloquea nuevas operaciones
 * hasta que un ADMIN resuelva explícitamente el caso.
 */
CREATE UNIQUE INDEX recharge_checkouts_one_open_per_uid_idx
    ON recharge_checkouts ((upper(target_uid)))
    WHERE status IN (
        'PENDING',
        'IN_PROGRESS',
        'MANUAL_REVIEW_REQUIRED'
    );


/*
 * Historial por punto de recarga.
 */
CREATE INDEX recharge_checkouts_recharge_point_created_idx
    ON recharge_checkouts (
        recharge_point_id,
        created_at DESC
    )
    WHERE actor_role = 'RECHARGE';


/*
 * Historial por operador.
 */
CREATE INDEX recharge_checkouts_actor_created_idx
    ON recharge_checkouts (
        actor_role,
        actor_card_id,
        created_at DESC
    );


/*
 * Diagnóstico / recuperación por UID.
 */
CREATE INDEX recharge_checkouts_target_uid_status_idx
    ON recharge_checkouts (
        upper(target_uid),
        status,
        created_at DESC
    );


/*
 * Diagnóstico por CUSTOMER ya conocida.
 */
CREATE INDEX recharge_checkouts_card_created_idx
    ON recharge_checkouts (
        card_id,
        created_at DESC
    )
    WHERE card_id IS NOT NULL;


/*
 * Búsqueda rápida de operaciones no terminales por dispositivo.
 */
CREATE INDEX recharge_checkouts_open_idx
    ON recharge_checkouts (
        device_id,
        created_at DESC
    )
    WHERE status IN (
        'PENDING',
        'IN_PROGRESS',
        'MANUAL_REVIEW_REQUIRED'
    );


/*
 * ============================================================
 * AUDITORÍA DE CAMBIOS DE MÉTODO DE PAGO
 * ============================================================
 *
 * El historial podrá corregir:
 * CASH -> CARD
 * CARD -> CASH
 *
 * El cambio no borra la evidencia anterior.
 * ============================================================
 */

CREATE TABLE recharge_checkout_payment_method_changes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    checkout_id uuid NOT NULL,

    previous_method text NOT NULL,
    new_method text NOT NULL,

    changed_by_role text NOT NULL,
    changed_by_card_id bigint NOT NULL,
    device_id uuid NOT NULL,

    reason text,

    changed_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT recharge_checkout_payment_changes_checkout_fk
        FOREIGN KEY (checkout_id)
        REFERENCES recharge_checkouts(id)
        ON DELETE RESTRICT,

    CONSTRAINT recharge_checkout_payment_changes_actor_card_fk
        FOREIGN KEY (changed_by_card_id)
        REFERENCES cards(card_id)
        ON DELETE RESTRICT,

    CONSTRAINT recharge_checkout_payment_changes_device_fk
        FOREIGN KEY (device_id)
        REFERENCES devices(id)
        ON DELETE RESTRICT,

    CONSTRAINT recharge_checkout_payment_changes_previous_check
        CHECK (previous_method IN ('CASH', 'CARD')),

    CONSTRAINT recharge_checkout_payment_changes_new_check
        CHECK (new_method IN ('CASH', 'CARD')),

    CONSTRAINT recharge_checkout_payment_changes_different_check
        CHECK (previous_method <> new_method),

    CONSTRAINT recharge_checkout_payment_changes_role_check
        CHECK (changed_by_role IN ('ADMIN', 'RECHARGE'))
);


CREATE INDEX recharge_checkout_payment_changes_checkout_idx
    ON recharge_checkout_payment_method_changes (
        checkout_id,
        changed_at DESC
    );


CREATE INDEX recharge_checkout_payment_changes_actor_idx
    ON recharge_checkout_payment_method_changes (
        changed_by_role,
        changed_by_card_id,
        changed_at DESC
    );


COMMENT ON TABLE recharge_checkouts IS
'Contenedor lógico e idempotente de una recarga CUSTOMER. Une registro opcional, cuota de activación, recarga, promoción y método físico de pago sin reemplazar Financial Ledger V2.';

COMMENT ON COLUMN recharge_checkouts.payment_method IS
'Método físico de cobro de TAQUILLA: CASH=efectivo, CARD=tarjeta bancaria. No confundir con transactions.credit_fund_type.';

COMMENT ON COLUMN recharge_checkouts.paid_recharge_amount IS
'Dinero real pagado por el cliente por la recarga, excluyendo cuota de activación. En promociones corresponde al cash_amount de la promoción.';

COMMENT ON COLUMN recharge_checkouts.promotional_credit_amount IS
'Crédito promocional otorgado sin pago adicional.';

COMMENT ON COLUMN recharge_checkouts.credited_amount IS
'Incremento total que debe reflejarse en saldo NFC para la recarga.';

COMMENT ON COLUMN recharge_checkouts.activation_fee_amount IS
'Cuota de activación cobrada por TAQUILLA en esta operación. ADMIN siempre usa 0.';

COMMENT ON COLUMN recharge_checkouts.total_due_amount IS
'Total que TAQUILLA debe cobrar físicamente: paid_recharge_amount + activation_fee_amount. ADMIN siempre usa 0.';

COMMENT ON TABLE recharge_checkout_payment_method_changes IS
'Auditoría inmutable de correcciones CASH/CARD realizadas desde el historial de TAQUILLA o por ADMIN.';


COMMIT;
