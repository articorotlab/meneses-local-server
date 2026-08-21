begin;

-- =========================================================
-- USUARIOS ADMINISTRATIVOS WEB
-- =========================================================
--
-- Estos usuarios son EXCLUSIVOS del panel web.
--
-- No tienen relación con:
-- - tarjetas ADMIN NFC;
-- - device_admin_sessions;
-- - dispositivos Ulefone.
--
-- La contraseña nunca se guarda en texto plano.
-- password_hash contendrá posteriormente un hash seguro.
-- =========================================================

create table if not exists web_admin_users (
    id uuid primary key
        default gen_random_uuid(),

    email text not null,

    full_name text not null,

    password_hash text not null,

    role text not null
        default 'ADMIN',

    status text not null
        default 'ACTIVE',

    last_login_at timestamp with time zone,

    created_at timestamp with time zone
        not null default now(),

    updated_at timestamp with time zone
        not null default now(),

    constraint web_admin_users_role_check
        check (
            role in (
                'OWNER',
                'ADMIN'
            )
        ),

    constraint web_admin_users_status_check
        check (
            status in (
                'ACTIVE',
                'BLOCKED',
                'INACTIVE'
            )
        ),

    constraint web_admin_users_email_check
        check (
            position('@' in email) > 1
        )
);


-- Correo único sin importar mayúsculas/minúsculas.
--
-- Ejemplo:
-- admin@meneses.com
-- ADMIN@MENESES.COM
--
-- se consideran el mismo usuario.

create unique index if not exists
    web_admin_users_email_lower_idx
on web_admin_users (
    lower(email)
);


create index if not exists
    web_admin_users_status_idx
on web_admin_users (
    status
);


-- =========================================================
-- SESIONES WEB
-- =========================================================
--
-- Cuando el usuario haga login:
--
-- 1. servidor genera token aleatorio;
-- 2. navegador recibe token mediante cookie segura;
-- 3. PostgreSQL guarda solamente el HASH del token;
-- 4. cada petición ADMIN valida esa sesión.
--
-- Si alguien obtuviera la base de datos, no tendría
-- directamente los tokens válidos de sesión.
-- =========================================================

create table if not exists web_admin_sessions (
    id uuid primary key
        default gen_random_uuid(),

    user_id uuid not null,

    token_hash text not null,

    created_at timestamp with time zone
        not null default now(),

    expires_at timestamp with time zone
        not null,

    last_seen_at timestamp with time zone
        not null default now(),

    revoked_at timestamp with time zone,

    user_agent text,

    ip_address inet,

    constraint web_admin_sessions_user_id_fkey
        foreign key (user_id)
        references web_admin_users(id)
        on delete cascade,

    constraint web_admin_sessions_expiration_check
        check (
            expires_at > created_at
        )
);


create unique index if not exists
    web_admin_sessions_token_hash_idx
on web_admin_sessions (
    token_hash
);


create index if not exists
    web_admin_sessions_user_id_idx
on web_admin_sessions (
    user_id
);


create index if not exists
    web_admin_sessions_expires_at_idx
on web_admin_sessions (
    expires_at
);


create index if not exists
    web_admin_sessions_active_idx
on web_admin_sessions (
    user_id,
    expires_at
)
where revoked_at is null;


commit;