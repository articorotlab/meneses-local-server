begin;

-- =========================================================
-- DATOS ADICIONALES PARA EL PROTOCOLO DE TRANSACCIONES
-- =========================================================

alter table transactions
    add column if not exists confirmed_at timestamptz;

alter table transactions
    add column if not exists failed_at timestamptz;

alter table transactions
    add column if not exists failure_reason text;

-- =========================================================
-- SOLO UNA OPERACIÓN ABIERTA POR TARJETA
--
-- Impide que dos Ulefone tengan simultáneamente
-- una operación autorizada sobre la misma tarjeta.
-- =========================================================

create unique index if not exists
    transactions_one_open_per_card_idx
on transactions(card_id)
where card_write_status in (
    'PENDING',
    'AUTHORIZED',
    'CARD_WRITTEN'
);

commit;