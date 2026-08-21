begin;


/*
 * =========================================================
 * MENESES
 * DEVICE PROVISIONING
 * =========================================================
 *
 * Objetivos:
 *
 * 1. Mantener compatibilidad con los dispositivos actuales.
 *
 * 2. Preparar cada Ulefone para tener una credencial
 *    individual además de su device_code.
 *
 * 3. Permitir códigos temporales de provisionamiento.
 *
 * 4. Permitir que esos códigos sean generados tanto desde
 *    una sesión ADMIN Android como desde ADMIN Web.
 *
 * 5. Conservar toda la auditoría histórica existente,
 *    porque NO se modifica devices.id.
 *
 * IMPORTANTE:
 *
 * - credential_hash queda nullable por ahora para soportar
 *   ULEFONE-DEV-01 durante la transición.
 *
 * - NO modificamos todavía device_type.
 *
 * - NO renombramos ULEFONE-DEV-01.
 *
 * - NO eliminamos ninguna FK existente.
 * =========================================================
 */


/*
 * =========================================================
 * 1. AMPLIAR DEVICES
 * =========================================================
 */


/*
 * Hash de la credencial secreta entregada al Ulefone.
 *
 * Nunca guardaremos en PostgreSQL el token real que conoce
 * el dispositivo.
 *
 * Solamente guardaremos su hash.
 *
 * Nullable durante la migración para permitir que el
 * ULEFONE-DEV-01 continúe usando el sistema existente.
 */
alter table devices
add column if not exists credential_hash text;


/*
 * Momento en el que el dispositivo completó oficialmente
 * su provisionamiento.
 */
alter table devices
add column if not exists provisioned_at timestamp with time zone;


/*
 * Última vez que el servidor recibió actividad válida de
 * este dispositivo.
 *
 * Esto posteriormente permitirá mostrar en ADMIN:
 *
 * ULEFONE-004
 * Última actividad: hace 2 minutos
 */
alter table devices
add column if not exists last_seen_at timestamp with time zone;


/*
 * =========================================================
 * 2. CÓDIGOS DE PROVISIONAMIENTO
 * =========================================================
 *
 * Un código temporal puede verse como:
 *
 * MX8F-72KD
 *
 * Pero PostgreSQL NO guardará ese código directamente.
 *
 * Guardaremos:
 *
 * SHA-256("MX8F-72KD")
 *
 * El código real solamente se muestra al administrador
 * cuando se genera.
 * =========================================================
 */

create table if not exists device_provisioning_codes (

    id uuid
        primary key
        default gen_random_uuid(),


    /*
     * Ulefone al que pertenece este código.
     */
    device_id uuid
        not null
        references devices(id)
        on delete cascade,


    /*
     * Hash del código temporal.
     *
     * No almacenamos el código plano.
     */
    code_hash text
        not null
        unique,


    /*
     * Estados:
     *
     * PENDING
     *   Código creado y disponible.
     *
     * USED
     *   Ya fue utilizado correctamente.
     *
     * EXPIRED
     *   Venció.
     *
     * REVOKED
     *   ADMIN lo invalidó manualmente.
     */
    status text
        not null
        default 'PENDING',


    /*
     * Fecha/hora máxima para poder usarlo.
     */
    expires_at timestamp with time zone
        not null,


    /*
     * Momento exacto en que fue utilizado.
     */
    used_at timestamp with time zone,


    /*
     * Momento exacto en que fue revocado manualmente.
     */
    revoked_at timestamp with time zone,


    /*
     * =====================================================
     * ACTOR ANDROID ADMIN
     * =====================================================
     *
     * Si el código fue generado desde el perfil ADMIN del
     * Ulefone, aquí queda registrada la tarjeta ADMIN que
     * autorizó la operación.
     */
    created_by_admin_card_id bigint
        references cards(card_id),


    /*
     * =====================================================
     * ACTOR WEB ADMIN
     * =====================================================
     *
     * Si fue generado desde el panel web, aquí guardamos
     * el usuario web responsable.
     */
    created_by_web_admin_user_id uuid
        references web_admin_users(id),


    created_at timestamp with time zone
        not null
        default now(),


    /*
     * El código debe expirar en una fecha posterior
     * a su creación.
     */
    constraint device_provisioning_codes_expiration_check

        check (
            expires_at >
            created_at
        ),


    /*
     * Estados permitidos.
     */
    constraint device_provisioning_codes_status_check

        check (
            status = any (
                array[
                    'PENDING'::text,
                    'USED'::text,
                    'EXPIRED'::text,
                    'REVOKED'::text
                ]
            )
        ),


    /*
     * Debe existir exactamente un responsable:
     *
     * - tarjeta ADMIN Android
     *
     * o
     *
     * - usuario ADMIN Web
     *
     * Nunca ninguno.
     * Nunca ambos.
     */
    constraint device_provisioning_codes_actor_check

        check (
            num_nonnulls(
                created_by_admin_card_id,
                created_by_web_admin_user_id
            ) = 1
        ),


    /*
     * Si fue usado debe existir used_at.
     *
     * Si no está USED, used_at debe permanecer null.
     */
    constraint device_provisioning_codes_used_check

        check (
            (
                status = 'USED'
                and used_at is not null
            )
            or
            (
                status <> 'USED'
                and used_at is null
            )
        ),


    /*
     * Si fue revocado debe existir revoked_at.
     *
     * Para otros estados debe permanecer null.
     */
    constraint device_provisioning_codes_revoked_check

        check (
            (
                status = 'REVOKED'
                and revoked_at is not null
            )
            or
            (
                status <> 'REVOKED'
                and revoked_at is null
            )
        )
);


