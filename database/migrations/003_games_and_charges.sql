begin;

-- =========================================================
-- JUEGOS
-- =========================================================

create table games (
    id uuid primary key default gen_random_uuid(),

    game_code text not null unique,

    name text not null,

    price bigint not null
        check (price > 0),

    status text not null default 'ACTIVE'
        check (
            status in (
                'ACTIVE',
                'INACTIVE',
                'MAINTENANCE'
            )
        ),

    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

-- =========================================================
-- SESIONES DE JUEGO POR DISPOSITIVO
-- =========================================================
--
-- Un Ulefone puede cambiar de juego en diferentes momentos,
-- pero solamente puede tener UNA sesión activa a la vez.
--
-- Más adelante una tarjeta GAME será la que abra esta sesión.
-- =========================================================

create table device_game_sessions (
    id uuid primary key default gen_random_uuid(),

    device_id uuid not null
        references devices(id),

    game_id uuid not null
        references games(id),

    started_at timestamptz not null default now(),

    ended_at timestamptz,

    status text not null default 'ACTIVE'
        check (
            status in (
                'ACTIVE',
                'CLOSED'
            )
        )
);

-- =========================================================
-- SOLO UNA SESIÓN ACTIVA POR DISPOSITIVO
-- =========================================================

create unique index
    device_game_sessions_one_active_per_device_idx
on device_game_sessions(device_id)
where
    status = 'ACTIVE'
    and ended_at is null;

-- =========================================================
-- AMPLIAR TRANSACCIONES
-- =========================================================
--
-- Para CHARGE necesitamos saber:
--
-- qué juego;
-- precio unitario;
-- cuántas personas.
-- =========================================================

alter table transactions
    add column game_id uuid
        references games(id);

alter table transactions
    add column unit_price bigint
        check (
            unit_price is null
            or unit_price > 0
        );

alter table transactions
    add column quantity integer
        check (
            quantity is null
            or quantity > 0
        );

-- =========================================================
-- ÍNDICES
-- =========================================================

create index transactions_game_id_idx
    on transactions(game_id);

create index device_game_sessions_game_id_idx
    on device_game_sessions(game_id);

create index device_game_sessions_device_id_idx
    on device_game_sessions(device_id);

commit;