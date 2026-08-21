begin;

-- =========================================================
-- TARJETAS GAME ASIGNADAS A JUEGOS
-- =========================================================
--
-- Una tarjeta física de tipo GAME representa
-- una credencial para abrir un juego concreto.
--
-- Ejemplo:
--
-- Card ID 2
-- Type GAME
--        ↓
-- GAME-DEV-01
-- Juego de Prueba
-- =========================================================

create table game_cards (
    id uuid primary key default gen_random_uuid(),

    card_id bigint not null unique
        references cards(card_id),

    game_id uuid not null
        references games(id),

    status text not null default 'ACTIVE'
        check (
            status in (
                'ACTIVE',
                'BLOCKED',
                'INACTIVE'
            )
        ),

    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

-- =========================================================
-- ÍNDICES
-- =========================================================

create index game_cards_game_id_idx
    on game_cards(game_id);

commit;