/*
 * =========================================================
 * 3. ÍNDICES
 * =========================================================
 */


/*
 * Buscar rápidamente códigos asociados a un dispositivo.
 */
create index if not exists
device_provisioning_codes_device_id_idx

on device_provisioning_codes(
    device_id
);


/*
 * Buscar códigos según estado.
 */
create index if not exists
device_provisioning_codes_status_idx

on device_provisioning_codes(
    status
);


/*
 * Facilitar limpieza automática de códigos vencidos.
 */
create index if not exists
device_provisioning_codes_expires_at_idx

on device_provisioning_codes(
    expires_at
);


/*
 * Sólo permitimos UN código PENDING simultáneo por Ulefone.
 *
 * Cuando ADMIN genere uno nuevo, el backend revocará
 * previamente cualquier código pendiente anterior.
 */
create unique index if not exists
device_provisioning_codes_one_pending_per_device_idx

on device_provisioning_codes(
    device_id
)

where status = 'PENDING';


/*
 * =========================================================
 * 4. AUDITORÍA DE DISPOSITIVOS
 * =========================================================
 *
 * Las sesiones GAME / RECHARGE / ADMIN ya auditan el uso
 * operativo.
 *
 * Esta tabla audita cambios administrativos sobre el
 * dispositivo mismo.
 * =========================================================
 */

create table if not exists device_audit_events (

    id uuid
        primary key
        default gen_random_uuid(),


    device_id uuid
        not null
        references devices(id)
        on delete cascade,


    /*
     * Ejemplos:
     *
     * DEVICE_CREATED
     * PROVISIONING_CODE_CREATED
     * PROVISIONED
     * STATUS_CHANGED
     * CREDENTIAL_ROTATED
     * PROVISIONING_CODE_REVOKED
     */
    event_type text
        not null,


    /*
     * ADMIN_CARD
     * WEB_ADMIN
     * SYSTEM
     */
    actor_type text
        not null,


    /*
     * Para acciones realizadas desde Android ADMIN.
     */
    actor_admin_card_id bigint
        references cards(card_id),


    /*
     * Para acciones realizadas desde Web ADMIN.
     */
    actor_web_admin_user_id uuid
        references web_admin_users(id),


    /*
     * Información adicional del evento.
     *
     * Ejemplo:
     *
     * {
     *   "previousStatus": "ACTIVE",
     *   "newStatus": "BLOCKED"
     * }
     */
    metadata jsonb
        not null
        default '{}'::jsonb,


    created_at timestamp with time zone
        not null
        default now(),


    constraint device_audit_events_actor_type_check

        check (
            actor_type = any (
                array[
                    'ADMIN_CARD'::text,
                    'WEB_ADMIN'::text,
                    'SYSTEM'::text
                ]
            )
        ),


    /*
     * Coherencia entre actor_type y actor.
     */
    constraint device_audit_events_actor_check

        check (

            (
                actor_type = 'ADMIN_CARD'

                and actor_admin_card_id
                    is not null

                and actor_web_admin_user_id
                    is null
            )

            or

            (
                actor_type = 'WEB_ADMIN'

                and actor_admin_card_id
                    is null

                and actor_web_admin_user_id
                    is not null
            )

            or

            (
                actor_type = 'SYSTEM'

                and actor_admin_card_id
                    is null

                and actor_web_admin_user_id
                    is null
            )
        )
);


/*
 * =========================================================
 * 5. ÍNDICES DE AUDITORÍA
 * =========================================================
 */

create index if not exists
device_audit_events_device_id_idx

on device_audit_events(
    device_id
);


create index if not exists
device_audit_events_created_at_idx

on device_audit_events(
    created_at
);


create index if not exists
device_audit_events_event_type_idx

on device_audit_events(
    event_type
);


/*
 * =========================================================
 * 6. REGISTRAR EL DISPOSITIVO LEGACY
 * =========================================================
 *
 * No lo consideramos todavía provisionado porque:
 *
 * - Android sigue usando DEVICE_CODE hardcodeado.
 * - todavía no existe credential_hash.
 *
 * Solamente registramos en auditoría que ya existía antes
 * de implementar provisionamiento.
 * =========================================================
 */

insert into device_audit_events (
    device_id,
    event_type,
    actor_type,
    metadata
)

select
    d.id,

    'LEGACY_DEVICE_IMPORTED',

    'SYSTEM',

    jsonb_build_object(
        'deviceCode',
        d.device_code,

        'name',
        d.name,

        'previousDeviceType',
        d.device_type,

        'status',
        d.status
    )

from devices d

where d.device_code =
      'ULEFONE-DEV-01'

and not exists (

    select 1

    from device_audit_events dae

    where dae.device_id =
          d.id

      and dae.event_type =
          'LEGACY_DEVICE_IMPORTED'
);


commit;