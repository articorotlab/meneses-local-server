begin;

-- =========================================================
-- CONFIGURACIÓN PÚBLICA DE LA FERIA
-- =========================================================
--
-- Una sola fila representa la configuración pública actual.
-- Posteriormente será editable desde el panel web ADMIN.
-- =========================================================

create table if not exists fair_settings (
    id integer primary key default 1,

    fair_name text not null
        default 'Espectaculares Meneses',

    location_name text,

    address text,

    city text,

    state text,

    country text not null
        default 'México',

    latitude numeric(10, 7),

    longitude numeric(10, 7),

    maps_url text,

    phone text,

    is_open boolean not null
        default true,

    created_at timestamp with time zone
        not null default now(),

    updated_at timestamp with time zone
        not null default now(),

    constraint fair_settings_single_row_check
        check (id = 1)
);


-- =========================================================
-- HORARIOS
--
-- ISO:
-- 1 = lunes
-- 2 = martes
-- ...
-- 7 = domingo
-- =========================================================

create table if not exists fair_hours (
    id uuid primary key
        default gen_random_uuid(),

    day_of_week integer not null,

    opens_at time,

    closes_at time,

    is_closed boolean not null
        default false,

    created_at timestamp with time zone
        not null default now(),

    updated_at timestamp with time zone
        not null default now(),

    constraint fair_hours_day_check
        check (
            day_of_week between 1 and 7
        ),

    constraint fair_hours_day_unique
        unique (day_of_week),

    constraint fair_hours_time_check
        check (
            (
                is_closed = true
                and opens_at is null
                and closes_at is null
            )
            or
            (
                is_closed = false
                and opens_at is not null
                and closes_at is not null
            )
        )
);


-- =========================================================
-- EVENTOS PÚBLICOS
-- =========================================================

create table if not exists fair_events (
    id uuid primary key
        default gen_random_uuid(),

    title text not null,

    description text,

    event_date date not null,

    start_time time,

    end_time time,

    image_url text,

    status text not null
        default 'ACTIVE',

    created_at timestamp with time zone
        not null default now(),

    updated_at timestamp with time zone
        not null default now(),

    constraint fair_events_status_check
        check (
            status in (
                'ACTIVE',
                'INACTIVE'
            )
        )
);


create index if not exists
    fair_events_event_date_idx
on fair_events (
    event_date
);


create index if not exists
    fair_events_status_idx
on fair_events (
    status
);


-- =========================================================
-- CONFIGURACIÓN INICIAL PROVISIONAL
-- =========================================================

insert into fair_settings (
    id,
    fair_name,
    location_name,
    city,
    state,
    country,
    is_open
)
values (
    1,
    'Espectaculares Meneses',
    'Ubicación por definir',
    'Córdoba',
    'Veracruz',
    'México',
    true
)
on conflict (id)
do nothing;


-- =========================================================
-- HORARIOS PROVISIONALES
--
-- Podrán ser modificados posteriormente desde ADMIN.
-- =========================================================

insert into fair_hours (
    day_of_week,
    opens_at,
    closes_at,
    is_closed
)
values
    (1, '18:00', '23:00', false),
    (2, '18:00', '23:00', false),
    (3, '18:00', '23:00', false),
    (4, '18:00', '23:00', false),
    (5, '18:00', '00:00', false),
    (6, '17:00', '00:00', false),
    (7, '17:00', '23:00', false)
on conflict (day_of_week)
do nothing;


commit;