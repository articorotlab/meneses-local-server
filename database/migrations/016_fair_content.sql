begin;


/*
 * =========================================================
 * CONTENIDO PÚBLICO DE LA FERIA
 * =========================================================
 *
 * Incluye:
 *
 * - imagen de portada;
 * - atracciones;
 * - múltiples imágenes por atracción.
 *
 * Las imágenes físicas NO se almacenan en PostgreSQL.
 * Solamente conservamos la ruta pública del archivo.
 * =========================================================
 */


/*
 * =========================================================
 * PORTADA
 * =========================================================
 */

alter table fair_settings

add column if not exists
    cover_image_url text;


/*
 * =========================================================
 * ATRACCIONES
 * =========================================================
 */

create table if not exists fair_attractions (

    id uuid
        primary key
        default gen_random_uuid(),

    name text
        not null,

    sort_order integer
        not null
        default 0,

    created_at timestamp with time zone
        not null
        default now(),

    updated_at timestamp with time zone
        not null
        default now(),

    constraint fair_attractions_name_check
        check (
            length(
                trim(name)
            ) >= 2
        ),

    constraint fair_attractions_sort_order_check
        check (
            sort_order >= 0
        )
);


/*
 * =========================================================
 * IMÁGENES DE ATRACCIONES
 * =========================================================
 */

create table if not exists fair_attraction_images (

    id uuid
        primary key
        default gen_random_uuid(),

    attraction_id uuid
        not null
        references fair_attractions(id)
        on delete cascade,

    image_url text
        not null,

    sort_order integer
        not null
        default 0,

    created_at timestamp with time zone
        not null
        default now(),

    constraint fair_attraction_images_url_check
        check (
            length(
                trim(image_url)
            ) > 0
        ),

    constraint fair_attraction_images_sort_order_check
        check (
            sort_order >= 0
        )
);


/*
 * =========================================================
 * ÍNDICES
 * =========================================================
 */

create index if not exists
    fair_attractions_sort_order_idx

on fair_attractions (
    sort_order,
    created_at
);


create index if not exists
    fair_attraction_images_attraction_id_idx

on fair_attraction_images (
    attraction_id
);


create index if not exists
    fair_attraction_images_sort_order_idx

on fair_attraction_images (
    attraction_id,
    sort_order,
    created_at
);


commit;