BEGIN;

-- =========================================================
-- 028_card_registration_reuse_support.sql
--
-- Permite reutilizar una tarjeta física CUSTOMER después de
-- una devolución confirmada.
--
-- Antes:
--   UNIQUE (reserved_card_id)
--
-- Eso impedía que el mismo card_id pudiera tener un segundo
-- registro histórico aunque el primero ya estuviera CONFIRMED.
--
-- Ahora:
--   se conservan todos los registros históricos;
--   solo se impide tener DOS registros PENDING simultáneos
--   para el mismo reserved_card_id.
-- =========================================================

ALTER TABLE public.card_registrations
DROP CONSTRAINT IF EXISTS
    card_registrations_reserved_card_id_key;


CREATE UNIQUE INDEX IF NOT EXISTS
    card_registrations_one_pending_per_reserved_card_id_idx
ON public.card_registrations (
    reserved_card_id
)
WHERE status = 'PENDING';


COMMIT;
