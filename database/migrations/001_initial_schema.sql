begin;

create extension if not exists pgcrypto;

-- =========================================================
-- DISPOSITIVOS
-- =========================================================

create table devices (
    id uuid primary key default gen_random_uuid(),

    device_code text not null unique,
    name text not null,

    device_type text not null
        check (
            device_type in (
                'ADMIN',
                'GAME',
                'RECHARGE'
            )
        ),

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
-- TARJETAS
-- =========================================================

create table cards (
    card_id bigint primary key,

    uid text not null unique,

    card_type text not null
        check (
            card_type in (
                'CUSTOMER',
                'ADMIN',
                'GAME',
                'RECHARGE'
            )
        ),

    status text not null default 'ACTIVE'
        check (
            status in (
                'ACTIVE',
                'BLOCKED',
                'INACTIVE'
            )
        ),

    balance bigint not null default 0
        check (balance >= 0),

    transaction_counter bigint not null default 0
        check (transaction_counter >= 0),

    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

-- =========================================================
-- TRANSACCIONES
-- =========================================================

create table transactions (
    id uuid primary key default gen_random_uuid(),

    idempotency_key text not null unique,

    card_id bigint not null
        references cards(card_id),

    device_id uuid
        references devices(id),

    transaction_type text not null
        check (
            transaction_type in (
                'CARD_CREATED',
                'RECHARGE',
                'CHARGE',
                'ADJUSTMENT',
                'REVERSAL'
            )
        ),

    amount bigint not null
        check (amount >= 0),

    balance_before bigint not null
        check (balance_before >= 0),

    balance_after bigint not null
        check (balance_after >= 0),

    counter_before bigint not null
        check (counter_before >= 0),

    counter_after bigint not null
        check (counter_after >= 0),

    card_write_status text not null default 'CONFIRMED'
        check (
            card_write_status in (
                'PENDING',
                'AUTHORIZED',
                'CARD_WRITTEN',
                'CONFIRMED',
                'FAILED',
                'REVERSAL_REQUIRED'
            )
        ),

    created_at timestamptz not null default now()
);

-- =========================================================
-- ÍNDICES
-- =========================================================

create index transactions_card_id_idx
    on transactions(card_id);

create index transactions_created_at_idx
    on transactions(created_at desc);

create index transactions_device_id_idx
    on transactions(device_id);

commit;