import type { FastifyInstance } from "fastify";
import { db } from "../db/database.js";

const REPORT_TIMEZONE = "America/Mexico_City";

type ReportQuery = {
  deviceCode?: string;
  from?: string;
  to?: string;
};

type GameReportParams = {
  gameId: string;
};

type RechargePointReportParams = {
  rechargePointId: string;
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

export async function reportRoutes(server: FastifyInstance) {
  async function getAdminActor(client: any, deviceCode: string) {
    const result = await client.query(
      `
      select
          d.id as device_id,
          d.device_code,
          d.name as device_name,
          s.id as session_id,
          s.admin_card_id
      from devices d
      join device_admin_sessions s
          on s.device_id = d.id
      where d.device_code = $1
        and d.status = 'ACTIVE'
        and s.status = 'ACTIVE'
        and s.ended_at is null
      limit 1
      `,
      [deviceCode.trim()]
    );

    if (result.rowCount === 0) return null;
    return result.rows[0];
  }

  function validateReportQuery(query: ReportQuery) {
    const { deviceCode, from, to } = query;

    if (typeof deviceCode !== "string" || deviceCode.trim().length === 0) {
      return {
        ok: false as const,
        status: 400,
        body: {
          error: "INVALID_DEVICE_CODE",
          message: "deviceCode es obligatorio.",
        },
      };
    }

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
      deviceCode: deviceCode.trim(),
      from,
      to,
    };
  }

    server.get<{ Querystring: ReportQuery }>(
    "/admin/reports/summary",

    async (request, reply) => {
      const validation =
        validateReportQuery(request.query);

      if (!validation.ok) {
        return reply
          .status(validation.status)
          .send(validation.body);
      }

      const {
        deviceCode,
        from,
        to,
      } = validation;

      const client =
        await db.connect();

      try {
        const admin =
          await getAdminActor(
            client,
            deviceCode
          );

        if (admin === null) {
          return reply.status(403).send({
            error:
              "ADMIN_PERMISSION_REQUIRED",
            message:
              "Se necesita una sesión ADMIN activa.",
          });
        }

        /*
         * =================================================
         * RESUMEN FINANCIAL LEDGER V2
         * =================================================
         *
         * RECHARGE:
         *
         * Si existen transaction_credit_components,
         * usamos esos componentes como fuente de verdad.
         *
         * Si NO existen, es una operación legacy y
         * consideramos transaction.amount como CASH.
         *
         * -------------------------------------------------
         *
         * CHARGE:
         *
         * Si existen transaction_fund_allocations,
         * conocemos exactamente el origen consumido.
         *
         * Si NO existen, clasificamos el consumo como
         * LEGACY porque no podemos reconstruir de forma
         * confiable el origen histórico del saldo.
         *
         * =================================================
         */

        const result =
          await client.query(
            `
            with
            credit_components as (
              select
                  transaction_id,

                  coalesce(
                    sum(amount)
                      filter (
                        where fund_type = 'CASH'
                      ),
                    0
                  ) as cash_amount,

                  coalesce(
                    sum(amount)
                      filter (
                        where fund_type = 'PROMOTIONAL'
                      ),
                    0
                  ) as promotional_amount,

                  coalesce(
                    sum(amount)
                      filter (
                        where fund_type = 'ADMIN_CREDIT'
                      ),
                    0
                  ) as admin_credit_amount,

                  coalesce(
                    sum(amount)
                      filter (
                        where fund_type = 'LEGACY'
                      ),
                    0
                  ) as legacy_amount,

                  count(*) as component_count

              from transaction_credit_components

              group by transaction_id
            ),

            fund_allocations as (
              select
                  transaction_id,

                  coalesce(
                    sum(amount)
                      filter (
                        where fund_type = 'CASH'
                      ),
                    0
                  ) as cash_amount,

                  coalesce(
                    sum(amount)
                      filter (
                        where fund_type = 'PROMOTIONAL'
                      ),
                    0
                  ) as promotional_amount,

                  coalesce(
                    sum(amount)
                      filter (
                        where fund_type = 'ADMIN_CREDIT'
                      ),
                    0
                  ) as admin_credit_amount,

                  coalesce(
                    sum(amount)
                      filter (
                        where fund_type = 'LEGACY'
                      ),
                    0
                  ) as legacy_amount,

                  count(*) as allocation_count

              from transaction_fund_allocations

              group by transaction_id
            ),

            report_transactions as (
              select
                  t.*,

                  coalesce(
                    cc.cash_amount,
                    0
                  ) as credit_cash_amount,

                  coalesce(
                    cc.promotional_amount,
                    0
                  ) as credit_promotional_amount,

                  coalesce(
                    cc.admin_credit_amount,
                    0
                  ) as credit_admin_amount,

                  coalesce(
                    cc.legacy_amount,
                    0
                  ) as credit_legacy_amount,

                  coalesce(
                    cc.component_count,
                    0
                  ) as component_count,

                  coalesce(
                    fa.cash_amount,
                    0
                  ) as consumed_cash_amount,

                  coalesce(
                    fa.promotional_amount,
                    0
                  ) as consumed_promotional_amount,

                  coalesce(
                    fa.admin_credit_amount,
                    0
                  ) as consumed_admin_amount,

                  coalesce(
                    fa.legacy_amount,
                    0
                  ) as consumed_legacy_amount,

                  coalesce(
                    fa.allocation_count,
                    0
                  ) as allocation_count

              from transactions t

              left join credit_components cc
                on cc.transaction_id = t.id

              left join fund_allocations fa
                on fa.transaction_id = t.id

              where
                t.card_write_status = 'CONFIRMED'

                and (
                  coalesce(
                    t.confirmed_at,
                    t.created_at
                  )
                  at time zone $3
                )::date
                between $1::date
                    and $2::date
            )

            select

                /*
                 * ===============================
                 * TAQUILLAS / RECHARGE POINTS
                 * ===============================
                 */

                coalesce(
                  sum(
                    case
                      when
                        transaction_type = 'RECHARGE'
                        and recharge_point_id
                          is not null
                      then
                        case
                          when component_count > 0
                          then credit_cash_amount
                          else amount
                        end
                      else 0
                    end
                  ),
                  0
                ) as recharge_cash_received,

                coalesce(
                  sum(
                    case
                      when
                        transaction_type = 'RECHARGE'
                        and recharge_point_id
                          is not null
                      then
                        case
                          when component_count > 0
                          then credit_promotional_amount
                          else 0
                        end
                      else 0
                    end
                  ),
                  0
                ) as recharge_promotional_given,

                coalesce(
                  sum(
                    case
                      when
                        transaction_type = 'RECHARGE'
                        and recharge_point_id
                          is not null
                      then amount
                      else 0
                    end
                  ),
                  0
                ) as recharge_credited_amount,

                coalesce(
                  sum(
                    case
                      when
                        transaction_type =
                          'CARD_CREATED'
                        and recharge_point_id
                          is not null
                      then amount
                      else 0
                    end
                  ),
                  0
                ) as activation_amount,

                /*
                 * ===============================
                 * JUEGOS
                 * ===============================
                 */

                coalesce(
                  sum(
                    case
                      when
                        transaction_type = 'CHARGE'
                        and game_id is not null
                      then amount
                      else 0
                    end
                  ),
                  0
                ) as game_consumption_amount,

                coalesce(
                  sum(
                    case
                      when
                        transaction_type = 'CHARGE'
                        and game_id is not null
                        and allocation_count > 0
                      then consumed_cash_amount
                      else 0
                    end
                  ),
                  0
                ) as game_cash_consumed,

                coalesce(
                  sum(
                    case
                      when
                        transaction_type = 'CHARGE'
                        and game_id is not null
                        and allocation_count > 0
                      then consumed_promotional_amount
                      else 0
                    end
                  ),
                  0
                ) as game_promotional_consumed,

                coalesce(
                  sum(
                    case
                      when
                        transaction_type = 'CHARGE'
                        and game_id is not null
                        and allocation_count > 0
                      then consumed_admin_amount
                      else 0
                    end
                  ),
                  0
                ) as game_admin_credit_consumed,

                coalesce(
                  sum(
                    case
                      when
                        transaction_type = 'CHARGE'
                        and game_id is not null
                      then
                        case
                          when allocation_count > 0
                          then consumed_legacy_amount
                          else amount
                        end
                      else 0
                    end
                  ),
                  0
                ) as game_legacy_consumed,

                coalesce(
                  sum(
                    case
                      when
                        transaction_type = 'CHARGE'
                        and game_id is not null
                      then coalesce(quantity, 0)
                      else 0
                    end
                  ),
                  0
                ) as game_people_count,

                count(*)
                  filter (
                    where
                      transaction_type = 'CHARGE'
                      and game_id is not null
                  ) as game_operations_count,

                /*
                 * ===============================
                 * ADMIN
                 * ===============================
                 */

                coalesce(
                  sum(
                    case
                      when
                        transaction_type = 'RECHARGE'
                        and actor_role = 'ADMIN'
                      then
                        case
                          when component_count > 0
                          then credit_cash_amount
                          else amount
                        end
                      else 0
                    end
                  ),
                  0
                ) as admin_recharge_amount,

                coalesce(
                  sum(
                    case
                      when
                        transaction_type = 'ADJUSTMENT'
                        and actor_role = 'ADMIN'
                      then amount
                      else 0
                    end
                  ),
                  0
                ) as admin_adjustment_amount

            from report_transactions
            `,
            [
              from,
              to,
              REPORT_TIMEZONE,
            ]
          );

        const row =
          result.rows[0];

        return {
          from,
          to,
          timezone:
            REPORT_TIMEZONE,

          summary: {
            rechargePoints: {
              cashReceived:
                Number(
                  row.recharge_cash_received
                ),

              promotionalGiven:
                Number(
                  row.recharge_promotional_given
                ),

              creditedAmount:
                Number(
                  row.recharge_credited_amount
                ),

              activationAmount:
                Number(
                  row.activation_amount
                ),
            },

            games: {
              consumptionAmount:
                Number(
                  row.game_consumption_amount
                ),

              cashConsumed:
                Number(
                  row.game_cash_consumed
                ),

              promotionalConsumed:
                Number(
                  row.game_promotional_consumed
                ),

              adminCreditConsumed:
                Number(
                  row.game_admin_credit_consumed
                ),

              legacyConsumed:
                Number(
                  row.game_legacy_consumed
                ),

              peopleCount:
                Number(
                  row.game_people_count
                ),

              operationsCount:
                Number(
                  row.game_operations_count
                ),
            },

            admin: {
              rechargeAmount:
                Number(
                  row.admin_recharge_amount
                ),

              adjustmentAmount:
                Number(
                  row.admin_adjustment_amount
                ),
            },
          },
        };

      } catch (error) {
        server.log.error(error);

        return reply.status(500).send({
          error:
            "INTERNAL_ERROR",
        });

      } finally {
        client.release();
      }
    }
  );

    server.get<{ Querystring: ReportQuery }>(
    "/admin/reports/games",

    async (request, reply) => {
      const validation =
        validateReportQuery(request.query);

      if (!validation.ok) {
        return reply
          .status(validation.status)
          .send(validation.body);
      }

      const {
        deviceCode,
        from,
        to,
      } = validation;

      const client =
        await db.connect();

      try {
        const admin =
          await getAdminActor(
            client,
            deviceCode
          );

        if (admin === null) {
          return reply.status(403).send({
            error:
              "ADMIN_PERMISSION_REQUIRED",
            message:
              "Se necesita una sesión ADMIN activa.",
          });
        }

        /*
         * =================================================
         * REPORTES POR JUEGO
         * =================================================
         *
         * transaction.amount representa el consumo total
         * realizado en el juego.
         *
         * transaction_fund_allocations explica de qué
         * fondos salió ese consumo:
         *
         *   CASH
         *   PROMOTIONAL
         *   ADMIN_CREDIT
         *   LEGACY
         *
         * IMPORTANTE:
         *
         * Las allocations se agregan primero por
         * transacción para evitar multiplicar amount,
         * quantity u operations cuando una misma
         * transacción consume varios lotes/fondos.
         * =================================================
         */

        const result =
          await client.query(
            `
            with charge_transactions as (

              select
                  t.id,
                  t.game_id,
                  t.amount,
                  coalesce(
                    t.quantity,
                    0
                  ) as quantity,

                  (
                    coalesce(
                      t.confirmed_at,
                      t.created_at
                    )
                    at time zone $3
                  )::date as report_date

              from transactions t

              where
                t.card_write_status =
                  'CONFIRMED'

                and t.transaction_type =
                  'CHARGE'

                and t.game_id
                  is not null

                and (
                  coalesce(
                    t.confirmed_at,
                    t.created_at
                  )
                  at time zone $3
                )::date
                  between $1::date
                      and $2::date
            ),

            allocation_totals as (

              select
                  a.transaction_id,

                  coalesce(
                    sum(a.amount)
                      filter (
                        where
                          a.fund_type =
                            'CASH'
                      ),
                    0
                  ) as cash_consumed,

                  coalesce(
                    sum(a.amount)
                      filter (
                        where
                          a.fund_type =
                            'PROMOTIONAL'
                      ),
                    0
                  ) as promotional_consumed,

                  coalesce(
                    sum(a.amount)
                      filter (
                        where
                          a.fund_type =
                            'ADMIN_CREDIT'
                      ),
                    0
                  ) as admin_credit_consumed,

                  coalesce(
                    sum(a.amount)
                      filter (
                        where
                          a.fund_type =
                            'LEGACY'
                      ),
                    0
                  ) as legacy_consumed

              from
                transaction_fund_allocations a

              join charge_transactions ct
                on ct.id =
                  a.transaction_id

              group by
                a.transaction_id
            )

            select
                g.id as game_id,
                g.name,
                g.price as current_price,

                to_char(
                  ct.report_date,
                  'YYYY-MM-DD'
                ) as report_date,

                coalesce(
                  sum(ct.amount),
                  0
                ) as consumption_amount,

                coalesce(
                  sum(
                    at.cash_consumed
                  ),
                  0
                ) as cash_consumed,

                coalesce(
                  sum(
                    at.promotional_consumed
                  ),
                  0
                ) as promotional_consumed,

                coalesce(
                  sum(
                    at.admin_credit_consumed
                  ),
                  0
                ) as admin_credit_consumed,

                coalesce(
                  sum(
                    at.legacy_consumed
                  ),
                  0
                ) as legacy_consumed,

                coalesce(
                  sum(ct.quantity),
                  0
                ) as people_count,

                count(*) as operations_count

            from charge_transactions ct

            join games g
              on g.id =
                ct.game_id

            left join allocation_totals at
              on at.transaction_id =
                ct.id

            group by
                g.id,
                g.name,
                g.price,
                ct.report_date

            order by
                g.name asc,
                ct.report_date desc
            `,
            [
              from,
              to,
              REPORT_TIMEZONE,
            ]
          );

        const gamesMap =
          new Map<string, any>();

        for (
          const row of result.rows
        ) {
          const gameId =
            row.game_id;

          let game =
            gamesMap.get(
              gameId
            );

          if (
            game === undefined
          ) {
            game = {
              gameId,

              name:
                row.name,

              currentPrice:
                Number(
                  row.current_price
                ),

              consumptionAmount:
                0,

              cashConsumed:
                0,

              promotionalConsumed:
                0,

              adminCreditConsumed:
                0,

              legacyConsumed:
                0,

              peopleCount:
                0,

              operationsCount:
                0,

              dailyBreakdown:
                [],
            };

            gamesMap.set(
              gameId,
              game
            );
          }

          const dailyAmount =
            Number(
              row.consumption_amount
            );

          const dailyCash =
            Number(
              row.cash_consumed
            );

          const dailyPromotional =
            Number(
              row.promotional_consumed
            );

          const dailyAdminCredit =
            Number(
              row.admin_credit_consumed
            );

          const dailyLegacy =
            Number(
              row.legacy_consumed
            );

          const dailyPeople =
            Number(
              row.people_count
            );

          const dailyOperations =
            Number(
              row.operations_count
            );

          game.consumptionAmount +=
            dailyAmount;

          game.cashConsumed +=
            dailyCash;

          game.promotionalConsumed +=
            dailyPromotional;

          game.adminCreditConsumed +=
            dailyAdminCredit;

          game.legacyConsumed +=
            dailyLegacy;

          game.peopleCount +=
            dailyPeople;

          game.operationsCount +=
            dailyOperations;

          game.dailyBreakdown.push({
            date:
              row.report_date,

            consumptionAmount:
              dailyAmount,

            cashConsumed:
              dailyCash,

            promotionalConsumed:
              dailyPromotional,

            adminCreditConsumed:
              dailyAdminCredit,

            legacyConsumed:
              dailyLegacy,

            peopleCount:
              dailyPeople,

            operationsCount:
              dailyOperations,
          });
        }

        const games =
          Array
            .from(
              gamesMap.values()
            )
            .sort(
              (
                a: any,
                b: any
              ) => {
                if (
                  b.consumptionAmount !==
                  a.consumptionAmount
                ) {
                  return (
                    b.consumptionAmount -
                    a.consumptionAmount
                  );
                }

                return a.name
                  .localeCompare(
                    b.name
                  );
              }
            );

        return {
          from,
          to,
          timezone:
            REPORT_TIMEZONE,
          games,
        };
      } catch (error) {
        server.log.error(error);

        return reply.status(500).send({
          error:
            "INTERNAL_ERROR",
        });
      } finally {
        client.release();
      }
    }
  );

    server.get<{ Querystring: ReportQuery }>(
    "/admin/reports/recharge-points",
    async (request, reply) => {
      const validation = validateReportQuery(request.query);

      if (!validation.ok) {
        return reply.status(validation.status).send(validation.body);
      }

      const { deviceCode, from, to } = validation;
      const client = await db.connect();

      try {
        const admin = await getAdminActor(client, deviceCode);

        if (admin === null) {
          return reply.status(403).send({
            error: "ADMIN_PERMISSION_REQUIRED",
            message: "Se necesita una sesión ADMIN activa.",
          });
        }

        /*
         * =====================================================
         * REPORTE FINANCIERO POR TAQUILLA
         * =====================================================
         *
         * IMPORTANTE:
         *
         * transaction.amount representa el saldo total
         * acreditado a la tarjeta.
         *
         * NO representa necesariamente dinero físico recibido.
         *
         * Ejemplo:
         *
         *   Paga $100 y recibe $250
         *
         *   transaction.amount = 250
         *   CASH               = 100
         *   PROMOTIONAL        = 150
         *
         * Por eso el desglose financiero se obtiene desde
         * transaction_credit_components.
         * =====================================================
         */

        const result = await client.query(
          `
          with recharge_financials as (
            select
                t.id,
                t.recharge_point_id,
                t.amount,

                (
                  coalesce(
                    t.confirmed_at,
                    t.created_at
                  )
                  at time zone $3
                )::date as report_date,

                /*
                 * Si la transacción tiene componentes
                 * financieros, CASH es el dinero físico
                 * realmente recibido.
                 *
                 * Para recargas antiguas sin componentes,
                 * consideramos todo t.amount como CASH.
                 */
                case
                  when exists (
                    select 1
                    from transaction_credit_components component_exists
                    where component_exists.transaction_id = t.id
                  )
                  then coalesce(
                    (
                      select sum(component.amount)
                      from transaction_credit_components component
                      where component.transaction_id = t.id
                        and component.fund_type = 'CASH'
                    ),
                    0
                  )
                  else t.amount
                end as cash_received,

                /*
                 * Saldo regalado por promociones.
                 */
                case
                  when exists (
                    select 1
                    from transaction_credit_components component_exists
                    where component_exists.transaction_id = t.id
                  )
                  then coalesce(
                    (
                      select sum(component.amount)
                      from transaction_credit_components component
                      where component.transaction_id = t.id
                        and component.fund_type = 'PROMOTIONAL'
                    ),
                    0
                  )
                  else 0
                end as promotional_given

            from transactions t

            where t.card_write_status = 'CONFIRMED'
              and t.transaction_type = 'RECHARGE'
              and t.recharge_point_id is not null
              and t.confirmed_at is not null
              and (
                t.confirmed_at
                at time zone $3
              )::date
                between $1::date
                    and $2::date
          )

          select
              rp.id as recharge_point_id,
              rp.name,

              to_char(
                rf.report_date,
                'YYYY-MM-DD'
              ) as report_date,

              coalesce(
                sum(rf.cash_received),
                0
              ) as cash_received,

              coalesce(
                sum(rf.promotional_given),
                0
              ) as promotional_given,

              coalesce(
                sum(rf.amount),
                0
              ) as credited_amount,

              count(*) as operations_count

          from recharge_financials rf

          join recharge_points rp
              on rp.id = rf.recharge_point_id

          group by
              rp.id,
              rp.name,
              rf.report_date

          order by
              rp.name asc,
              rf.report_date desc
          `,
          [from, to, REPORT_TIMEZONE]
        );

        const rechargePointsMap =
          new Map<string, any>();

        for (const row of result.rows) {
          const rechargePointId =
            row.recharge_point_id;

          let rechargePoint =
            rechargePointsMap.get(
              rechargePointId
            );

          if (rechargePoint === undefined) {
            rechargePoint = {
              rechargePointId,
              name: row.name,

              cashReceived: 0,
              promotionalGiven: 0,
              creditedAmount: 0,
              operationsCount: 0,

              dailyBreakdown: [],
            };

            rechargePointsMap.set(
              rechargePointId,
              rechargePoint
            );
          }

          const dailyCash =
            Number(row.cash_received);

          const dailyPromotional =
            Number(row.promotional_given);

          const dailyCredited =
            Number(row.credited_amount);

          const dailyOperations =
            Number(row.operations_count);

          rechargePoint.cashReceived +=
            dailyCash;

          rechargePoint.promotionalGiven +=
            dailyPromotional;

          rechargePoint.creditedAmount +=
            dailyCredited;

          rechargePoint.operationsCount +=
            dailyOperations;

          rechargePoint.dailyBreakdown.push({
            date: row.report_date,

            cashReceived:
              dailyCash,

            promotionalGiven:
              dailyPromotional,

            creditedAmount:
              dailyCredited,

            operationsCount:
              dailyOperations,
          });
        }

        const rechargePoints =
          Array
            .from(
              rechargePointsMap.values()
            )
            .sort(
              (
                a: any,
                b: any
              ) => {
                if (
                  b.cashReceived !==
                  a.cashReceived
                ) {
                  return (
                    b.cashReceived -
                    a.cashReceived
                  );
                }

                return a.name
                  .localeCompare(
                    b.name
                  );
              }
            );

        return {
          from,
          to,
          timezone: REPORT_TIMEZONE,
          rechargePoints,
        };
      } catch (error) {
        server.log.error(error);

        return reply.status(500).send({
          error: "INTERNAL_ERROR",
        });
      } finally {
        client.release();
      }
    }
  );

    /*
   * =====================================================
   * ADMIN REPORT — RECHARGE POINT DETAIL
   * =====================================================
   */

  server.get<{
    Params: RechargePointReportParams;
    Querystring: ReportQuery;
  }>(
    "/admin/reports/recharge-points/:rechargePointId",

    async (request, reply) => {
      const validation =
        validateReportQuery(request.query);

      if (!validation.ok) {
        return reply
          .status(validation.status)
          .send(validation.body);
      }

      const {
        deviceCode,
        from,
        to,
      } = validation;

      const {
        rechargePointId,
      } = request.params;

      if (
        typeof rechargePointId !== "string" ||
        rechargePointId.trim().length === 0
      ) {
        return reply.status(400).send({
          error:
            "INVALID_RECHARGE_POINT_ID",
        });
      }

      const client =
        await db.connect();

      try {
        const admin =
          await getAdminActor(
            client,
            deviceCode
          );

        if (admin === null) {
          return reply.status(403).send({
            error:
              "ADMIN_PERMISSION_REQUIRED",
            message:
              "Se necesita una sesión ADMIN activa.",
          });
        }

        /*
         * =================================================
         * TAQUILLA
         * =================================================
         */

        const rechargePointResult =
          await client.query(
            `
            select
                id,
                name
            from recharge_points
            where id = $1
            limit 1
            `,
            [
              rechargePointId.trim(),
            ]
          );

        if (
          rechargePointResult.rowCount === 0
        ) {
          return reply.status(404).send({
            error:
              "RECHARGE_POINT_NOT_FOUND",
          });
        }

        const rechargePointRow =
          rechargePointResult.rows[0];

        /*
         * =================================================
         * TRANSACCIONES
         * =================================================
         */

        const transactionsResult =
          await client.query(
            `
            with credit_totals as (

              select
                  c.transaction_id,

                  coalesce(
                    sum(c.amount)
                      filter (
                        where
                          c.fund_type =
                            'CASH'
                      ),
                    0
                  ) as cash_amount,

                  coalesce(
                    sum(c.amount)
                      filter (
                        where
                          c.fund_type =
                            'PROMOTIONAL'
                      ),
                    0
                  ) as promotional_amount,

                  coalesce(
                    sum(c.amount)
                      filter (
                        where
                          c.fund_type =
                            'ADMIN_CREDIT'
                      ),
                    0
                  ) as admin_credit_amount,

                  count(*) as component_count

              from
                transaction_credit_components c

              group by
                c.transaction_id
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
                p.cash_amount
                  as promotion_cash_amount,
                p.promotional_amount
                  as promotion_promotional_amount,
                p.total_credit_amount
                  as promotion_total_credit_amount,

                t.created_at,
                t.confirmed_at,

                case
                  when
                    coalesce(
                      ct.component_count,
                      0
                    ) > 0
                  then
                    coalesce(
                      ct.cash_amount,
                      0
                    )
                  else
                    t.amount
                end as cash_received,

                case
                  when
                    coalesce(
                      ct.component_count,
                      0
                    ) > 0
                  then
                    coalesce(
                      ct.promotional_amount,
                      0
                    )
                  else
                    0
                end as promotional_given,

                coalesce(
                  ct.admin_credit_amount,
                  0
                ) as admin_credit_amount

            from transactions t

            left join credit_totals ct
              on ct.transaction_id =
                t.id

            left join promotions p
              on p.id =
                t.promotion_id

            where
              t.recharge_point_id = $1

              and t.transaction_type =
                'RECHARGE'

              and t.card_write_status =
                'CONFIRMED'

              and t.confirmed_at
                is not null

              and (
                t.confirmed_at
                at time zone $4
              )::date
                between $2::date
                    and $3::date

            order by
              t.confirmed_at desc
            `,
            [
              rechargePointId.trim(),
              from,
              to,
              REPORT_TIMEZONE,
            ]
          );

        /*
         * =================================================
         * RESUMEN + HISTORIAL
         * =================================================
         */

        let cashReceived =
          0;

        let promotionalGiven =
          0;

        let creditedAmount =
          0;

        const dailyMap =
          new Map<string, any>();

        const transactions =
          transactionsResult.rows.map(
            (row: any) => {
              const cash =
                Number(
                  row.cash_received
                );

              const promotional =
                Number(
                  row.promotional_given
                );

              const credited =
                Number(
                  row.amount
                );

              cashReceived +=
                cash;

              promotionalGiven +=
                promotional;

              creditedAmount +=
                credited;

              const operationDate =
                row.confirmed_at ??
                row.created_at;

              const localDate =
                new Intl.DateTimeFormat(
                  "en-CA",
                  {
                    timeZone:
                      REPORT_TIMEZONE,

                    year:
                      "numeric",

                    month:
                      "2-digit",

                    day:
                      "2-digit",
                  }
                ).format(
                  new Date(
                    operationDate
                  )
                );

              let daily =
                dailyMap.get(
                  localDate
                );

              if (
                daily === undefined
              ) {
                daily = {
                  date:
                    localDate,

                  cashReceived:
                    0,

                  promotionalGiven:
                    0,

                  creditedAmount:
                    0,

                  operationsCount:
                    0,
                };

                dailyMap.set(
                  localDate,
                  daily
                );
              }

              daily.cashReceived +=
                cash;

              daily.promotionalGiven +=
                promotional;

              daily.creditedAmount +=
                credited;

              daily.operationsCount +=
                1;

              return {
                transactionId:
                  row.id,

                cardId:
                  Number(
                    row.card_id
                  ),

                deviceId:
                  row.device_id,

                creditedAmount:
                  credited,

                cashReceived:
                  cash,

                promotionalGiven:
                  promotional,

                adminCreditAmount:
                  Number(
                    row.admin_credit_amount
                  ),

                balanceBefore:
                  Number(
                    row.balance_before
                  ),

                balanceAfter:
                  Number(
                    row.balance_after
                  ),

                counterBefore:
                  Number(
                    row.counter_before
                  ),

                counterAfter:
                  Number(
                    row.counter_after
                  ),

                status:
                  row.card_write_status,

                promotion:
                  row.promotion_id === null
                    ? null
                    : {
                        promotionId:
                          row.promotion_id,

                        name:
                          row.promotion_name,

                        cashAmount:
                          Number(
                            row
                              .promotion_cash_amount
                          ),

                        promotionalAmount:
                          Number(
                            row
                              .promotion_promotional_amount
                          ),

                        creditedAmount:
                          Number(
                            row
                              .promotion_total_credit_amount
                          ),
                      },

                createdAt:
                  row.created_at,

                confirmedAt:
                  row.confirmed_at,
              };
            }
          );

        const dailyBreakdown =
          Array
            .from(
              dailyMap.values()
            )
            .sort(
              (
                a: any,
                b: any
              ) =>
                b.date.localeCompare(
                  a.date
                )
            );

        return {
          from,
          to,

          timezone:
            REPORT_TIMEZONE,

          rechargePoint: {
            rechargePointId:
              rechargePointRow.id,

            name:
              rechargePointRow.name,
          },

          summary: {
            cashReceived,

            promotionalGiven,

            creditedAmount,

            operationsCount:
              transactions.length,
          },

          dailyBreakdown,

          transactions,
        };

      } catch (error: any) {
        if (
          error?.code ===
          "22P02"
        ) {
          return reply.status(400).send({
            error:
              "INVALID_RECHARGE_POINT_ID",
          });
        }

        server.log.error(error);

        return reply.status(500).send({
          error:
            "INTERNAL_ERROR",
        });

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
   * GET /admin/reports/devices
   *
   * Devuelve el tiempo total que cada Ulefone pasó con
   * una sesión GAME, RECHARGE o ADMIN dentro del rango.
   * No expone "# de operaciones" como métrica.
   * =====================================================
   */
  server.get<{ Querystring: ReportQuery }>(
    "/admin/reports/devices",
    async (request, reply) => {
      const validation = validateReportQuery(request.query);

      if (!validation.ok) {
        return reply.status(validation.status).send(validation.body);
      }

      const { deviceCode, from, to } = validation;
      const client = await db.connect();

      try {
        const admin = await getAdminActor(client, deviceCode);

        if (admin === null) {
          return reply.status(403).send({
            error: "ADMIN_PERMISSION_REQUIRED",
            message: "Se necesita una sesión ADMIN activa.",
          });
        }

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
   * GET /admin/reports/devices/:deviceId/history
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
    Querystring: ReportQuery;
  }>(
    "/admin/reports/devices/:deviceId/history",
    async (request, reply) => {
      const validation = validateReportQuery(request.query);

      if (!validation.ok) {
        return reply.status(validation.status).send(validation.body);
      }

      const { deviceCode, from, to } = validation;
      const deviceId = request.params.deviceId?.trim();

      if (!deviceId) {
        return reply.status(400).send({
          error: "INVALID_DEVICE_ID",
          message: "El dispositivo no tiene un ID válido.",
        });
      }

      const client = await db.connect();

      try {
        const admin = await getAdminActor(client, deviceCode);

        if (admin === null) {
          return reply.status(403).send({
            error: "ADMIN_PERMISSION_REQUIRED",
            message: "Se necesita una sesión ADMIN activa.",
          });
        }

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


    /*
   * =====================================================
   * ADMIN REPORT — GAME DETAIL
   * =====================================================
   *
   * Auditoría financiera completa de un juego.
   *
   * Incluye:
   *
   * - Totales del periodo.
   * - CASH consumido.
   * - PROMOTIONAL consumido.
   * - ADMIN_CREDIT consumido.
   * - LEGACY consumido.
   * - Personas.
   * - Operaciones.
   * - Desglose diario.
   * - Historial transacción por transacción.
   *
   * Las allocations se agregan primero por transacción
   * para evitar duplicar amount / quantity cuando una
   * operación utilizó varios lotes financieros.
   * =====================================================
   */

  server.get<{
    Params: GameReportParams;
    Querystring: ReportQuery;
  }>(
    "/admin/reports/games/:gameId",

    async (request, reply) => {
      const validation =
        validateReportQuery(request.query);

      if (!validation.ok) {
        return reply
          .status(validation.status)
          .send(validation.body);
      }

      const {
        deviceCode,
        from,
        to,
      } = validation;

      const {
        gameId,
      } = request.params;

      if (
        typeof gameId !== "string" ||
        gameId.trim().length === 0
      ) {
        return reply.status(400).send({
          error:
            "INVALID_GAME_ID",
        });
      }

      const client =
        await db.connect();

      try {
        /*
         * ===============================================
         * VALIDAR ADMIN
         * ===============================================
         */

        const admin =
          await getAdminActor(
            client,
            deviceCode
          );

        if (admin === null) {
          return reply.status(403).send({
            error:
              "ADMIN_PERMISSION_REQUIRED",

            message:
              "Se necesita una sesión ADMIN activa.",
          });
        }

        /*
         * ===============================================
         * OBTENER JUEGO
         * ===============================================
         */

        const gameResult =
          await client.query(
            `
            select
                id,
                name,
                price
            from games
            where id = $1
            limit 1
            `,
            [
              gameId.trim(),
            ]
          );

        if (
          gameResult.rowCount === 0
        ) {
          return reply.status(404).send({
            error:
              "GAME_NOT_FOUND",
          });
        }

        const gameRow =
          gameResult.rows[0];

        /*
         * ===============================================
         * TRANSACCIONES + FONDOS
         * ===============================================
         *
         * Primero agrupamos transaction_fund_allocations
         * por transaction_id.
         *
         * De esa forma una transacción que consumió:
         *
         * CASH          100
         * CASH          100
         * PROMOTIONAL   100
         *
         * sigue apareciendo como UNA sola operación.
         * ===============================================
         */

        const transactionsResult =
          await client.query(
            `
            with allocation_totals as (

              select
                  a.transaction_id,

                  coalesce(
                    sum(a.amount)
                      filter (
                        where
                          a.fund_type =
                            'CASH'
                      ),
                    0
                  ) as cash_consumed,

                  coalesce(
                    sum(a.amount)
                      filter (
                        where
                          a.fund_type =
                            'PROMOTIONAL'
                      ),
                    0
                  ) as promotional_consumed,

                  coalesce(
                    sum(a.amount)
                      filter (
                        where
                          a.fund_type =
                            'ADMIN_CREDIT'
                      ),
                    0
                  ) as admin_credit_consumed,

                  coalesce(
                    sum(a.amount)
                      filter (
                        where
                          a.fund_type =
                            'LEGACY'
                      ),
                    0
                  ) as legacy_consumed

              from
                transaction_fund_allocations a

              group by
                a.transaction_id
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

                coalesce(
                  at.cash_consumed,
                  0
                ) as cash_consumed,

                coalesce(
                  at.promotional_consumed,
                  0
                ) as promotional_consumed,

                coalesce(
                  at.admin_credit_consumed,
                  0
                ) as admin_credit_consumed,

                coalesce(
                  at.legacy_consumed,
                  0
                ) as legacy_consumed

            from transactions t

            left join allocation_totals at
              on at.transaction_id =
                t.id

            where
              t.game_id = $1

              and t.transaction_type =
                'CHARGE'

              and t.card_write_status =
                'CONFIRMED'

              and (
                coalesce(
                  t.confirmed_at,
                  t.created_at
                )
                at time zone $4
              )::date
                between $2::date
                    and $3::date

            order by
              coalesce(
                t.confirmed_at,
                t.created_at
              ) desc
            `,
            [
              gameId.trim(),
              from,
              to,
              REPORT_TIMEZONE,
            ]
          );

        /*
         * ===============================================
         * CONSTRUIR RESUMEN
         * ===============================================
         */

        let consumptionAmount =
          0;

        let cashConsumed =
          0;

        let promotionalConsumed =
          0;

        let adminCreditConsumed =
          0;

        let legacyConsumed =
          0;

        let peopleCount =
          0;

        const dailyMap =
          new Map<string, any>();

        const transactions =
          transactionsResult.rows.map(
            (row: any) => {
              const amount =
                Number(
                  row.amount
                );

              const cash =
                Number(
                  row.cash_consumed
                );

              const promotional =
                Number(
                  row.promotional_consumed
                );

              const adminCredit =
                Number(
                  row.admin_credit_consumed
                );

              const legacy =
                Number(
                  row.legacy_consumed
                );

              const quantity =
                Number(
                  row.quantity ?? 0
                );

              consumptionAmount +=
                amount;

              cashConsumed +=
                cash;

              promotionalConsumed +=
                promotional;

              adminCreditConsumed +=
                adminCredit;

              legacyConsumed +=
                legacy;

              peopleCount +=
                quantity;

              /*
               * Fecha local de Córdoba.
               *
               * confirmed_at/created_at vienen de PostgreSQL
               * como Date en el driver.
               */

              const operationDate =
                row.confirmed_at ??
                row.created_at;

              const localDate =
                new Intl.DateTimeFormat(
                  "en-CA",
                  {
                    timeZone:
                      REPORT_TIMEZONE,

                    year:
                      "numeric",

                    month:
                      "2-digit",

                    day:
                      "2-digit",
                  }
                ).format(
                  new Date(
                    operationDate
                  )
                );

              let daily =
                dailyMap.get(
                  localDate
                );

              if (
                daily === undefined
              ) {
                daily = {
                  date:
                    localDate,

                  consumptionAmount:
                    0,

                  cashConsumed:
                    0,

                  promotionalConsumed:
                    0,

                  adminCreditConsumed:
                    0,

                  legacyConsumed:
                    0,

                  peopleCount:
                    0,

                  operationsCount:
                    0,
                };

                dailyMap.set(
                  localDate,
                  daily
                );
              }

              daily.consumptionAmount +=
                amount;

              daily.cashConsumed +=
                cash;

              daily.promotionalConsumed +=
                promotional;

              daily.adminCreditConsumed +=
                adminCredit;

              daily.legacyConsumed +=
                legacy;

              daily.peopleCount +=
                quantity;

              daily.operationsCount +=
                1;

              return {
                transactionId:
                  row.id,

                cardId:
                  Number(
                    row.card_id
                  ),

                deviceId:
                  row.device_id,

                amount,

                quantity,

                unitPrice:
                  row.unit_price === null
                    ? null
                    : Number(
                        row.unit_price
                      ),

                balanceBefore:
                  Number(
                    row.balance_before
                  ),

                balanceAfter:
                  Number(
                    row.balance_after
                  ),

                counterBefore:
                  Number(
                    row.counter_before
                  ),

                counterAfter:
                  Number(
                    row.counter_after
                  ),

                status:
                  row.card_write_status,

                createdAt:
                  row.created_at,

                confirmedAt:
                  row.confirmed_at,

                fundBreakdown: {
                  cash,

                  promotional,

                  adminCredit,

                  legacy,
                },
              };
            }
          );

        /*
         * ===============================================
         * DESGLOSE DIARIO
         * ===============================================
         */

        const dailyBreakdown =
          Array
            .from(
              dailyMap.values()
            )
            .sort(
              (
                a: any,
                b: any
              ) =>
                b.date.localeCompare(
                  a.date
                )
            );

        /*
         * ===============================================
         * RESPUESTA
         * ===============================================
         */

        return {
          from,
          to,

          timezone:
            REPORT_TIMEZONE,

          game: {
            gameId:
              gameRow.id,

            name:
              gameRow.name,

            currentPrice:
              Number(
                gameRow.price
              ),
          },

          summary: {
            consumptionAmount,

            cashConsumed,

            promotionalConsumed,

            adminCreditConsumed,

            legacyConsumed,

            peopleCount,

            operationsCount:
              transactions.length,
          },

          dailyBreakdown,

          transactions,
        };
      } catch (error: any) {
        /*
         * PostgreSQL:
         *
         * 22P02 =
         * invalid_text_representation
         *
         * Por ejemplo un UUID inválido.
         */

        if (
          error?.code ===
          "22P02"
        ) {
          return reply.status(400).send({
            error:
              "INVALID_GAME_ID",
          });
        }

        server.log.error(error);

        return reply.status(500).send({
          error:
            "INTERNAL_ERROR",
        });
      } finally {
        client.release();
      }
    }
  );

}
