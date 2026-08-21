begin;


/*
 * =========================================================
 * CONFIGURACIÓN OPERATIVA
 * =========================================================
 *
 * Contiene parámetros administrativos que afectan
 * la operación económica de la feria.
 *
 * Primera configuración:
 *
 * customer_card_activation_fee
 *
 * Precio que se cobra cuando una TAQUILLA crea
 * una nueva tarjeta CUSTOMER.
 *
 * IMPORTANTE:
 *
 * - este precio NO se convierte en saldo del cliente;
 * - cada CARD_CREATED conservará el precio histórico
 *   utilizado en transactions.amount;
 * - cambiar este valor solamente afecta futuras tarjetas.
 * =========================================================
 */


create table operational_settings (

    id smallint
        primary key,

    customer_card_activation_fee bigint
        not null
        default 25,

    updated_by_admin_card_id bigint
        references cards(card_id),

    created_at timestamp with time zone
        not null
        default now(),

    updated_at timestamp with time zone
        not null
        default now(),


    constraint operational_settings_singleton_check
        check (
            id = 1
        ),

    constraint operational_settings_activation_fee_check
        check (
            customer_card_activation_fee >= 0
        )
);


/*
 * =========================================================
 * CONFIGURACIÓN INICIAL
 * =========================================================
 *
 * Precio inicial:
 *
 * $25 MXN
 * =========================================================
 */

insert into operational_settings (
    id,
    customer_card_activation_fee
)

values (
    1,
    25
);


commit;