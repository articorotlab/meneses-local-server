begin;


/*
 * =========================================================
 * MENESES
 * DEVICE IDLE MODE + DEVICE CODE SEQUENCE
 * =========================================================
 *
 * device_type actualmente representa el modo operativo
 * más reciente/actual del Ulefone:
 *
 * - GAME
 * - RECHARGE
 * - ADMIN
 *
 * Agregamos IDLE para dispositivos:
 *
 * - recién creados;
 * - todavía no provisionados;
 * - sin modo operativo activo.
 *
 * También agregamos una secuencia dedicada para generar:
 *
 * ULEFONE-001
 * ULEFONE-002
 * ULEFONE-003
 * ...
 *
 * El dispositivo legacy ULEFONE-DEV-01 permanece intacto.
 * =========================================================
 */


/*
 * =========================================================
 * 1. DEVICE TYPE
 * =========================================================
 */

alter table devices
drop constraint if exists
devices_device_type_check;


alter table devices
add constraint
devices_device_type_check

check (
    device_type = any (
        array[
            'IDLE'::text,
            'ADMIN'::text,
            'GAME'::text,
            'RECHARGE'::text
        ]
    )
);


/*
 * =========================================================
 * 2. SECUENCIA PARA ULEFONE-001, 002, 003...
 * =========================================================
 */

create sequence if not exists
device_code_seq
as bigint
increment by 1
minvalue 1;


/*
 * Sincronizamos la secuencia con los dispositivos
 * numerados que pudieran existir.
 *
 * Caso actual:
 *
 * ULEFONE-DEV-01 existe,
 * pero todavía no existen ULEFONE-001, 002...
 *
 * Por compatibilidad, consideramos al legacy como el
 * dispositivo número 1. Por eso el siguiente será:
 *
 * ULEFONE-002
 */
do $$
declare

    v_max_number bigint;

    v_has_legacy boolean;

begin

    select
        max(
            substring(
                device_code
                from '^ULEFONE-([0-9]+)$'
            )::bigint
        )

    into
        v_max_number

    from devices

    where device_code ~
          '^ULEFONE-[0-9]+$';


    select exists (
        select 1
        from devices
        where device_code =
              'ULEFONE-DEV-01'
    )

    into
        v_has_legacy;


    if v_max_number is not null then

        perform setval(
            'device_code_seq',
            v_max_number,
            true
        );

    elsif v_has_legacy then

        /*
         * El legacy equivale conceptualmente
         * al dispositivo #1.
         *
         * nextval() devolverá 2.
         */
        perform setval(
            'device_code_seq',
            1,
            true
        );

    else

        /*
         * Instalación completamente nueva.
         *
         * nextval() devolverá 1.
         */
        perform setval(
            'device_code_seq',
            1,
            false
        );

    end if;

end
$$;


commit;