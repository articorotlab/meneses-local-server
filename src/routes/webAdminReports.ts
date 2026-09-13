import type { FastifyInstance } from "fastify";
import { db } from "../db/database.js";
import { requireWebAdmin } from "../auth/webAdminSession.js";

const REPORT_TIMEZONE = "America/Mexico_City";

type WebReportQuery = {
  from?: string;
  to?: string;
};

function isValidDateString(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;

  const parsed = new Date(`${value}T00:00:00Z`);

  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

export async function webAdminReportRoutes(server: FastifyInstance) {
  function validateReportQuery(query: WebReportQuery) {
    const { from, to } = query;

    if (!isValidDateString(from)) {
      return {
        ok: false as const,
        status: 400,
        body: {
          error: "INVALID_FROM_DATE",
          message: "from debe tener formato YYYY-MM-DD.",
        },
      };
    }

    if (!isValidDateString(to)) {
      return {
        ok: false as const,
        status: 400,
        body: {
          error: "INVALID_TO_DATE",
          message: "to debe tener formato YYYY-MM-DD.",
        },
      };
    }

    if (from > to) {
      return {
        ok: false as const,
        status: 400,
        body: {
          error: "INVALID_DATE_RANGE",
          message: "from no puede ser posterior a to.",
        },
      };
    }

    return {
      ok: true as const,
      from,
      to,
    };
  }

  /*
   * =====================================================
   * RESUMEN FINANCIERO WEB — CHECKOUT + LEGACY
   * =====================================================
   *
   * Regla:
   * - checkout CONFIRMED = fuente de verdad para pagos físicos nuevos;
   * - transacciones antiguas sin checkout se conservan como LEGACY;
   * - nunca se cuentan PENDING / IN_PROGRESS / FAILED /
   *   MANUAL_REVIEW_REQUIRED como ingreso.
   * =====================================================
   */
  server.get<{ Querystring: WebReportQuery }>(
    "/web/admin/reports/summary",
    async (request, reply) => {
      const webAdmin = await requireWebAdmin(request, reply);
      if (!webAdmin) return;

      const validation = validateReportQuery(request.query);
      if (!validation.ok) {
        return reply.status(validation.status).send(validation.body);
      }

      const { from, to } = validation;
      const client = await db.connect();

      try {
        const result = await client.query(
          `
          with confirmed_transactions as (
            select *
            from transactions t
            where t.card_write_status = 'CONFIRMED'
              and (
                coalesce(t.confirmed_at, t.created_at)
                at time zone $3
              )::date between $1::date and $2::date
          ),

          confirmed_checkouts as (
            select rc.*
            from recharge_checkouts rc
            where rc.status = 'CONFIRMED'
              and rc.actor_role = 'RECHARGE'
              and rc.recharge_point_id is not null
              and rc.confirmed_at is not null
              and (
                rc.confirmed_at at time zone $3
              )::date between $1::date and $2::date
          ),

          legacy_recharge_financials as (
            select
              t.id,
              t.amount as credited_amount,
              case
                when exists (
                  select 1
                  from transaction_credit_components c0
                  where c0.transaction_id = t.id
                ) then coalesce((
                  select sum(c.amount)
                  from transaction_credit_components c
                  where c.transaction_id = t.id
                    and c.fund_type = 'CASH'
                ), 0)
                else t.amount
              end as paid_recharge_amount,
              case
                when exists (
                  select 1
                  from transaction_credit_components c0
                  where c0.transaction_id = t.id
                ) then coalesce((
                  select sum(c.amount)
                  from transaction_credit_components c
                  where c.transaction_id = t.id
                    and c.fund_type = 'PROMOTIONAL'
                ), 0)
                else 0
              end as promotional_given
            from confirmed_transactions t
            where t.transaction_type = 'RECHARGE'
              and t.recharge_point_id is not null
              and not exists (
                select 1
                from recharge_checkouts rc
                where rc.recharge_transaction_id = t.id
              )
          ),

          legacy_activation_financials as (
            select t.id, t.amount
            from confirmed_transactions t
            where t.transaction_type = 'CARD_CREATED'
              and t.recharge_point_id is not null
              and not exists (
                select 1
                from recharge_checkouts rc
                where rc.activation_transaction_id = t.id
              )
          ),

          game_allocations as (
            select
              a.transaction_id,
              coalesce(sum(a.amount) filter (where a.fund_type = 'CASH'), 0) as cash_consumed,
              coalesce(sum(a.amount) filter (where a.fund_type = 'PROMOTIONAL'), 0) as promotional_consumed,
              coalesce(sum(a.amount) filter (where a.fund_type = 'ADMIN_CREDIT'), 0) as admin_credit_consumed,
              coalesce(sum(a.amount) filter (where a.fund_type = 'LEGACY'), 0) as legacy_consumed
            from transaction_fund_allocations a
            group by a.transaction_id
          ),

          card_activation_counts as (
            select
              count(*) filter (
                where a.activated_by_role = 'RECHARGE'
              )::bigint as recharge_activations_count,
              count(*) filter (
                where a.activated_by_role = 'ADMIN'
              )::bigint as admin_activations_count
            from customer_card_activations a
            where (
              a.started_at at time zone $3
            )::date between $1::date and $2::date
          ),

          card_return_financials as (
            select
              coalesce(sum(r.refund_amount), 0) as refund_amount,
              coalesce(sum(r.discarded_cash), 0) as discarded_cash,
              coalesce(sum(r.discarded_promotional), 0) as discarded_promotional,
              coalesce(sum(r.discarded_admin_credit), 0) as discarded_admin_credit,
              coalesce(sum(r.discarded_legacy), 0) as discarded_legacy,
              count(*)::bigint as returns_count,
              count(*) filter (
                where a.activated_by_role = 'RECHARGE'
              )::bigint as recharge_origin_returns_count,
              count(*) filter (
                where a.activated_by_role = 'ADMIN'
              )::bigint as admin_origin_returns_count
            from customer_card_returns r
            join customer_card_activations a
              on a.id = r.activation_id
            where (
              r.returned_at at time zone $3
            )::date between $1::date and $2::date
          )

          select
            coalesce((
              select sum(rc.total_due_amount)
              from confirmed_checkouts rc
              where rc.payment_method = 'CASH'
            ), 0) as checkout_cash_received,

            coalesce((
              select sum(rc.total_due_amount)
              from confirmed_checkouts rc
              where rc.payment_method = 'CARD'
            ), 0) as checkout_card_received,

            coalesce((
              select sum(rc.paid_recharge_amount)
              from confirmed_checkouts rc
            ), 0) as checkout_paid_recharge_amount,

            coalesce((
              select sum(rc.promotional_credit_amount)
              from confirmed_checkouts rc
            ), 0) as checkout_promotional_given,

            coalesce((
              select sum(rc.credited_amount)
              from confirmed_checkouts rc
            ), 0) as checkout_credited_amount,

            coalesce((
              select sum(rc.activation_fee_amount)
              from confirmed_checkouts rc
            ), 0) as checkout_activation_amount,

            coalesce((
              select sum(rc.total_due_amount)
              from confirmed_checkouts rc
            ), 0) as checkout_total_income_amount,

            coalesce((
              select sum(lr.paid_recharge_amount)
              from legacy_recharge_financials lr
            ), 0) as legacy_paid_recharge_amount,

            coalesce((
              select sum(lr.promotional_given)
              from legacy_recharge_financials lr
            ), 0) as legacy_promotional_given,

            coalesce((
              select sum(lr.credited_amount)
              from legacy_recharge_financials lr
            ), 0) as legacy_credited_amount,

            coalesce((
              select sum(la.amount)
              from legacy_activation_financials la
            ), 0) as legacy_activation_amount,

            coalesce((
              select sum(t.amount)
              from confirmed_transactions t
              where t.transaction_type = 'CHARGE'
                and t.game_id is not null
            ), 0) as game_consumption_amount,

            coalesce((
              select sum(coalesce(t.quantity, 0))
              from confirmed_transactions t
              where t.transaction_type = 'CHARGE'
                and t.game_id is not null
            ), 0) as game_people_count,

            coalesce((
              select sum(ga.cash_consumed)
              from confirmed_transactions t
              left join game_allocations ga on ga.transaction_id = t.id
              where t.transaction_type = 'CHARGE'
                and t.game_id is not null
            ), 0) as game_cash_consumed,

            coalesce((
              select sum(ga.promotional_consumed)
              from confirmed_transactions t
              left join game_allocations ga on ga.transaction_id = t.id
              where t.transaction_type = 'CHARGE'
                and t.game_id is not null
            ), 0) as game_promotional_consumed,

            coalesce((
              select sum(ga.admin_credit_consumed)
              from confirmed_transactions t
              left join game_allocations ga on ga.transaction_id = t.id
              where t.transaction_type = 'CHARGE'
                and t.game_id is not null
            ), 0) as game_admin_credit_consumed,

            coalesce((
              select sum(ga.legacy_consumed)
              from confirmed_transactions t
              left join game_allocations ga on ga.transaction_id = t.id
              where t.transaction_type = 'CHARGE'
                and t.game_id is not null
            ), 0) as game_legacy_consumed,

            coalesce((
              select sum(t.amount)
              from confirmed_transactions t
              where t.transaction_type = 'RECHARGE'
                and t.actor_role = 'ADMIN'
            ), 0) as admin_recharge_amount,

            coalesce((
              select sum(t.amount)
              from confirmed_transactions t
              where t.transaction_type = 'ADJUSTMENT'
                and t.actor_role = 'ADMIN'
            ), 0) as admin_adjustment_amount,

            coalesce((select r.refund_amount from card_return_financials r), 0)
              as card_return_refund_amount,

            coalesce((select r.discarded_cash from card_return_financials r), 0)
              as card_return_discarded_cash,

            coalesce((select r.discarded_promotional from card_return_financials r), 0)
              as card_return_discarded_promotional,

            coalesce((select r.discarded_admin_credit from card_return_financials r), 0)
              as card_return_discarded_admin_credit,

            coalesce((select r.discarded_legacy from card_return_financials r), 0)
              as card_return_discarded_legacy,

            coalesce((select a.recharge_activations_count from card_activation_counts a), 0)
              as recharge_activations_count,

            coalesce((select a.admin_activations_count from card_activation_counts a), 0)
              as admin_activations_count,

            coalesce((select r.returns_count from card_return_financials r), 0)
              as card_returns_count,

            coalesce((select r.recharge_origin_returns_count from card_return_financials r), 0)
              as recharge_origin_returns_count,

            coalesce((select r.admin_origin_returns_count from card_return_financials r), 0)
              as admin_origin_returns_count
          `,
          [from, to, REPORT_TIMEZONE]
        );

        const row = result.rows[0];

        const checkoutCashReceived = Number(row.checkout_cash_received);
        const checkoutCardReceived = Number(row.checkout_card_received);
        const checkoutPaidRechargeAmount = Number(row.checkout_paid_recharge_amount);
        const checkoutPromotionalGiven = Number(row.checkout_promotional_given);
        const checkoutCreditedAmount = Number(row.checkout_credited_amount);
        const checkoutActivationAmount = Number(row.checkout_activation_amount);
        const checkoutTotalIncomeAmount = Number(row.checkout_total_income_amount);

        const legacyPaidRechargeAmount = Number(row.legacy_paid_recharge_amount);
        const legacyPromotionalGiven = Number(row.legacy_promotional_given);
        const legacyCreditedAmount = Number(row.legacy_credited_amount);
        const legacyActivationAmount = Number(row.legacy_activation_amount);
        const legacyUnclassifiedReceived =
          legacyPaidRechargeAmount + legacyActivationAmount;

        const paidRechargeAmount =
          checkoutPaidRechargeAmount + legacyPaidRechargeAmount;
        const promotionalGiven =
          checkoutPromotionalGiven + legacyPromotionalGiven;
        const creditedAmount =
          checkoutCreditedAmount + legacyCreditedAmount;
        const activationAmount =
          checkoutActivationAmount + legacyActivationAmount;
        const totalIncomeAmount =
          checkoutTotalIncomeAmount + legacyUnclassifiedReceived;

        const gameConsumptionAmount = Number(row.game_consumption_amount);
        const gameCashConsumed = Number(row.game_cash_consumed);
        const gamePromotionalConsumed = Number(row.game_promotional_consumed);
        const gameAdminCreditConsumed = Number(row.game_admin_credit_consumed);
        const gameLegacyConsumed = Number(row.game_legacy_consumed);

        const cardReturnRefundAmount = Number(row.card_return_refund_amount);
        const cardReturnDiscardedCash = Number(row.card_return_discarded_cash);
        const cardReturnDiscardedPromotional =
          Number(row.card_return_discarded_promotional);
        const cardReturnDiscardedAdminCredit =
          Number(row.card_return_discarded_admin_credit);
        const cardReturnDiscardedLegacy =
          Number(row.card_return_discarded_legacy);
        const cardReturnDiscardedTotal =
          cardReturnDiscardedCash +
          cardReturnDiscardedPromotional +
          cardReturnDiscardedAdminCredit +
          cardReturnDiscardedLegacy;

        const classifiedGameConsumption =
          gameCashConsumed +
          gamePromotionalConsumed +
          gameAdminCreditConsumed +
          gameLegacyConsumed;

        return {
          from,
          to,
          timezone: REPORT_TIMEZONE,
          summary: {
            /*
             * Compatibilidad con el dashboard WEB actual.
             * rechargePointRechargeAmount ahora significa
             * "recargas pagadas", no "efectivo físico".
             */
            rechargePointAmount: totalIncomeAmount,
            rechargePointRechargeAmount: paidRechargeAmount,
            rechargePointActivationAmount: activationAmount,
            gameConsumptionAmount,
            gamePeopleCount: Number(row.game_people_count),

            rechargePoints: {
              cashReceived: checkoutCashReceived,
              cardReceived: checkoutCardReceived,
              legacyUnclassifiedReceived,
              paidRechargeAmount,
              promotionalGiven,
              creditedAmount,
              activationAmount,
              totalIncomeAmount,
            },

            games: {
              consumptionAmount: gameConsumptionAmount,
              cashConsumed: gameCashConsumed,
              promotionalConsumed: gamePromotionalConsumed,
              adminCreditConsumed: gameAdminCreditConsumed,
              legacyConsumed: gameLegacyConsumed,
              unclassifiedConsumed:
                gameConsumptionAmount - classifiedGameConsumption,
              peopleCount: Number(row.game_people_count),
            },

            admin: {
              rechargeAmount: Number(row.admin_recharge_amount),
              adjustmentAmount: Number(row.admin_adjustment_amount),
            },

            cards: {
              rechargeActivationsCount: Number(row.recharge_activations_count),
              adminActivationsCount: Number(row.admin_activations_count),
              returnsCount: Number(row.card_returns_count),
              rechargeOriginReturnsCount:
                Number(row.recharge_origin_returns_count),
              adminOriginReturnsCount:
                Number(row.admin_origin_returns_count),
            },

            cardReturns: {
              refundAmount: cardReturnRefundAmount,
              discardedCash: cardReturnDiscardedCash,
              discardedPromotional: cardReturnDiscardedPromotional,
              discardedAdminCredit: cardReturnDiscardedAdminCredit,
              discardedLegacy: cardReturnDiscardedLegacy,
              discardedTotal: cardReturnDiscardedTotal,
              returnsCount: Number(row.card_returns_count),
              rechargeOriginReturnsCount:
                Number(row.recharge_origin_returns_count),
              adminOriginReturnsCount:
                Number(row.admin_origin_returns_count),
            },
          },
        };
      } catch (error) {
        server.log.error(error);
        return reply.status(500).send({ error: "INTERNAL_ERROR" });
      } finally {
        client.release();
      }
    }
  );

  /*
   * =====================================================
   * JUEGOS — LISTADO / COMPARATIVA DIARIA
   * =====================================================
   */
  server.get<{ Querystring: WebReportQuery }>(
    "/web/admin/reports/games",
    async (request, reply) => {
      const webAdmin = await requireWebAdmin(request, reply);
      if (!webAdmin) return;

      const validation = validateReportQuery(request.query);
      if (!validation.ok) {
        return reply.status(validation.status).send(validation.body);
      }

      const { from, to } = validation;
      const client = await db.connect();

      try {
        const result = await client.query(
          `
          with charge_transactions as (
            select
              t.id,
              t.game_id,
              t.amount,
              coalesce(t.quantity, 0) as quantity,
              (
                coalesce(t.confirmed_at, t.created_at)
                at time zone $3
              )::date as report_date
            from transactions t
            where t.card_write_status = 'CONFIRMED'
              and t.transaction_type = 'CHARGE'
              and t.game_id is not null
              and (
                coalesce(t.confirmed_at, t.created_at)
                at time zone $3
              )::date between $1::date and $2::date
          ),
          allocation_totals as (
            select
              a.transaction_id,
              coalesce(sum(a.amount) filter (where a.fund_type = 'CASH'), 0) as cash_consumed,
              coalesce(sum(a.amount) filter (where a.fund_type = 'PROMOTIONAL'), 0) as promotional_consumed,
              coalesce(sum(a.amount) filter (where a.fund_type = 'ADMIN_CREDIT'), 0) as admin_credit_consumed,
              coalesce(sum(a.amount) filter (where a.fund_type = 'LEGACY'), 0) as legacy_consumed
            from transaction_fund_allocations a
            join charge_transactions ct on ct.id = a.transaction_id
            group by a.transaction_id
          )
          select
            g.id as game_id,
            g.name,
            g.price as current_price,
            to_char(ct.report_date, 'YYYY-MM-DD') as report_date,
            coalesce(sum(ct.amount), 0) as consumption_amount,
            coalesce(sum(at.cash_consumed), 0) as cash_consumed,
            coalesce(sum(at.promotional_consumed), 0) as promotional_consumed,
            coalesce(sum(at.admin_credit_consumed), 0) as admin_credit_consumed,
            coalesce(sum(at.legacy_consumed), 0) as legacy_consumed,
            coalesce(sum(ct.quantity), 0) as people_count,
            count(*) as operations_count
          from charge_transactions ct
          join games g on g.id = ct.game_id
          left join allocation_totals at on at.transaction_id = ct.id
          group by g.id, g.name, g.price, ct.report_date
          order by g.name asc, ct.report_date desc
          `,
          [from, to, REPORT_TIMEZONE]
        );

        const gamesMap = new Map<string, any>();

        for (const row of result.rows) {
          const gameId = row.game_id;
          let game = gamesMap.get(gameId);

          if (game === undefined) {
            game = {
              gameId,
              name: row.name,
              currentPrice: Number(row.current_price),
              consumptionAmount: 0,
              cashConsumed: 0,
              promotionalConsumed: 0,
              adminCreditConsumed: 0,
              legacyConsumed: 0,
              unclassifiedConsumed: 0,
              peopleCount: 0,
              operationsCount: 0,
              dailyBreakdown: [],
            };
            gamesMap.set(gameId, game);
          }

          const dailyAmount = Number(row.consumption_amount);
          const dailyCash = Number(row.cash_consumed);
          const dailyPromotional = Number(row.promotional_consumed);
          const dailyAdminCredit = Number(row.admin_credit_consumed);
          const dailyLegacy = Number(row.legacy_consumed);
          const dailyClassified =
            dailyCash + dailyPromotional + dailyAdminCredit + dailyLegacy;
          const dailyUnclassified = dailyAmount - dailyClassified;
          const dailyPeople = Number(row.people_count);
          const dailyOperations = Number(row.operations_count);

          game.consumptionAmount += dailyAmount;
          game.cashConsumed += dailyCash;
          game.promotionalConsumed += dailyPromotional;
          game.adminCreditConsumed += dailyAdminCredit;
          game.legacyConsumed += dailyLegacy;
          game.unclassifiedConsumed += dailyUnclassified;
          game.peopleCount += dailyPeople;
          game.operationsCount += dailyOperations;

          game.dailyBreakdown.push({
            date: row.report_date,
            consumptionAmount: dailyAmount,
            cashConsumed: dailyCash,
            promotionalConsumed: dailyPromotional,
            adminCreditConsumed: dailyAdminCredit,
            legacyConsumed: dailyLegacy,
            unclassifiedConsumed: dailyUnclassified,
            peopleCount: dailyPeople,
            operationsCount: dailyOperations,
          });
        }

        const games = Array.from(gamesMap.values()).sort((a: any, b: any) => {
          if (b.consumptionAmount !== a.consumptionAmount) {
            return b.consumptionAmount - a.consumptionAmount;
          }
          return a.name.localeCompare(b.name);
        });

        return { from, to, timezone: REPORT_TIMEZONE, games };
      } catch (error) {
        server.log.error(error);
        return reply.status(500).send({ error: "INTERNAL_ERROR" });
      } finally {
        client.release();
      }
    }
  );

  /*
   * =====================================================
   * JUEGO — DETALLE / AUDITORÍA WEB
   * =====================================================
   */
  server.get<{
    Params: { gameId: string };
    Querystring: WebReportQuery;
  }>(
    "/web/admin/reports/games/:gameId",
    async (request, reply) => {
      const webAdmin = await requireWebAdmin(request, reply);
      if (!webAdmin) return;

      const validation = validateReportQuery(request.query);
      if (!validation.ok) {
        return reply.status(validation.status).send(validation.body);
      }

      const gameId = request.params.gameId?.trim();
      if (!gameId) {
        return reply.status(400).send({ error: "INVALID_GAME_ID" });
      }

      const { from, to } = validation;
      const client = await db.connect();

      try {
        const gameResult = await client.query(
          `select id, name, price from games where id = $1 limit 1`,
          [gameId]
        );

        if (gameResult.rowCount === 0) {
          return reply.status(404).send({ error: "GAME_NOT_FOUND" });
        }

        const gameRow = gameResult.rows[0];
        const transactionsResult = await client.query(
          `
          with allocation_totals as (
            select
              a.transaction_id,
              coalesce(sum(a.amount) filter (where a.fund_type = 'CASH'), 0) as cash_consumed,
              coalesce(sum(a.amount) filter (where a.fund_type = 'PROMOTIONAL'), 0) as promotional_consumed,
              coalesce(sum(a.amount) filter (where a.fund_type = 'ADMIN_CREDIT'), 0) as admin_credit_consumed,
              coalesce(sum(a.amount) filter (where a.fund_type = 'LEGACY'), 0) as legacy_consumed
            from transaction_fund_allocations a
            group by a.transaction_id
          )
          select
            t.id,
            t.card_id,
            t.device_id,
            t.amount,
            t.quantity,
            t.unit_price,
            t.balance_before,
            t.balance_after,
            t.counter_before,
            t.counter_after,
            t.card_write_status,
            t.created_at,
            t.confirmed_at,
            coalesce(at.cash_consumed, 0) as cash_consumed,
            coalesce(at.promotional_consumed, 0) as promotional_consumed,
            coalesce(at.admin_credit_consumed, 0) as admin_credit_consumed,
            coalesce(at.legacy_consumed, 0) as legacy_consumed
          from transactions t
          left join allocation_totals at on at.transaction_id = t.id
          where t.game_id = $1
            and t.transaction_type = 'CHARGE'
            and t.card_write_status = 'CONFIRMED'
            and (
              coalesce(t.confirmed_at, t.created_at)
              at time zone $4
            )::date between $2::date and $3::date
          order by coalesce(t.confirmed_at, t.created_at) desc
          `,
          [gameId, from, to, REPORT_TIMEZONE]
        );

        let consumptionAmount = 0;
        let cashConsumed = 0;
        let promotionalConsumed = 0;
        let adminCreditConsumed = 0;
        let legacyConsumed = 0;
        let peopleCount = 0;
        const dailyMap = new Map<string, any>();

        const transactions = transactionsResult.rows.map((row: any) => {
          const amount = Number(row.amount);
          const cash = Number(row.cash_consumed);
          const promotional = Number(row.promotional_consumed);
          const adminCredit = Number(row.admin_credit_consumed);
          const legacy = Number(row.legacy_consumed);
          const classified = cash + promotional + adminCredit + legacy;
          const unclassified = amount - classified;
          const quantity = Number(row.quantity ?? 0);

          consumptionAmount += amount;
          cashConsumed += cash;
          promotionalConsumed += promotional;
          adminCreditConsumed += adminCredit;
          legacyConsumed += legacy;
          peopleCount += quantity;

          const operationDate = row.confirmed_at ?? row.created_at;
          const localDate = new Intl.DateTimeFormat("en-CA", {
            timeZone: REPORT_TIMEZONE,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
          }).format(new Date(operationDate));

          let daily = dailyMap.get(localDate);
          if (daily === undefined) {
            daily = {
              date: localDate,
              consumptionAmount: 0,
              cashConsumed: 0,
              promotionalConsumed: 0,
              adminCreditConsumed: 0,
              legacyConsumed: 0,
              unclassifiedConsumed: 0,
              peopleCount: 0,
              operationsCount: 0,
            };
            dailyMap.set(localDate, daily);
          }

          daily.consumptionAmount += amount;
          daily.cashConsumed += cash;
          daily.promotionalConsumed += promotional;
          daily.adminCreditConsumed += adminCredit;
          daily.legacyConsumed += legacy;
          daily.unclassifiedConsumed += unclassified;
          daily.peopleCount += quantity;
          daily.operationsCount += 1;

          return {
            transactionId: row.id,
            cardId: Number(row.card_id),
            deviceId: row.device_id,
            amount,
            quantity,
            unitPrice: row.unit_price === null ? null : Number(row.unit_price),
            balanceBefore: Number(row.balance_before),
            balanceAfter: Number(row.balance_after),
            counterBefore: Number(row.counter_before),
            counterAfter: Number(row.counter_after),
            status: row.card_write_status,
            createdAt: row.created_at,
            confirmedAt: row.confirmed_at,
            fundBreakdown: {
              cash,
              promotional,
              adminCredit,
              legacy,
              unclassified,
            },
          };
        });

        const dailyBreakdown = Array.from(dailyMap.values()).sort(
          (a: any, b: any) => a.date.localeCompare(b.date)
        );

        const classifiedConsumption =
          cashConsumed + promotionalConsumed + adminCreditConsumed + legacyConsumed;

        return {
          from,
          to,
          timezone: REPORT_TIMEZONE,
          game: {
            gameId: gameRow.id,
            name: gameRow.name,
            currentPrice: Number(gameRow.price),
          },
          summary: {
            consumptionAmount,
            cashConsumed,
            promotionalConsumed,
            adminCreditConsumed,
            legacyConsumed,
            unclassifiedConsumed: consumptionAmount - classifiedConsumption,
            peopleCount,
            operationsCount: transactions.length,
          },
          dailyBreakdown,
          transactions,
        };
      } catch (error: any) {
        if (error?.code === "22P02") {
          return reply.status(400).send({ error: "INVALID_GAME_ID" });
        }
        server.log.error(error);
        return reply.status(500).send({ error: "INTERNAL_ERROR" });
      } finally {
        client.release();
      }
    }
  );

  /*
   * =====================================================
   * TAQUILLAS — LISTADO / COMPARATIVA DIARIA
   * =====================================================
   *
   * Nuevo criterio financiero:
   * - checkout CONFIRMED manda para operaciones nuevas;
   * - CASH / CARD salen de payment_method;
   * - operaciones legacy sin checkout se conservan como
   *   ingreso no clasificado por método de pago;
   * - FAILED / PENDING / IN_PROGRESS / MANUAL_REVIEW_REQUIRED
   *   nunca se contabilizan como ingreso.
   * =====================================================
   */
  server.get<{ Querystring: WebReportQuery }>(
    "/web/admin/reports/recharge-points",
    async (request, reply) => {
      const webAdmin = await requireWebAdmin(request, reply);
      if (!webAdmin) return;

      const validation = validateReportQuery(request.query);
      if (!validation.ok) {
        return reply.status(validation.status).send(validation.body);
      }

      const { from, to } = validation;
      const client = await db.connect();

      try {
        const result = await client.query(
          `
          with confirmed_checkouts as (
            select
              rc.recharge_point_id,
              (rc.confirmed_at at time zone $3)::date as report_date,
              rc.payment_method,
              rc.paid_recharge_amount,
              rc.promotional_credit_amount,
              rc.credited_amount,
              rc.activation_fee_amount,
              rc.total_due_amount
            from recharge_checkouts rc
            where rc.status = 'CONFIRMED'
              and rc.actor_role = 'RECHARGE'
              and rc.recharge_point_id is not null
              and rc.confirmed_at is not null
              and (
                rc.confirmed_at at time zone $3
              )::date between $1::date and $2::date
          ),

          legacy_recharge_financials as (
            select
              t.id,
              t.recharge_point_id,
              (
                coalesce(t.confirmed_at, t.created_at)
                at time zone $3
              )::date as report_date,
              t.amount as credited_amount,
              case
                when exists (
                  select 1
                  from transaction_credit_components c0
                  where c0.transaction_id = t.id
                ) then coalesce((
                  select sum(c.amount)
                  from transaction_credit_components c
                  where c.transaction_id = t.id
                    and c.fund_type = 'CASH'
                ), 0)
                else t.amount
              end as paid_recharge_amount,
              case
                when exists (
                  select 1
                  from transaction_credit_components c0
                  where c0.transaction_id = t.id
                ) then coalesce((
                  select sum(c.amount)
                  from transaction_credit_components c
                  where c.transaction_id = t.id
                    and c.fund_type = 'PROMOTIONAL'
                ), 0)
                else 0
              end as promotional_given
            from transactions t
            where t.card_write_status = 'CONFIRMED'
              and t.transaction_type = 'RECHARGE'
              and t.recharge_point_id is not null
              and (
                coalesce(t.confirmed_at, t.created_at)
                at time zone $3
              )::date between $1::date and $2::date
              and not exists (
                select 1
                from recharge_checkouts rc
                where rc.recharge_transaction_id = t.id
              )
          ),

          legacy_activation_financials as (
            select
              t.recharge_point_id,
              (
                coalesce(t.confirmed_at, t.created_at)
                at time zone $3
              )::date as report_date,
              t.amount
            from transactions t
            where t.card_write_status = 'CONFIRMED'
              and t.transaction_type = 'CARD_CREATED'
              and t.recharge_point_id is not null
              and (
                coalesce(t.confirmed_at, t.created_at)
                at time zone $3
              )::date between $1::date and $2::date
              and not exists (
                select 1
                from recharge_checkouts rc
                where rc.activation_transaction_id = t.id
              )
          ),

          activation_counts as (
            select
              a.recharge_point_id,
              (
                a.started_at at time zone $3
              )::date as report_date,
              count(*)::bigint as activations_count
            from customer_card_activations a
            where a.activated_by_role = 'RECHARGE'
              and a.recharge_point_id is not null
              and (
                a.started_at at time zone $3
              )::date between $1::date and $2::date
            group by a.recharge_point_id, report_date
          ),

          return_financials as (
            select
              r.recharge_point_id,
              (
                r.returned_at at time zone $3
              )::date as report_date,
              r.refund_amount,
              r.discarded_cash,
              r.discarded_promotional,
              r.discarded_admin_credit,
              r.discarded_legacy,
              a.activated_by_role
            from customer_card_returns r
            join customer_card_activations a
              on a.id = r.activation_id
            where r.recharge_point_id is not null
              and (
                r.returned_at at time zone $3
              )::date between $1::date and $2::date
          ),

          daily as (
            select
              cc.recharge_point_id,
              cc.report_date,
              coalesce(sum(cc.total_due_amount) filter (
                where cc.payment_method = 'CASH'
              ), 0)::bigint as cash_received,
              coalesce(sum(cc.total_due_amount) filter (
                where cc.payment_method = 'CARD'
              ), 0)::bigint as card_received,
              coalesce(sum(cc.paid_recharge_amount) filter (
                where cc.payment_method = 'CASH'
              ), 0)::bigint as cash_recharge_amount,
              coalesce(sum(cc.paid_recharge_amount) filter (
                where cc.payment_method = 'CARD'
              ), 0)::bigint as card_recharge_amount,
              0::bigint as legacy_unclassified_received,
              coalesce(sum(cc.paid_recharge_amount), 0)::bigint as paid_recharge_amount,
              coalesce(sum(cc.promotional_credit_amount), 0)::bigint as promotional_given,
              coalesce(sum(cc.credited_amount), 0)::bigint as credited_amount,
              coalesce(sum(cc.activation_fee_amount), 0)::bigint as activation_amount,
              coalesce(sum(cc.total_due_amount), 0)::bigint as total_income_amount,
              0::bigint as refund_amount,
              0::bigint as discarded_cash,
              0::bigint as discarded_promotional,
              0::bigint as discarded_admin_credit,
              0::bigint as discarded_legacy,
              0::bigint as activations_count,
              0::bigint as returns_count,
              0::bigint as recharge_origin_returns_count,
              0::bigint as admin_origin_returns_count
            from confirmed_checkouts cc
            group by cc.recharge_point_id, cc.report_date

            union all

            select
              lr.recharge_point_id,
              lr.report_date,
              0::bigint as cash_received,
              0::bigint as card_received,
              0::bigint as cash_recharge_amount,
              0::bigint as card_recharge_amount,
              coalesce(sum(lr.paid_recharge_amount), 0)::bigint
                as legacy_unclassified_received,
              coalesce(sum(lr.paid_recharge_amount), 0)::bigint
                as paid_recharge_amount,
              coalesce(sum(lr.promotional_given), 0)::bigint
                as promotional_given,
              coalesce(sum(lr.credited_amount), 0)::bigint
                as credited_amount,
              0::bigint as activation_amount,
              coalesce(sum(lr.paid_recharge_amount), 0)::bigint
                as total_income_amount,
              0::bigint as refund_amount,
              0::bigint as discarded_cash,
              0::bigint as discarded_promotional,
              0::bigint as discarded_admin_credit,
              0::bigint as discarded_legacy,
              0::bigint as activations_count,
              0::bigint as returns_count,
              0::bigint as recharge_origin_returns_count,
              0::bigint as admin_origin_returns_count
            from legacy_recharge_financials lr
            group by lr.recharge_point_id, lr.report_date

            union all

            select
              la.recharge_point_id,
              la.report_date,
              0::bigint as cash_received,
              0::bigint as card_received,
              0::bigint as cash_recharge_amount,
              0::bigint as card_recharge_amount,
              coalesce(sum(la.amount), 0)::bigint
                as legacy_unclassified_received,
              0::bigint as paid_recharge_amount,
              0::bigint as promotional_given,
              0::bigint as credited_amount,
              coalesce(sum(la.amount), 0)::bigint as activation_amount,
              coalesce(sum(la.amount), 0)::bigint as total_income_amount,
              0::bigint as refund_amount,
              0::bigint as discarded_cash,
              0::bigint as discarded_promotional,
              0::bigint as discarded_admin_credit,
              0::bigint as discarded_legacy,
              0::bigint as activations_count,
              0::bigint as returns_count,
              0::bigint as recharge_origin_returns_count,
              0::bigint as admin_origin_returns_count
            from legacy_activation_financials la
            group by la.recharge_point_id, la.report_date

            union all

            select
              ac.recharge_point_id,
              ac.report_date,
              0::bigint as cash_received,
              0::bigint as card_received,
              0::bigint as cash_recharge_amount,
              0::bigint as card_recharge_amount,
              0::bigint as legacy_unclassified_received,
              0::bigint as paid_recharge_amount,
              0::bigint as promotional_given,
              0::bigint as credited_amount,
              0::bigint as activation_amount,
              0::bigint as total_income_amount,
              0::bigint as refund_amount,
              0::bigint as discarded_cash,
              0::bigint as discarded_promotional,
              0::bigint as discarded_admin_credit,
              0::bigint as discarded_legacy,
              ac.activations_count,
              0::bigint as returns_count,
              0::bigint as recharge_origin_returns_count,
              0::bigint as admin_origin_returns_count
            from activation_counts ac

            union all

            select
              rf.recharge_point_id,
              rf.report_date,
              0::bigint as cash_received,
              0::bigint as card_received,
              0::bigint as cash_recharge_amount,
              0::bigint as card_recharge_amount,
              0::bigint as legacy_unclassified_received,
              0::bigint as paid_recharge_amount,
              0::bigint as promotional_given,
              0::bigint as credited_amount,
              0::bigint as activation_amount,
              0::bigint as total_income_amount,
              coalesce(sum(rf.refund_amount), 0)::bigint as refund_amount,
              coalesce(sum(rf.discarded_cash), 0)::bigint as discarded_cash,
              coalesce(sum(rf.discarded_promotional), 0)::bigint
                as discarded_promotional,
              coalesce(sum(rf.discarded_admin_credit), 0)::bigint
                as discarded_admin_credit,
              coalesce(sum(rf.discarded_legacy), 0)::bigint
                as discarded_legacy,
              0::bigint as activations_count,
              count(*)::bigint as returns_count,
              count(*) filter (
                where rf.activated_by_role = 'RECHARGE'
              )::bigint as recharge_origin_returns_count,
              count(*) filter (
                where rf.activated_by_role = 'ADMIN'
              )::bigint as admin_origin_returns_count
            from return_financials rf
            group by rf.recharge_point_id, rf.report_date
          )

          select
            rp.id as recharge_point_id,
            rp.name,
            to_char(d.report_date, 'YYYY-MM-DD') as report_date,
            coalesce(sum(d.cash_received), 0) as cash_received,
            coalesce(sum(d.card_received), 0) as card_received,
            coalesce(sum(d.cash_recharge_amount), 0) as cash_recharge_amount,
            coalesce(sum(d.card_recharge_amount), 0) as card_recharge_amount,
            coalesce(sum(d.legacy_unclassified_received), 0)
              as legacy_unclassified_received,
            coalesce(sum(d.paid_recharge_amount), 0)
              as paid_recharge_amount,
            coalesce(sum(d.promotional_given), 0) as promotional_given,
            coalesce(sum(d.credited_amount), 0) as credited_amount,
            coalesce(sum(d.activation_amount), 0) as activation_amount,
            coalesce(sum(d.total_income_amount), 0) as total_income_amount,
            coalesce(sum(d.refund_amount), 0) as refund_amount,
            coalesce(sum(d.discarded_cash), 0) as discarded_cash,
            coalesce(sum(d.discarded_promotional), 0) as discarded_promotional,
            coalesce(sum(d.discarded_admin_credit), 0) as discarded_admin_credit,
            coalesce(sum(d.discarded_legacy), 0) as discarded_legacy,
            coalesce(sum(d.activations_count), 0) as activations_count,
            coalesce(sum(d.returns_count), 0) as returns_count,
            coalesce(sum(d.recharge_origin_returns_count), 0)
              as recharge_origin_returns_count,
            coalesce(sum(d.admin_origin_returns_count), 0)
              as admin_origin_returns_count
          from daily d
          join recharge_points rp
            on rp.id = d.recharge_point_id
          group by rp.id, rp.name, d.report_date
          order by rp.name asc, d.report_date desc
          `,
          [from, to, REPORT_TIMEZONE]
        );

        const rechargePointsMap = new Map<string, any>();

        for (const row of result.rows) {
          const rechargePointId = row.recharge_point_id;
          let point = rechargePointsMap.get(rechargePointId);

          if (point === undefined) {
            point = {
              rechargePointId,
              name: row.name,

              cashReceived: 0,
              cardReceived: 0,
              cashRechargeAmount: 0,
              cardRechargeAmount: 0,
              legacyUnclassifiedReceived: 0,
              paidRechargeAmount: 0,
              promotionalGiven: 0,
              creditedAmount: 0,
              activationAmount: 0,
              totalIncomeAmount: 0,

              cardRefundAmount: 0,
              discardedCash: 0,
              discardedPromotional: 0,
              discardedAdminCredit: 0,
              discardedLegacy: 0,
              discardedTotal: 0,
              activationsCount: 0,
              returnsCount: 0,
              rechargeOriginReturnsCount: 0,
              adminOriginReturnsCount: 0,

              /*
               * Compatibilidad con UI anterior:
               * rechargedAmount = recargas pagadas.
               */
              rechargedAmount: 0,
              dailyBreakdown: [],
            };

            rechargePointsMap.set(rechargePointId, point);
          }

          const dailyCash = Number(row.cash_received);
          const dailyCard = Number(row.card_received);
          const dailyCashRecharge = Number(row.cash_recharge_amount);
          const dailyCardRecharge = Number(row.card_recharge_amount);
          const dailyLegacyUnclassified =
            Number(row.legacy_unclassified_received);
          const dailyPaidRecharge = Number(row.paid_recharge_amount);
          const dailyPromotional = Number(row.promotional_given);
          const dailyCredited = Number(row.credited_amount);
          const dailyActivation = Number(row.activation_amount);
          const dailyIncome = Number(row.total_income_amount);

          const dailyRefund = Number(row.refund_amount);
          const dailyDiscardedCash = Number(row.discarded_cash);
          const dailyDiscardedPromotional =
            Number(row.discarded_promotional);
          const dailyDiscardedAdminCredit =
            Number(row.discarded_admin_credit);
          const dailyDiscardedLegacy =
            Number(row.discarded_legacy);
          const dailyDiscardedTotal =
            dailyDiscardedCash +
            dailyDiscardedPromotional +
            dailyDiscardedAdminCredit +
            dailyDiscardedLegacy;
          const dailyActivationsCount = Number(row.activations_count);
          const dailyReturnsCount = Number(row.returns_count);
          const dailyRechargeOriginReturnsCount =
            Number(row.recharge_origin_returns_count);
          const dailyAdminOriginReturnsCount =
            Number(row.admin_origin_returns_count);

          point.cashReceived += dailyCash;
          point.cardReceived += dailyCard;
          point.cashRechargeAmount += dailyCashRecharge;
          point.cardRechargeAmount += dailyCardRecharge;
          point.legacyUnclassifiedReceived += dailyLegacyUnclassified;
          point.paidRechargeAmount += dailyPaidRecharge;
          point.promotionalGiven += dailyPromotional;
          point.creditedAmount += dailyCredited;
          point.activationAmount += dailyActivation;
          point.totalIncomeAmount += dailyIncome;

          point.cardRefundAmount += dailyRefund;
          point.discardedCash += dailyDiscardedCash;
          point.discardedPromotional += dailyDiscardedPromotional;
          point.discardedAdminCredit += dailyDiscardedAdminCredit;
          point.discardedLegacy += dailyDiscardedLegacy;
          point.discardedTotal += dailyDiscardedTotal;
          point.activationsCount += dailyActivationsCount;
          point.returnsCount += dailyReturnsCount;
          point.rechargeOriginReturnsCount += dailyRechargeOriginReturnsCount;
          point.adminOriginReturnsCount += dailyAdminOriginReturnsCount;

          point.rechargedAmount += dailyPaidRecharge;

          point.dailyBreakdown.push({
            date: row.report_date,

            cashReceived: dailyCash,
            cardReceived: dailyCard,
            cashRechargeAmount: dailyCashRecharge,
            cardRechargeAmount: dailyCardRecharge,
            legacyUnclassifiedReceived: dailyLegacyUnclassified,
            paidRechargeAmount: dailyPaidRecharge,
            promotionalGiven: dailyPromotional,
            creditedAmount: dailyCredited,
            activationAmount: dailyActivation,
            totalIncomeAmount: dailyIncome,

            cardRefundAmount: dailyRefund,
            discardedCash: dailyDiscardedCash,
            discardedPromotional: dailyDiscardedPromotional,
            discardedAdminCredit: dailyDiscardedAdminCredit,
            discardedLegacy: dailyDiscardedLegacy,
            discardedTotal: dailyDiscardedTotal,
            activationsCount: dailyActivationsCount,
            returnsCount: dailyReturnsCount,
            rechargeOriginReturnsCount: dailyRechargeOriginReturnsCount,
            adminOriginReturnsCount: dailyAdminOriginReturnsCount,

            /* Compatibilidad con gráficas actuales. */
            rechargedAmount: dailyPaidRecharge,
          });
        }

        const rechargePoints = Array.from(rechargePointsMap.values()).sort(
          (a: any, b: any) => {
            if (b.totalIncomeAmount !== a.totalIncomeAmount) {
              return b.totalIncomeAmount - a.totalIncomeAmount;
            }
            return a.name.localeCompare(b.name);
          }
        );

        return { from, to, timezone: REPORT_TIMEZONE, rechargePoints };
      } catch (error) {
        server.log.error(error);
        return reply.status(500).send({ error: "INTERNAL_ERROR" });
      } finally {
        client.release();
      }
    }
  );

  /*
   * =====================================================
   * TAQUILLA — DETALLE / AUDITORÍA WEB
   * =====================================================
   *
   * La vista de detalle usa checkout CONFIRMED como fuente
   * de verdad para ingreso físico moderno. Las transacciones
   * legacy sin checkout siguen visibles y se reportan como
   * ingreso no clasificado por método de pago.
   * =====================================================
   */
  server.get<{
    Params: { rechargePointId: string };
    Querystring: WebReportQuery;
  }>(
    "/web/admin/reports/recharge-points/:rechargePointId",
    async (request, reply) => {
      const webAdmin = await requireWebAdmin(request, reply);
      if (!webAdmin) return;

      const validation = validateReportQuery(request.query);
      if (!validation.ok) {
        return reply.status(validation.status).send(validation.body);
      }

      const rechargePointId = request.params.rechargePointId?.trim();
      if (!rechargePointId) {
        return reply.status(400).send({ error: "INVALID_RECHARGE_POINT_ID" });
      }

      const { from, to } = validation;
      const client = await db.connect();

      try {
        const pointResult = await client.query(
          `select id, name from recharge_points where id = $1 limit 1`,
          [rechargePointId]
        );

        if (pointResult.rowCount === 0) {
          return reply.status(404).send({ error: "RECHARGE_POINT_NOT_FOUND" });
        }

        const pointRow = pointResult.rows[0];

        /*
         * -----------------------------------------------------
         * Auditoría de recargas confirmadas.
         * -----------------------------------------------------
         *
         * Se conserva una fila por RECHARGE para la UI de
         * historial/auditoría, pero la clasificación CASH/CARD
         * viene del checkout cuando existe.
         */
        const transactionsResult = await client.query(
          `
          with credit_totals as (
            select
              c.transaction_id,
              coalesce(sum(c.amount) filter (where c.fund_type = 'CASH'), 0)
                as ledger_cash_amount,
              coalesce(sum(c.amount) filter (where c.fund_type = 'PROMOTIONAL'), 0)
                as promotional_amount,
              coalesce(sum(c.amount) filter (where c.fund_type = 'ADMIN_CREDIT'), 0)
                as admin_credit_amount,
              count(*) as component_count
            from transaction_credit_components c
            group by c.transaction_id
          )

          select
            t.id,
            t.card_id,
            t.device_id,
            t.amount,
            t.balance_before,
            t.balance_after,
            t.counter_before,
            t.counter_after,
            t.card_write_status,
            t.promotion_id,
            p.name as promotion_name,
            p.cash_amount as promotion_cash_amount,
            p.promotional_amount as promotion_promotional_amount,
            p.total_credit_amount as promotion_total_credit_amount,
            t.created_at,
            t.confirmed_at,

            rc.id as checkout_id,
            rc.card_path,
            rc.payment_method,
            rc.status as checkout_status,
            rc.paid_recharge_amount as checkout_paid_recharge_amount,
            rc.promotional_credit_amount as checkout_promotional_amount,
            rc.credited_amount as checkout_credited_amount,
            rc.activation_fee_amount as checkout_activation_fee_amount,
            rc.total_due_amount as checkout_total_due_amount,

            case
              when rc.id is not null
              then rc.paid_recharge_amount
              when coalesce(ct.component_count, 0) > 0
              then coalesce(ct.ledger_cash_amount, 0)
              else t.amount
            end as paid_recharge_amount,

            case
              when rc.id is not null
              then rc.promotional_credit_amount
              when coalesce(ct.component_count, 0) > 0
              then coalesce(ct.promotional_amount, 0)
              else 0
            end as promotional_given,

            case
              when rc.id is not null and rc.payment_method = 'CASH'
              then rc.total_due_amount
              else 0
            end as cash_received,

            case
              when rc.id is not null and rc.payment_method = 'CARD'
              then rc.total_due_amount
              else 0
            end as card_received,

            case
              when rc.id is null
              then
                case
                  when coalesce(ct.component_count, 0) > 0
                  then coalesce(ct.ledger_cash_amount, 0)
                  else t.amount
                end
              else 0
            end as legacy_unclassified_received,

            coalesce(ct.admin_credit_amount, 0) as admin_credit_amount

          from transactions t
          left join credit_totals ct
            on ct.transaction_id = t.id
          left join promotions p
            on p.id = t.promotion_id
          left join recharge_checkouts rc
            on rc.recharge_transaction_id = t.id

          where t.recharge_point_id = $1
            and t.transaction_type = 'RECHARGE'
            and t.card_write_status = 'CONFIRMED'
            and t.confirmed_at is not null
            and (
              t.confirmed_at at time zone $4
            )::date between $2::date and $3::date

          order by t.confirmed_at desc
          `,
          [rechargePointId, from, to, REPORT_TIMEZONE]
        );

        /*
         * -----------------------------------------------------
         * Resumen financiero diario de la taquilla.
         * -----------------------------------------------------
         */
        const financialResult = await client.query(
          `
          with confirmed_checkouts as (
            select
              (rc.confirmed_at at time zone $4)::date as report_date,
              rc.payment_method,
              rc.paid_recharge_amount,
              rc.promotional_credit_amount,
              rc.credited_amount,
              rc.activation_fee_amount,
              rc.total_due_amount
            from recharge_checkouts rc
            where rc.recharge_point_id = $1
              and rc.actor_role = 'RECHARGE'
              and rc.status = 'CONFIRMED'
              and rc.confirmed_at is not null
              and (
                rc.confirmed_at at time zone $4
              )::date between $2::date and $3::date
          ),

          legacy_recharges as (
            select
              t.id,
              (
                coalesce(t.confirmed_at, t.created_at)
                at time zone $4
              )::date as report_date,
              t.amount as credited_amount,
              case
                when exists (
                  select 1
                  from transaction_credit_components c0
                  where c0.transaction_id = t.id
                ) then coalesce((
                  select sum(c.amount)
                  from transaction_credit_components c
                  where c.transaction_id = t.id
                    and c.fund_type = 'CASH'
                ), 0)
                else t.amount
              end as paid_recharge_amount,
              case
                when exists (
                  select 1
                  from transaction_credit_components c0
                  where c0.transaction_id = t.id
                ) then coalesce((
                  select sum(c.amount)
                  from transaction_credit_components c
                  where c.transaction_id = t.id
                    and c.fund_type = 'PROMOTIONAL'
                ), 0)
                else 0
              end as promotional_given
            from transactions t
            where t.recharge_point_id = $1
              and t.transaction_type = 'RECHARGE'
              and t.card_write_status = 'CONFIRMED'
              and (
                coalesce(t.confirmed_at, t.created_at)
                at time zone $4
              )::date between $2::date and $3::date
              and not exists (
                select 1
                from recharge_checkouts rc
                where rc.recharge_transaction_id = t.id
              )
          ),

          legacy_activations as (
            select
              (
                coalesce(t.confirmed_at, t.created_at)
                at time zone $4
              )::date as report_date,
              t.amount
            from transactions t
            where t.recharge_point_id = $1
              and t.transaction_type = 'CARD_CREATED'
              and t.card_write_status = 'CONFIRMED'
              and (
                coalesce(t.confirmed_at, t.created_at)
                at time zone $4
              )::date between $2::date and $3::date
              and not exists (
                select 1
                from recharge_checkouts rc
                where rc.activation_transaction_id = t.id
              )
          ),

          activation_counts as (
            select
              (
                a.started_at at time zone $4
              )::date as report_date,
              count(*)::bigint as activations_count
            from customer_card_activations a
            where a.activated_by_role = 'RECHARGE'
              and a.recharge_point_id = $1
              and (
                a.started_at at time zone $4
              )::date between $2::date and $3::date
            group by report_date
          ),

          returns as (
            select
              (
                r.returned_at at time zone $4
              )::date as report_date,
              r.refund_amount,
              r.discarded_cash,
              r.discarded_promotional,
              r.discarded_admin_credit,
              r.discarded_legacy,
              a.activated_by_role
            from customer_card_returns r
            join customer_card_activations a
              on a.id = r.activation_id
            where r.recharge_point_id = $1
              and (
                r.returned_at at time zone $4
              )::date between $2::date and $3::date
          ),

          daily as (
            select
              cc.report_date,
              coalesce(sum(cc.total_due_amount) filter (
                where cc.payment_method = 'CASH'
              ), 0)::bigint as cash_received,
              coalesce(sum(cc.total_due_amount) filter (
                where cc.payment_method = 'CARD'
              ), 0)::bigint as card_received,
              coalesce(sum(cc.paid_recharge_amount) filter (
                where cc.payment_method = 'CASH'
              ), 0)::bigint as cash_recharge_amount,
              coalesce(sum(cc.paid_recharge_amount) filter (
                where cc.payment_method = 'CARD'
              ), 0)::bigint as card_recharge_amount,
              0::bigint as legacy_unclassified_received,
              coalesce(sum(cc.paid_recharge_amount), 0)::bigint
                as paid_recharge_amount,
              coalesce(sum(cc.promotional_credit_amount), 0)::bigint
                as promotional_given,
              coalesce(sum(cc.credited_amount), 0)::bigint
                as credited_amount,
              coalesce(sum(cc.activation_fee_amount), 0)::bigint
                as activation_amount,
              coalesce(sum(cc.total_due_amount), 0)::bigint
                as total_income_amount,
              count(*)::bigint as operations_count,
              0::bigint as card_refund_amount,
              0::bigint as discarded_cash,
              0::bigint as discarded_promotional,
              0::bigint as discarded_admin_credit,
              0::bigint as discarded_legacy,
              0::bigint as activations_count,
              0::bigint as returns_count,
              0::bigint as recharge_origin_returns_count,
              0::bigint as admin_origin_returns_count
            from confirmed_checkouts cc
            group by cc.report_date

            union all

            select
              lr.report_date,
              0::bigint as cash_received,
              0::bigint as card_received,
              0::bigint as cash_recharge_amount,
              0::bigint as card_recharge_amount,
              coalesce(sum(lr.paid_recharge_amount), 0)::bigint
                as legacy_unclassified_received,
              coalesce(sum(lr.paid_recharge_amount), 0)::bigint
                as paid_recharge_amount,
              coalesce(sum(lr.promotional_given), 0)::bigint
                as promotional_given,
              coalesce(sum(lr.credited_amount), 0)::bigint
                as credited_amount,
              0::bigint as activation_amount,
              coalesce(sum(lr.paid_recharge_amount), 0)::bigint
                as total_income_amount,
              count(*)::bigint as operations_count,
              0::bigint as card_refund_amount,
              0::bigint as discarded_cash,
              0::bigint as discarded_promotional,
              0::bigint as discarded_admin_credit,
              0::bigint as discarded_legacy,
              0::bigint as activations_count,
              0::bigint as returns_count,
              0::bigint as recharge_origin_returns_count,
              0::bigint as admin_origin_returns_count
            from legacy_recharges lr
            group by lr.report_date

            union all

            select
              la.report_date,
              0::bigint as cash_received,
              0::bigint as card_received,
              0::bigint as cash_recharge_amount,
              0::bigint as card_recharge_amount,
              coalesce(sum(la.amount), 0)::bigint
                as legacy_unclassified_received,
              0::bigint as paid_recharge_amount,
              0::bigint as promotional_given,
              0::bigint as credited_amount,
              coalesce(sum(la.amount), 0)::bigint as activation_amount,
              coalesce(sum(la.amount), 0)::bigint as total_income_amount,
              0::bigint as operations_count,
              0::bigint as card_refund_amount,
              0::bigint as discarded_cash,
              0::bigint as discarded_promotional,
              0::bigint as discarded_admin_credit,
              0::bigint as discarded_legacy,
              0::bigint as activations_count,
              0::bigint as returns_count,
              0::bigint as recharge_origin_returns_count,
              0::bigint as admin_origin_returns_count
            from legacy_activations la
            group by la.report_date

            union all

            select
              ac.report_date,
              0::bigint as cash_received,
              0::bigint as card_received,
              0::bigint as cash_recharge_amount,
              0::bigint as card_recharge_amount,
              0::bigint as legacy_unclassified_received,
              0::bigint as paid_recharge_amount,
              0::bigint as promotional_given,
              0::bigint as credited_amount,
              0::bigint as activation_amount,
              0::bigint as total_income_amount,
              0::bigint as operations_count,
              0::bigint as card_refund_amount,
              0::bigint as discarded_cash,
              0::bigint as discarded_promotional,
              0::bigint as discarded_admin_credit,
              0::bigint as discarded_legacy,
              ac.activations_count,
              0::bigint as returns_count,
              0::bigint as recharge_origin_returns_count,
              0::bigint as admin_origin_returns_count
            from activation_counts ac

            union all

            select
              r.report_date,
              0::bigint as cash_received,
              0::bigint as card_received,
              0::bigint as cash_recharge_amount,
              0::bigint as card_recharge_amount,
              0::bigint as legacy_unclassified_received,
              0::bigint as paid_recharge_amount,
              0::bigint as promotional_given,
              0::bigint as credited_amount,
              0::bigint as activation_amount,
              0::bigint as total_income_amount,
              0::bigint as operations_count,
              coalesce(sum(r.refund_amount), 0)::bigint
                as card_refund_amount,
              coalesce(sum(r.discarded_cash), 0)::bigint
                as discarded_cash,
              coalesce(sum(r.discarded_promotional), 0)::bigint
                as discarded_promotional,
              coalesce(sum(r.discarded_admin_credit), 0)::bigint
                as discarded_admin_credit,
              coalesce(sum(r.discarded_legacy), 0)::bigint
                as discarded_legacy,
              0::bigint as activations_count,
              count(*)::bigint as returns_count,
              count(*) filter (
                where r.activated_by_role = 'RECHARGE'
              )::bigint as recharge_origin_returns_count,
              count(*) filter (
                where r.activated_by_role = 'ADMIN'
              )::bigint as admin_origin_returns_count
            from returns r
            group by r.report_date
          )

          select
            to_char(d.report_date, 'YYYY-MM-DD') as report_date,
            coalesce(sum(d.cash_received), 0) as cash_received,
            coalesce(sum(d.card_received), 0) as card_received,
            coalesce(sum(d.cash_recharge_amount), 0) as cash_recharge_amount,
            coalesce(sum(d.card_recharge_amount), 0) as card_recharge_amount,
            coalesce(sum(d.legacy_unclassified_received), 0)
              as legacy_unclassified_received,
            coalesce(sum(d.paid_recharge_amount), 0)
              as paid_recharge_amount,
            coalesce(sum(d.promotional_given), 0) as promotional_given,
            coalesce(sum(d.credited_amount), 0) as credited_amount,
            coalesce(sum(d.activation_amount), 0) as activation_amount,
            coalesce(sum(d.total_income_amount), 0) as total_income_amount,
            coalesce(sum(d.operations_count), 0) as operations_count,
            coalesce(sum(d.card_refund_amount), 0) as card_refund_amount,
            coalesce(sum(d.discarded_cash), 0) as discarded_cash,
            coalesce(sum(d.discarded_promotional), 0)
              as discarded_promotional,
            coalesce(sum(d.discarded_admin_credit), 0)
              as discarded_admin_credit,
            coalesce(sum(d.discarded_legacy), 0) as discarded_legacy,
            coalesce(sum(d.activations_count), 0) as activations_count,
            coalesce(sum(d.returns_count), 0) as returns_count,
            coalesce(sum(d.recharge_origin_returns_count), 0)
              as recharge_origin_returns_count,
            coalesce(sum(d.admin_origin_returns_count), 0)
              as admin_origin_returns_count
          from daily d
          group by d.report_date
          order by d.report_date asc
          `,
          [rechargePointId, from, to, REPORT_TIMEZONE]
        );

        let cashReceived = 0;
        let cardReceived = 0;
        let cashRechargeAmount = 0;
        let cardRechargeAmount = 0;
        let legacyUnclassifiedReceived = 0;
        let paidRechargeAmount = 0;
        let promotionalGiven = 0;
        let creditedAmount = 0;
        let activationAmount = 0;
        let totalIncomeAmount = 0;
        let operationsCount = 0;

        let cardRefundAmount = 0;
        let discardedCash = 0;
        let discardedPromotional = 0;
        let discardedAdminCredit = 0;
        let discardedLegacy = 0;
        let activationsCount = 0;
        let returnsCount = 0;
        let rechargeOriginReturnsCount = 0;
        let adminOriginReturnsCount = 0;

        const dailyBreakdown = financialResult.rows.map((row: any) => {
          const dailyCash = Number(row.cash_received);
          const dailyCard = Number(row.card_received);
          const dailyCashRecharge = Number(row.cash_recharge_amount);
          const dailyCardRecharge = Number(row.card_recharge_amount);
          const dailyLegacyUnclassified =
            Number(row.legacy_unclassified_received);
          const dailyPaidRecharge = Number(row.paid_recharge_amount);
          const dailyPromotional = Number(row.promotional_given);
          const dailyCredited = Number(row.credited_amount);
          const dailyActivation = Number(row.activation_amount);
          const dailyIncome = Number(row.total_income_amount);
          const dailyOperations = Number(row.operations_count);

          const dailyRefund = Number(row.card_refund_amount);
          const dailyDiscardedCash = Number(row.discarded_cash);
          const dailyDiscardedPromotional =
            Number(row.discarded_promotional);
          const dailyDiscardedAdminCredit =
            Number(row.discarded_admin_credit);
          const dailyDiscardedLegacy =
            Number(row.discarded_legacy);
          const dailyDiscardedTotal =
            dailyDiscardedCash +
            dailyDiscardedPromotional +
            dailyDiscardedAdminCredit +
            dailyDiscardedLegacy;
          const dailyActivationsCount = Number(row.activations_count);
          const dailyReturnsCount = Number(row.returns_count);
          const dailyRechargeOriginReturnsCount =
            Number(row.recharge_origin_returns_count);
          const dailyAdminOriginReturnsCount =
            Number(row.admin_origin_returns_count);

          cashReceived += dailyCash;
          cardReceived += dailyCard;
          cashRechargeAmount += dailyCashRecharge;
          cardRechargeAmount += dailyCardRecharge;
          legacyUnclassifiedReceived += dailyLegacyUnclassified;
          paidRechargeAmount += dailyPaidRecharge;
          promotionalGiven += dailyPromotional;
          creditedAmount += dailyCredited;
          activationAmount += dailyActivation;
          totalIncomeAmount += dailyIncome;
          operationsCount += dailyOperations;

          cardRefundAmount += dailyRefund;
          discardedCash += dailyDiscardedCash;
          discardedPromotional += dailyDiscardedPromotional;
          discardedAdminCredit += dailyDiscardedAdminCredit;
          discardedLegacy += dailyDiscardedLegacy;
          activationsCount += dailyActivationsCount;
          returnsCount += dailyReturnsCount;
          rechargeOriginReturnsCount += dailyRechargeOriginReturnsCount;
          adminOriginReturnsCount += dailyAdminOriginReturnsCount;

          return {
            date: row.report_date,

            cashReceived: dailyCash,
            cardReceived: dailyCard,
            cashRechargeAmount: dailyCashRecharge,
            cardRechargeAmount: dailyCardRecharge,
            legacyUnclassifiedReceived: dailyLegacyUnclassified,
            paidRechargeAmount: dailyPaidRecharge,
            promotionalGiven: dailyPromotional,
            creditedAmount: dailyCredited,
            activationAmount: dailyActivation,
            totalIncomeAmount: dailyIncome,
            operationsCount: dailyOperations,

            cardRefundAmount: dailyRefund,
            discardedCash: dailyDiscardedCash,
            discardedPromotional: dailyDiscardedPromotional,
            discardedAdminCredit: dailyDiscardedAdminCredit,
            discardedLegacy: dailyDiscardedLegacy,
            discardedTotal: dailyDiscardedTotal,
            activationsCount: dailyActivationsCount,
            returnsCount: dailyReturnsCount,
            rechargeOriginReturnsCount: dailyRechargeOriginReturnsCount,
            adminOriginReturnsCount: dailyAdminOriginReturnsCount,
          };
        });

        const transactions = transactionsResult.rows.map((row: any) => {
          const checkoutId =
            row.checkout_id === null ? null : String(row.checkout_id);
          const paid = Number(row.paid_recharge_amount);
          const promotional = Number(row.promotional_given);
          const credited = Number(row.amount);
          const cash = Number(row.cash_received);
          const card = Number(row.card_received);
          const legacy = Number(row.legacy_unclassified_received);

          return {
            transactionId: row.id,
            cardId: Number(row.card_id),
            deviceId: row.device_id,

            checkoutId,
            cardPath: row.card_path,
            paymentMethod: row.payment_method,
            checkoutStatus: row.checkout_status,

            paidRechargeAmount: paid,
            creditedAmount: credited,
            cashReceived: cash,
            cardReceived: card,
            legacyUnclassifiedReceived: legacy,
            promotionalGiven: promotional,
            activationFeeAmount:
              row.checkout_activation_fee_amount === null
                ? 0
                : Number(row.checkout_activation_fee_amount),
            totalDueAmount:
              row.checkout_total_due_amount === null
                ? paid
                : Number(row.checkout_total_due_amount),

            adminCreditAmount: Number(row.admin_credit_amount),
            balanceBefore: Number(row.balance_before),
            balanceAfter: Number(row.balance_after),
            counterBefore: Number(row.counter_before),
            counterAfter: Number(row.counter_after),
            status: row.card_write_status,

            promotion:
              row.promotion_id === null
                ? null
                : {
                    promotionId: row.promotion_id,
                    name: row.promotion_name,
                    cashAmount: Number(row.promotion_cash_amount),
                    promotionalAmount: Number(row.promotion_promotional_amount),
                    creditedAmount: Number(row.promotion_total_credit_amount),
                  },

            createdAt: row.created_at,
            confirmedAt: row.confirmed_at,
          };
        });

        return {
          from,
          to,
          timezone: REPORT_TIMEZONE,
          rechargePoint: {
            rechargePointId: pointRow.id,
            name: pointRow.name,
          },
          summary: {
            cashReceived,
            cardReceived,
            cashRechargeAmount,
            cardRechargeAmount,
            legacyUnclassifiedReceived,
            paidRechargeAmount,
            promotionalGiven,
            creditedAmount,
            activationAmount,
            totalIncomeAmount,

            cardRefundAmount,
            discardedCash,
            discardedPromotional,
            discardedAdminCredit,
            discardedLegacy,
            discardedTotal:
              discardedCash +
              discardedPromotional +
              discardedAdminCredit +
              discardedLegacy,
            activationsCount,
            returnsCount,
            rechargeOriginReturnsCount,
            adminOriginReturnsCount,

            operationsCount,
          },
          dailyBreakdown,
          transactions,
        };
      } catch (error: any) {
        if (error?.code === "22P02") {
          return reply.status(400).send({ error: "INVALID_RECHARGE_POINT_ID" });
        }

        server.log.error(error);
        return reply.status(500).send({ error: "INTERNAL_ERROR" });
      } finally {
        client.release();
      }
    }
  );

  /*
   * =====================================================
   * REPORTE POR DISPOSITIVO
   * =====================================================
   *
   * GET /web/admin/reports/devices
   *
   * Devuelve el tiempo total que cada Ulefone pasó con
   * una sesión GAME, RECHARGE o ADMIN dentro del rango.
   * No expone "# de operaciones" como métrica.
   * =====================================================
   */
  server.get<{ Querystring: WebReportQuery }>(
    "/web/admin/reports/devices",
    async (request, reply) => {
      const webAdmin =
        await requireWebAdmin(
          request,
          reply
        );

      if (!webAdmin) {
        return;
      }

      const validation = validateReportQuery(request.query);

      if (!validation.ok) {
        return reply.status(validation.status).send(validation.body);
      }

      const { from, to } = validation;
      const client = await db.connect();

      try {

        const result = await client.query(
          `
          with bounds as (
            select
              ($1::date::timestamp at time zone $3) as range_start,
              (($2::date + 1)::timestamp at time zone $3) as range_end
          ),

          all_sessions as (
            select
              s.device_id,
              s.started_at,
              s.ended_at
            from device_game_sessions s

            union all

            select
              s.device_id,
              s.started_at,
              s.ended_at
            from device_recharge_sessions s

            union all

            select
              s.device_id,
              s.started_at,
              s.ended_at
            from device_admin_sessions s
          ),

          device_time as (
            select
              s.device_id,

              coalesce(
                sum(
                  greatest(
                    0,
                    extract(
                      epoch from (
                        least(
                          coalesce(s.ended_at, now()),
                          b.range_end
                        )
                        -
                        greatest(
                          s.started_at,
                          b.range_start
                        )
                      )
                    )
                  )
                ),
                0
              )::bigint as session_seconds

            from all_sessions s
            cross join bounds b

            where s.started_at < b.range_end
              and coalesce(s.ended_at, now()) > b.range_start

            group by s.device_id
          )

          select
            d.id as device_id,
            d.device_code,
            d.name,
            d.status,
            coalesce(dt.session_seconds, 0) as session_seconds

          from devices d

          left join device_time dt
            on dt.device_id = d.id

          where d.status <> 'INACTIVE'
             or coalesce(dt.session_seconds, 0) > 0

          order by
            coalesce(dt.session_seconds, 0) desc,
            d.name asc
          `,
          [from, to, REPORT_TIMEZONE]
        );


        return {
          from,
          to,
          timezone: REPORT_TIMEZONE,
          devices: result.rows.map((row: any) => ({
            deviceId: row.device_id,
            code: row.device_code,
            name: row.name,
            status: row.status,
            sessionSeconds: Number(row.session_seconds),
          })),
        };
      } catch (error) {
        server.log.error(error);
        return reply.status(500).send({ error: "INTERNAL_ERROR" });
      } finally {
        client.release();
      }
    }
  );


  /*
   * =====================================================
   * HISTORIAL DETALLADO DE DISPOSITIVO
   * =====================================================
   *
   * GET /web/admin/reports/devices/:deviceId/history
   *
   * Reconstruye cada sesión del dispositivo:
   * - GAME
   * - RECHARGE (TAQUILLA)
   * - ADMIN
   *
   * Para GAME agrega personas y consumo del intervalo.
   * Para TAQUILLA agrega total recargado del intervalo.
   * Para ADMIN agrega recargas y saldo retirado.
   * =====================================================
   */
  server.get<{
    Params: {
      deviceId: string;
    };
    Querystring: WebReportQuery;
  }>(
    "/web/admin/reports/devices/:deviceId/history",
    async (request, reply) => {
      const webAdmin =
        await requireWebAdmin(
          request,
          reply
        );

      if (!webAdmin) {
        return;
      }

      const validation = validateReportQuery(request.query);

      if (!validation.ok) {
        return reply.status(validation.status).send(validation.body);
      }

      const { from, to } = validation;
      const deviceId = request.params.deviceId?.trim();

      if (!deviceId) {
        return reply.status(400).send({
          error: "INVALID_DEVICE_ID",
          message: "El dispositivo no tiene un ID válido.",
        });
      }

      const client = await db.connect();

      try {

        const deviceResult = await client.query(
          `
          select
            id,
            device_code,
            name,
            status
          from devices
          where id = $1
          limit 1
          `,
          [deviceId]
        );

        if (deviceResult.rowCount === 0) {
          return reply.status(404).send({
            error: "DEVICE_NOT_FOUND",
            message: "No se encontró el dispositivo.",
          });
        }

        const sessionsResult = await client.query(
          `
          with bounds as (
            select
              ($2::date::timestamp at time zone $4) as range_start,
              (($3::date + 1)::timestamp at time zone $4) as range_end
          ),

          sessions as (
            select
              s.id as session_id,
              'GAME'::text as mode,
              s.device_id,
              s.started_at,
              s.ended_at,
              s.status,
              s.opened_by_card_id,
              g.id as game_id,
              g.name as game_name,
              null::uuid as recharge_point_id,
              null::text as recharge_point_name,
              null::bigint as admin_card_id
            from device_game_sessions s
            join games g
              on g.id = s.game_id
            where s.device_id = $1

            union all

            select
              s.id as session_id,
              'RECHARGE'::text as mode,
              s.device_id,
              s.started_at,
              s.ended_at,
              s.status,
              s.opened_by_card_id,
              null::uuid as game_id,
              null::text as game_name,
              rp.id as recharge_point_id,
              rp.name as recharge_point_name,
              null::bigint as admin_card_id
            from device_recharge_sessions s
            join recharge_points rp
              on rp.id = s.recharge_point_id
            where s.device_id = $1

            union all

            select
              s.id as session_id,
              'ADMIN'::text as mode,
              s.device_id,
              s.started_at,
              s.ended_at,
              s.status,
              s.admin_card_id as opened_by_card_id,
              null::uuid as game_id,
              null::text as game_name,
              null::uuid as recharge_point_id,
              null::text as recharge_point_name,
              s.admin_card_id
            from device_admin_sessions s
            where s.device_id = $1
          )

          select
            s.*,

            greatest(
              s.started_at,
              b.range_start
            ) as visible_started_at,

            least(
              coalesce(s.ended_at, now()),
              b.range_end
            ) as visible_ended_at,

            greatest(
              0,
              extract(
                epoch from (
                  least(
                    coalesce(s.ended_at, now()),
                    b.range_end
                  )
                  -
                  greatest(
                    s.started_at,
                    b.range_start
                  )
                )
              )
            )::bigint as duration_seconds,

            case
              when s.mode = 'GAME' then (
                select coalesce(sum(t.amount), 0)
                from transactions t
                where t.device_id = s.device_id
                  and t.card_write_status = 'CONFIRMED'
                  and t.transaction_type = 'CHARGE'
                  and t.game_id = s.game_id
                  and coalesce(t.confirmed_at, t.created_at) >= s.started_at
                  and coalesce(t.confirmed_at, t.created_at) <
                      coalesce(s.ended_at, now())
                  and coalesce(t.confirmed_at, t.created_at) >= b.range_start
                  and coalesce(t.confirmed_at, t.created_at) < b.range_end
              )
              else 0
            end as game_consumption_amount,

            case
              when s.mode = 'GAME' then (
                select coalesce(sum(coalesce(t.quantity, 0)), 0)
                from transactions t
                where t.device_id = s.device_id
                  and t.card_write_status = 'CONFIRMED'
                  and t.transaction_type = 'CHARGE'
                  and t.game_id = s.game_id
                  and coalesce(t.confirmed_at, t.created_at) >= s.started_at
                  and coalesce(t.confirmed_at, t.created_at) <
                      coalesce(s.ended_at, now())
                  and coalesce(t.confirmed_at, t.created_at) >= b.range_start
                  and coalesce(t.confirmed_at, t.created_at) < b.range_end
              )
              else 0
            end as game_people_count,

            case
              when s.mode = 'RECHARGE' then (
                select coalesce(sum(t.amount), 0)
                from transactions t
                where t.device_id = s.device_id
                  and t.card_write_status = 'CONFIRMED'
                  and t.transaction_type = 'RECHARGE'
                  and t.recharge_point_id = s.recharge_point_id
                  and coalesce(t.confirmed_at, t.created_at) >= s.started_at
                  and coalesce(t.confirmed_at, t.created_at) <
                      coalesce(s.ended_at, now())
                  and coalesce(t.confirmed_at, t.created_at) >= b.range_start
                  and coalesce(t.confirmed_at, t.created_at) < b.range_end
              )
              else 0
            end as recharge_amount,

            case
              when s.mode = 'ADMIN' then (
                select coalesce(sum(t.amount), 0)
                from transactions t
                where t.device_id = s.device_id
                  and t.actor_role = 'ADMIN'
                  and t.card_write_status = 'CONFIRMED'
                  and t.transaction_type = 'RECHARGE'
                  and coalesce(t.confirmed_at, t.created_at) >= s.started_at
                  and coalesce(t.confirmed_at, t.created_at) <
                      coalesce(s.ended_at, now())
                  and coalesce(t.confirmed_at, t.created_at) >= b.range_start
                  and coalesce(t.confirmed_at, t.created_at) < b.range_end
              )
              else 0
            end as admin_recharge_amount,

            case
              when s.mode = 'ADMIN' then (
                select coalesce(sum(t.amount), 0)
                from transactions t
                where t.device_id = s.device_id
                  and t.actor_role = 'ADMIN'
                  and t.card_write_status = 'CONFIRMED'
                  and t.transaction_type = 'ADJUSTMENT'
                  and coalesce(t.confirmed_at, t.created_at) >= s.started_at
                  and coalesce(t.confirmed_at, t.created_at) <
                      coalesce(s.ended_at, now())
                  and coalesce(t.confirmed_at, t.created_at) >= b.range_start
                  and coalesce(t.confirmed_at, t.created_at) < b.range_end
              )
              else 0
            end as admin_adjustment_amount

          from sessions s
          cross join bounds b

          where s.started_at < b.range_end
            and coalesce(s.ended_at, now()) > b.range_start

          order by s.started_at asc
          `,
          [deviceId, from, to, REPORT_TIMEZONE]
        );

        const device = deviceResult.rows[0];

        return {
          from,
          to,
          timezone: REPORT_TIMEZONE,

          device: {
            deviceId: device.id,
            code: device.device_code,
            name: device.name,
            status: device.status,
          },

          sessions: sessionsResult.rows.map((row: any) => ({
            sessionId: row.session_id,
            mode: row.mode,
            status: row.status,

            startedAt: row.started_at,
            endedAt: row.ended_at,

            visibleStartedAt: row.visible_started_at,
            visibleEndedAt: row.visible_ended_at,

            durationSeconds: Number(row.duration_seconds),

            game:
              row.game_id === null
                ? null
                : {
                    gameId: row.game_id,
                    name: row.game_name,
                  },

            rechargePoint:
              row.recharge_point_id === null
                ? null
                : {
                    rechargePointId: row.recharge_point_id,
                    name: row.recharge_point_name,
                  },

            admin:
              row.mode !== "ADMIN"
                ? null
                : {
                    cardId:
                      row.admin_card_id === null
                        ? null
                        : Number(row.admin_card_id),
                  },

            metrics: {
              gameConsumptionAmount:
                Number(row.game_consumption_amount),

              gamePeopleCount:
                Number(row.game_people_count),

              rechargeAmount:
                Number(row.recharge_amount),

              adminRechargeAmount:
                Number(row.admin_recharge_amount),

              adminAdjustmentAmount:
                Number(row.admin_adjustment_amount),
            },
          })),
        };
      } catch (error) {
        server.log.error(error);
        return reply.status(500).send({ error: "INTERNAL_ERROR" });
      } finally {
        client.release();
      }
    }
  );

}
