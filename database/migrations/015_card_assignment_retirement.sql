begin;


/*
 * =========================================================
 * RETIRO HISTÓRICO DE TARJETAS GAME / RECHARGE
 * =========================================================
 *
 * Objetivo:
 *
 * permitir retirar definitivamente una tarjeta de un
 * juego o taquilla SIN eliminar:
 *
 * - cards;
 * - game_cards;
 * - recharge_cards;
 * - sesiones;
 * - transacciones;
 * - historial.
 *
 * Estados de asignación:
 *
 * ACTIVE
 *   Tarjeta asignada y operativa.
 *
 * INACTIVE
 *   Tarjeta asignada pero temporalmente desactivada.
 *   Puede reactivarse.
 *
 * BLOCKED
 *   Estado reservado/bloqueado.
 *
 * RETIRED
 *   La tarjeta fue retirada definitivamente de esa
 *   asignación.
 *
 *   Ya no debe aparecer como tarjeta actual.
 *   No debe poder reactivarse.
 * =========================================================
 */


/*
 * =========================================================
 * GAME CARDS
 * =========================================================
 */

alter table game_cards

drop constraint
    game_cards_status_check;


alter table game_cards

add constraint
    game_cards_status_check

check (
    status = any (
        array[
            'ACTIVE'::text,
            'BLOCKED'::text,
            'INACTIVE'::text,
            'RETIRED'::text
        ]
    )
);


/*
 * Sólo puede existir UNA tarjeta GAME activa
 * por juego.
 *
 * Las anteriores pueden permanecer como RETIRED.
 */

create unique index
    game_cards_one_active_per_game_idx

on game_cards (
    game_id
)

where status = 'ACTIVE';


/*
 * =========================================================
 * RECHARGE CARDS
 * =========================================================
 */

alter table recharge_cards

drop constraint
    recharge_cards_status_check;


alter table recharge_cards

add constraint
    recharge_cards_status_check

check (
    status = any (
        array[
            'ACTIVE'::text,
            'BLOCKED'::text,
            'INACTIVE'::text,
            'RETIRED'::text
        ]
    )
);


/*
 * recharge_cards ya cuenta con:
 *
 * recharge_cards_one_active_per_point_idx
 *
 * por lo que no necesitamos otro índice.
 */


commit;