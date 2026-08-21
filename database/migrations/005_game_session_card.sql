begin;

-- =========================================================
-- TARJETA GAME QUE ABRIÓ LA SESIÓN
-- =========================================================
--
-- Nos permite saber exactamente qué credencial física
-- inició la sesión de un juego en un Ulefone.
--
-- Ejemplo:
--
-- ULEFONE-DEV-01
--        ↓
-- Card ID 2 (GAME)
--        ↓
-- Juego de Prueba
-- =========================================================

alter table device_game_sessions
    add column opened_by_card_id bigint
        references cards(card_id);

create index device_game_sessions_opened_by_card_id_idx
    on device_game_sessions(opened_by_card_id);

commit;