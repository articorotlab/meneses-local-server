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

  server.get<{ Querystring: WebReportQuery }>(
    "/web/admin/reports/summary",
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
          select
              coalesce(sum(
                case
                  when transaction_type in ('RECHARGE', 'CARD_CREATED')
                   and recharge_point_id is not null
                  then amount
                  else 0
                end
              ), 0) as recharge_point_amount,

              coalesce(sum(
                case
                  when transaction_type = 'RECHARGE'
                   and recharge_point_id is not null
                  then amount
                  else 0
                end
              ), 0) as recharge_point_recharge_amount,

              coalesce(sum(
                case
                  when transaction_type = 'CARD_CREATED'
                   and recharge_point_id is not null
                  then amount
                  else 0
                end
              ), 0) as recharge_point_activation_amount,

              coalesce(sum(
                case
                  when transaction_type = 'CHARGE'
                   and game_id is not null
                  then amount
                  else 0
                end
              ), 0) as game_consumption_amount,

              coalesce(sum(
                case
                  when transaction_type = 'CHARGE'
                   and game_id is not null
                  then coalesce(quantity, 0)
                  else 0
                end
              ), 0) as game_people_count,

              coalesce(sum(
                case
                  when transaction_type = 'RECHARGE'
                   and actor_role = 'ADMIN'
                  then amount
                  else 0
                end
              ), 0) as admin_recharge_amount,

              coalesce(sum(
                case
                  when transaction_type = 'ADJUSTMENT'
                   and actor_role = 'ADMIN'
                  then amount
                  else 0
                end
              ), 0) as admin_adjustment_amount

          from transactions
          where card_write_status = 'CONFIRMED'
            and (
              coalesce(confirmed_at, created_at)
              at time zone $3
            )::date between $1::date and $2::date
          `,
          [from, to, REPORT_TIMEZONE]
        );

        const row = result.rows[0];

        return {
          from,
          to,
          timezone: REPORT_TIMEZONE,
          summary: {
            rechargePointAmount: Number(row.recharge_point_amount),
            rechargePointRechargeAmount: Number(
              row.recharge_point_recharge_amount
            ),
            rechargePointActivationAmount: Number(
              row.recharge_point_activation_amount
            ),
            gameConsumptionAmount: Number(row.game_consumption_amount),
            gamePeopleCount: Number(row.game_people_count),
            admin: {
              rechargeAmount: Number(row.admin_recharge_amount),
              adjustmentAmount: Number(row.admin_adjustment_amount),
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

  server.get<{ Querystring: WebReportQuery }>(
    "/web/admin/reports/games",
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
          select
              g.id as game_id,
              g.name,
              g.price as current_price,

              to_char(
                (
                  coalesce(
                    t.confirmed_at,
                    t.created_at
                  )
                  at time zone $3
                )::date,
                'YYYY-MM-DD'
              ) as report_date,

              coalesce(
                sum(t.amount),
                0
              ) as consumption_amount,

              coalesce(
                sum(
                  coalesce(
                    t.quantity,
                    0
                  )
                ),
                0
              ) as people_count

          from transactions t

          join games g
              on g.id = t.game_id

          where t.card_write_status =
                'CONFIRMED'

            and t.transaction_type =
                'CHARGE'

            and (
              coalesce(
                t.confirmed_at,
                t.created_at
              )
              at time zone $3
            )::date
            between $1::date
                and $2::date

          group by
              g.id,
              g.name,
              g.price,
              report_date

          order by
              g.name asc,
              report_date desc
          `,
          [from, to, REPORT_TIMEZONE]
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
              peopleCount:
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

          const dailyPeople =
            Number(
              row.people_count
            );

          game.consumptionAmount +=
            dailyAmount;

          game.peopleCount +=
            dailyPeople;

          game.dailyBreakdown.push({
            date:
              row.report_date,
            consumptionAmount:
              dailyAmount,
            peopleCount:
              dailyPeople,
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
          timezone: REPORT_TIMEZONE,
          games,
        };
      } catch (error) {
        server.log.error(error);
        return reply.status(500).send({ error: "INTERNAL_ERROR" });
      } finally {
        client.release();
      }
    }
  );

  server.get<{ Querystring: WebReportQuery }>(
    "/web/admin/reports/recharge-points",
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
          select
              rp.id as recharge_point_id,
              rp.name,

              to_char(
                (
                  coalesce(
                    t.confirmed_at,
                    t.created_at
                  )
                  at time zone $3
                )::date,
                'YYYY-MM-DD'
              ) as report_date,

              coalesce(
                sum(
                  case
                    when t.transaction_type = 'RECHARGE'
                    then t.amount
                    else 0
                  end
                ),
                0
              ) as recharged_amount,

              coalesce(
                sum(
                  case
                    when t.transaction_type = 'CARD_CREATED'
                    then t.amount
                    else 0
                  end
                ),
                0
              ) as activation_amount,

              coalesce(
                sum(t.amount),
                0
              ) as total_income_amount

          from transactions t

          join recharge_points rp
              on rp.id =
                 t.recharge_point_id

          where t.card_write_status =
                'CONFIRMED'

            and t.transaction_type in (
                'RECHARGE',
                'CARD_CREATED'
            )

            and t.recharge_point_id
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

          group by
              rp.id,
              rp.name,
              report_date

          order by
              rp.name asc,
              report_date desc
          `,
          [from, to, REPORT_TIMEZONE]
        );

        const rechargePointsMap =
          new Map<string, any>();

        for (
          const row of result.rows
        ) {

          const rechargePointId =
            row.recharge_point_id;

          let rechargePoint =
            rechargePointsMap.get(
              rechargePointId
            );

          if (
            rechargePoint === undefined
          ) {

            rechargePoint = {
              rechargePointId,
              name:
                row.name,
              rechargedAmount:
                0,
              activationAmount:
                0,
              totalIncomeAmount:
                0,
              dailyBreakdown:
                [],
            };

            rechargePointsMap.set(
              rechargePointId,
              rechargePoint
            );
          }

          const dailyRechargeAmount =
            Number(
              row.recharged_amount
            );

          const dailyActivationAmount =
            Number(
              row.activation_amount
            );

          const dailyTotalIncomeAmount =
            Number(
              row.total_income_amount
            );

          rechargePoint.rechargedAmount +=
            dailyRechargeAmount;

          rechargePoint.activationAmount +=
            dailyActivationAmount;

          rechargePoint.totalIncomeAmount +=
            dailyTotalIncomeAmount;

          rechargePoint.dailyBreakdown.push({
            date:
              row.report_date,
            rechargedAmount:
              dailyRechargeAmount,
            activationAmount:
              dailyActivationAmount,
            totalIncomeAmount:
              dailyTotalIncomeAmount,
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
                  b.totalIncomeAmount !==
                  a.totalIncomeAmount
                ) {
                  return (
                    b.totalIncomeAmount -
                    a.totalIncomeAmount
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
