import type { FastifyInstance } from "fastify";
import { db } from "../db/database.js";

/*
 * =========================================================
 * TYPES
 * =========================================================
 */

type GameLoginBody = {
  cardId: number;
  uid: string;
  deviceCode: string;
};

type RechargeLoginBody = {
  cardId: number;
  uid: string;
  deviceCode: string;
};

type SessionLogoutBody = {
  deviceCode: string;
};

/*
 * =========================================================
 * DEVICE SESSION ROUTES
 * =========================================================
 *
 * REGLA FUNDAMENTAL:
 *
 * Un dispositivo solamente puede tener UN modo operativo
 * activo al mismo tiempo:
 *
 * - GAME
 * - RECHARGE
 * - ADMIN
 *
 * Al iniciar uno, los otros dos se cierran.
 * =========================================================
 */

export async function deviceSessionRoutes(
  server: FastifyInstance
) {

  /*
   * =====================================================
   * GAME LOGIN
   * =====================================================
   */

  server.post<{
    Body: GameLoginBody;
  }>(
    "/device-sessions/game/login",

    async (request, reply) => {

      const {
        cardId,
        uid,
        deviceCode,
      } = request.body;

      /*
       * -----------------------------------------------
       * VALIDACIONES
       * -----------------------------------------------
       */

      if (
        !Number.isSafeInteger(cardId) ||
        cardId <= 0
      ) {

        return reply.status(400).send({
          error: "INVALID_CARD_ID",
        });
      }

      if (
        typeof uid !== "string" ||
        uid.trim().length === 0
      ) {

        return reply.status(400).send({
          error: "INVALID_UID",
        });
      }

      if (
        typeof deviceCode !== "string" ||
        deviceCode.trim().length === 0
      ) {

        return reply.status(400).send({
          error: "INVALID_DEVICE_CODE",
        });
      }

      const client =
        await db.connect();

      try {

        await client.query("BEGIN");

        /*
         * -----------------------------------------------
         * DISPOSITIVO
         * -----------------------------------------------
         */

        const deviceResult =
          await client.query(
            `
            select
                id,
                device_code,
                name,
                device_type,
                status

            from devices

            where device_code = $1

            limit 1

            for update
            `,
            [
              deviceCode.trim(),
            ]
          );

        if (
          deviceResult.rowCount === 0
        ) {

          await client.query("ROLLBACK");

          return reply.status(404).send({
            error: "DEVICE_NOT_FOUND",
          });
        }

        const device =
          deviceResult.rows[0];

        if (
          device.status !== "ACTIVE"
        ) {

          await client.query("ROLLBACK");

          return reply.status(409).send({
            error: "DEVICE_NOT_ACTIVE",
          });
        }

        /*
         * -----------------------------------------------
         * TARJETA GAME
         * -----------------------------------------------
         */

        const cardResult =
          await client.query(
            `
            select
                card_id,
                uid,
                card_type,
                status

            from cards

            where card_id = $1

            limit 1

            for update
            `,
            [
              cardId,
            ]
          );

        if (
          cardResult.rowCount === 0
        ) {

          await client.query("ROLLBACK");

          return reply.status(404).send({
            error: "CARD_NOT_FOUND",
          });
        }

        const card =
          cardResult.rows[0];

        if (
          card.uid.toUpperCase() !==
          uid.trim().toUpperCase()
        ) {

          await client.query("ROLLBACK");

          return reply.status(409).send({
            error: "UID_MISMATCH",
          });
        }

        if (
          card.card_type !== "GAME"
        ) {

          await client.query("ROLLBACK");

          return reply.status(409).send({
            error: "CARD_NOT_GAME",
          });
        }

        if (
          card.status !== "ACTIVE"
        ) {

          await client.query("ROLLBACK");

          return reply.status(409).send({
            error: "CARD_NOT_ACTIVE",
          });
        }

        /*
         * -----------------------------------------------
         * JUEGO ASIGNADO
         * -----------------------------------------------
         */

        const gameResult =
          await client.query(
            `
            select
                gc.status as game_card_status,

                g.id as game_id,
                g.game_code,
                g.name,
                g.price,
                g.status as game_status

            from game_cards gc

            join games g
                on g.id = gc.game_id

            where gc.card_id = $1

            limit 1
            `,
            [
              cardId,
            ]
          );

        if (
          gameResult.rowCount === 0
        ) {

          await client.query("ROLLBACK");

          return reply.status(409).send({
            error:
              "GAME_CARD_NOT_ASSIGNED",
          });
        }

        const game =
          gameResult.rows[0];

        if (
          game.game_card_status !==
          "ACTIVE"
        ) {

          await client.query("ROLLBACK");

          return reply.status(409).send({
            error:
              "GAME_CARD_NOT_ACTIVE",
          });
        }

        if (
          game.game_status !== "ACTIVE"
        ) {

          await client.query("ROLLBACK");

          return reply.status(409).send({
            error:
              "GAME_NOT_ACTIVE",
          });
        }

        /*
         * =================================================
         * CERRAR OTROS MODOS
         * =================================================
         *
         * GAME será el único modo activo.
         */

        /*
         * Cerrar RECHARGE.
         */

        await client.query(
          `
          update device_recharge_sessions

          set
              status = 'CLOSED',
              ended_at = now()

          where device_id = $1

            and status = 'ACTIVE'

            and ended_at is null
          `,
          [
            device.id,
          ]
        );

        /*
         * Cerrar ADMIN.
         *
         * ESTE ERA EL CASO QUE FALTABA.
         */

        await client.query(
          `
          update device_admin_sessions

          set
              status = 'CLOSED',
              ended_at = now()

          where device_id = $1

            and status = 'ACTIVE'

            and ended_at is null
          `,
          [
            device.id,
          ]
        );

        /*
         * -----------------------------------------------
         * DEVICE TYPE
         * -----------------------------------------------
         */

        await client.query(
          `
          update devices

          set
              device_type = 'GAME',
              updated_at = now()

          where id = $1
          `,
          [
            device.id,
          ]
        );

        /*
         * -----------------------------------------------
         * SESIÓN GAME EXISTENTE
         * -----------------------------------------------
         */

        const existingResult =
          await client.query(
            `
            select
                id,
                game_id,
                opened_by_card_id,
                started_at

            from device_game_sessions

            where device_id = $1

              and status = 'ACTIVE'

              and ended_at is null

            limit 1

            for update
            `,
            [
              device.id,
            ]
          );

        if (
          existingResult.rowCount &&
          existingResult.rowCount > 0
        ) {

          const existing =
            existingResult.rows[0];

          /*
           * Ya estaba exactamente en este juego.
           */

          if (
            existing.game_id ===
            game.game_id
          ) {

            if (
              Number(
                existing.opened_by_card_id
              ) !==
              cardId
            ) {

              await client.query(
                `
                update device_game_sessions

                set
                    opened_by_card_id = $1

                where id = $2
                `,
                [
                  cardId,
                  existing.id,
                ]
              );
            }

            await client.query("COMMIT");

            return {
              authenticated: true,

              mode: "GAME",

              reusedSession: true,

              sessionId:
                existing.id,

              device: {
                code:
                  device.device_code,

                name:
                  device.name,
              },

              gameCard: {
                cardId:
                  Number(
                    card.card_id
                  ),

                uid:
                  card.uid,
              },

              game: {
                code:
                  game.game_code,

                name:
                  game.name,

                price:
                  Number(
                    game.price
                  ),
              },

              startedAt:
                existing.started_at,
            };
          }

          /*
           * Era otro juego.
           */

          await client.query(
            `
            update device_game_sessions

            set
                status = 'CLOSED',
                ended_at = now()

            where id = $1
            `,
            [
              existing.id,
            ]
          );
        }

        /*
         * -----------------------------------------------
         * NUEVA SESIÓN GAME
         * -----------------------------------------------
         */

        const sessionResult =
          await client.query(
            `
            insert into device_game_sessions (
                device_id,
                game_id,
                opened_by_card_id,
                status
            )
            values (
                $1,
                $2,
                $3,
                'ACTIVE'
            )

            returning
                id,
                started_at
            `,
            [
              device.id,
              game.game_id,
              cardId,
            ]
          );

        const session =
          sessionResult.rows[0];

        await client.query("COMMIT");

        return {
          authenticated: true,

          mode: "GAME",

          reusedSession: false,

          sessionId:
            session.id,

          device: {
            code:
              device.device_code,

            name:
              device.name,
          },

          gameCard: {
            cardId:
              Number(
                card.card_id
              ),

            uid:
              card.uid,
          },

          game: {
            code:
              game.game_code,

            name:
              game.name,

            price:
              Number(
                game.price
              ),
          },

          startedAt:
            session.started_at,
        };

      } catch (error) {

        await client.query("ROLLBACK");

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
   * GAME CURRENT
   * =====================================================
   */

  server.get<{
    Params: {
      deviceCode: string;
    };
  }>(
    "/device-sessions/game/current/:deviceCode",

    async (request, reply) => {

      const result =
        await db.query(
          `
          select
              s.id as session_id,
              s.started_at,

              d.device_code,
              d.name as device_name,

              c.card_id as game_card_id,
              c.uid as game_card_uid,

              g.game_code,
              g.name as game_name,
              g.price

          from device_game_sessions s

          join devices d
              on d.id = s.device_id

          join games g
              on g.id = s.game_id

          left join cards c
              on c.card_id =
                 s.opened_by_card_id

          where d.device_code = $1

            and s.status = 'ACTIVE'

            and s.ended_at is null

          limit 1
          `,
          [
            request.params
              .deviceCode
              .trim(),
          ]
        );

      if (
        result.rowCount === 0
      ) {

        return reply.status(404).send({
          error:
            "NO_ACTIVE_GAME_SESSION",
        });
      }

      const row =
        result.rows[0];

      return {
        active: true,

        mode: "GAME",

        sessionId:
          row.session_id,

        device: {
          code:
            row.device_code,

          name:
            row.device_name,
        },

        gameCard:
          row.game_card_id !== null
            ? {
                cardId:
                  Number(
                    row.game_card_id
                  ),

                uid:
                  row.game_card_uid,
              }
            : null,

        game: {
          code:
            row.game_code,

          name:
            row.game_name,

          price:
            Number(
              row.price
            ),
        },

        startedAt:
          row.started_at,
      };
    }
  );

  /*
   * =====================================================
   * GAME LOGOUT
   * =====================================================
   */

  server.post<{
    Body: SessionLogoutBody;
  }>(
    "/device-sessions/game/logout",

    async (request, reply) => {

      const {
        deviceCode,
      } = request.body;

      if (
        typeof deviceCode !== "string" ||
        deviceCode.trim().length === 0
      ) {

        return reply.status(400).send({
          error:
            "INVALID_DEVICE_CODE",
        });
      }

      const result =
        await db.query(
          `
          update device_game_sessions s

          set
              status = 'CLOSED',
              ended_at = now()

          from devices d

          where s.device_id = d.id

            and d.device_code = $1

            and s.status = 'ACTIVE'

            and s.ended_at is null

          returning s.id
          `,
          [
            deviceCode.trim(),
          ]
        );

      if (
        result.rowCount === 0
      ) {

        return reply.status(404).send({
          error:
            "NO_ACTIVE_GAME_SESSION",
        });
      }

      return {
        closed: true,

        mode: "GAME",

        sessionId:
          result.rows[0].id,
      };
    }
  );

  /*
   * =====================================================
   * RECHARGE LOGIN
   * =====================================================
   */

  server.post<{
    Body: RechargeLoginBody;
  }>(
    "/device-sessions/recharge/login",

    async (request, reply) => {

      const {
        cardId,
        uid,
        deviceCode,
      } = request.body;

      /*
       * -----------------------------------------------
       * VALIDACIONES
       * -----------------------------------------------
       */

      if (
        !Number.isSafeInteger(cardId) ||
        cardId <= 0
      ) {

        return reply.status(400).send({
          error: "INVALID_CARD_ID",
        });
      }

      if (
        typeof uid !== "string" ||
        uid.trim().length === 0
      ) {

        return reply.status(400).send({
          error: "INVALID_UID",
        });
      }

      if (
        typeof deviceCode !== "string" ||
        deviceCode.trim().length === 0
      ) {

        return reply.status(400).send({
          error: "INVALID_DEVICE_CODE",
        });
      }

      const client =
        await db.connect();

      try {

        await client.query("BEGIN");

        /*
         * -----------------------------------------------
         * DISPOSITIVO
         * -----------------------------------------------
         */

        const deviceResult =
          await client.query(
            `
            select
                id,
                device_code,
                name,
                device_type,
                status

            from devices

            where device_code = $1

            limit 1

            for update
            `,
            [
              deviceCode.trim(),
            ]
          );

        if (
          deviceResult.rowCount === 0
        ) {

          await client.query("ROLLBACK");

          return reply.status(404).send({
            error: "DEVICE_NOT_FOUND",
          });
        }

        const device =
          deviceResult.rows[0];

        if (
          device.status !== "ACTIVE"
        ) {

          await client.query("ROLLBACK");

          return reply.status(409).send({
            error: "DEVICE_NOT_ACTIVE",
          });
        }

        /*
         * -----------------------------------------------
         * RECHARGE CARD
         * -----------------------------------------------
         */

        const cardResult =
          await client.query(
            `
            select
                card_id,
                uid,
                card_type,
                status

            from cards

            where card_id = $1

            limit 1

            for update
            `,
            [
              cardId,
            ]
          );

        if (
          cardResult.rowCount === 0
        ) {

          await client.query("ROLLBACK");

          return reply.status(404).send({
            error: "CARD_NOT_FOUND",
          });
        }

        const card =
          cardResult.rows[0];

        if (
          card.uid.toUpperCase() !==
          uid.trim().toUpperCase()
        ) {

          await client.query("ROLLBACK");

          return reply.status(409).send({
            error: "UID_MISMATCH",
          });
        }

        if (
          card.card_type !==
          "RECHARGE"
        ) {

          await client.query("ROLLBACK");

          return reply.status(409).send({
            error:
              "CARD_NOT_RECHARGE",
          });
        }

        if (
          card.status !==
          "ACTIVE"
        ) {

          await client.query("ROLLBACK");

          return reply.status(409).send({
            error:
              "CARD_NOT_ACTIVE",
          });
        }

        /*
         * -----------------------------------------------
         * PUNTO DE RECARGA
         * -----------------------------------------------
         */

        const pointResult =
          await client.query(
            `
            select
                rc.status as recharge_card_status,

                rp.id as recharge_point_id,
                rp.recharge_code,
                rp.name,
                rp.status as recharge_point_status

            from recharge_cards rc

            join recharge_points rp
                on rp.id =
                   rc.recharge_point_id

            where rc.card_id = $1

            limit 1
            `,
            [
              cardId,
            ]
          );

        if (
          pointResult.rowCount === 0
        ) {

          await client.query("ROLLBACK");

          return reply.status(409).send({
            error:
              "RECHARGE_CARD_NOT_ASSIGNED",
          });
        }

        const point =
          pointResult.rows[0];

        if (
          point.recharge_card_status !==
          "ACTIVE"
        ) {

          await client.query("ROLLBACK");

          return reply.status(409).send({
            error:
              "RECHARGE_CARD_NOT_ACTIVE",
          });
        }

        if (
          point.recharge_point_status !==
          "ACTIVE"
        ) {

          await client.query("ROLLBACK");

          return reply.status(409).send({
            error:
              "RECHARGE_POINT_NOT_ACTIVE",
          });
        }

        /*
         * =================================================
         * CERRAR OTROS MODOS
         * =================================================
         *
         * RECHARGE será el único modo activo.
         */

        /*
         * Cerrar GAME.
         */

        await client.query(
          `
          update device_game_sessions

          set
              status = 'CLOSED',
              ended_at = now()

          where device_id = $1

            and status = 'ACTIVE'

            and ended_at is null
          `,
          [
            device.id,
          ]
        );

        /*
         * Cerrar ADMIN.
         *
         * ESTE ERA EL CASO QUE FALTABA.
         */

        await client.query(
          `
          update device_admin_sessions

          set
              status = 'CLOSED',
              ended_at = now()

          where device_id = $1

            and status = 'ACTIVE'

            and ended_at is null
          `,
          [
            device.id,
          ]
        );

        /*
         * -----------------------------------------------
         * DEVICE TYPE
         * -----------------------------------------------
         */

        await client.query(
          `
          update devices

          set
              device_type = 'RECHARGE',
              updated_at = now()

          where id = $1
          `,
          [
            device.id,
          ]
        );

        /*
         * -----------------------------------------------
         * SESIÓN EXISTENTE
         * -----------------------------------------------
         */

        const existingResult =
          await client.query(
            `
            select
                id,
                recharge_point_id,
                opened_by_card_id,
                started_at

            from device_recharge_sessions

            where device_id = $1

              and status = 'ACTIVE'

              and ended_at is null

            limit 1

            for update
            `,
            [
              device.id,
            ]
          );

        if (
          existingResult.rowCount &&
          existingResult.rowCount > 0
        ) {

          const existing =
            existingResult.rows[0];

          if (
            existing.recharge_point_id ===
            point.recharge_point_id
          ) {

            if (
              Number(
                existing.opened_by_card_id
              ) !==
              cardId
            ) {

              await client.query(
                `
                update device_recharge_sessions

                set
                    opened_by_card_id = $1

                where id = $2
                `,
                [
                  cardId,
                  existing.id,
                ]
              );
            }

            await client.query("COMMIT");

            return {
              authenticated: true,

              mode: "RECHARGE",

              reusedSession: true,

              sessionId:
                existing.id,

              device: {
                code:
                  device.device_code,

                name:
                  device.name,
              },

              rechargeCard: {
                cardId:
                  Number(
                    card.card_id
                  ),

                uid:
                  card.uid,
              },

              rechargePoint: {
                code:
                  point.recharge_code,

                name:
                  point.name,
              },

              startedAt:
                existing.started_at,
            };
          }

          await client.query(
            `
            update device_recharge_sessions

            set
                status = 'CLOSED',
                ended_at = now()

            where id = $1
            `,
            [
              existing.id,
            ]
          );
        }

        /*
         * -----------------------------------------------
         * NUEVA SESIÓN RECHARGE
         * -----------------------------------------------
         */

        const sessionResult =
          await client.query(
            `
            insert into device_recharge_sessions (
                device_id,
                recharge_point_id,
                opened_by_card_id,
                status
            )
            values (
                $1,
                $2,
                $3,
                'ACTIVE'
            )

            returning
                id,
                started_at
            `,
            [
              device.id,
              point.recharge_point_id,
              cardId,
            ]
          );

        const session =
          sessionResult.rows[0];

        await client.query("COMMIT");

        return {
          authenticated: true,

          mode: "RECHARGE",

          reusedSession: false,

          sessionId:
            session.id,

          device: {
            code:
              device.device_code,

            name:
              device.name,
          },

          rechargeCard: {
            cardId:
              Number(
                card.card_id
              ),

            uid:
              card.uid,
          },

          rechargePoint: {
            code:
              point.recharge_code,

            name:
              point.name,
          },

          startedAt:
            session.started_at,
        };

      } catch (error) {

        await client.query("ROLLBACK");

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
   * RECHARGE CURRENT
   * =====================================================
   */

  server.get<{
    Params: {
      deviceCode: string;
    };
  }>(
    "/device-sessions/recharge/current/:deviceCode",

    async (request, reply) => {

      const result =
        await db.query(
          `
          select
              s.id as session_id,
              s.started_at,

              d.device_code,
              d.name as device_name,

              c.card_id as recharge_card_id,
              c.uid as recharge_card_uid,

              rp.recharge_code,
              rp.name as recharge_point_name

          from device_recharge_sessions s

          join devices d
              on d.id = s.device_id

          join recharge_points rp
              on rp.id =
                 s.recharge_point_id

          left join cards c
              on c.card_id =
                 s.opened_by_card_id

          where d.device_code = $1

            and s.status = 'ACTIVE'

            and s.ended_at is null

          limit 1
          `,
          [
            request.params
              .deviceCode
              .trim(),
          ]
        );

      if (
        result.rowCount === 0
      ) {

        return reply.status(404).send({
          error:
            "NO_ACTIVE_RECHARGE_SESSION",
        });
      }

      const row =
        result.rows[0];

      return {
        active: true,

        mode: "RECHARGE",

        sessionId:
          row.session_id,

        device: {
          code:
            row.device_code,

          name:
            row.device_name,
        },

        rechargeCard:
          row.recharge_card_id !== null
            ? {
                cardId:
                  Number(
                    row.recharge_card_id
                  ),

                uid:
                  row.recharge_card_uid,
              }
            : null,

        rechargePoint: {
          code:
            row.recharge_code,

          name:
            row.recharge_point_name,
        },

        startedAt:
          row.started_at,
      };
    }
  );

  /*
   * =====================================================
   * RECHARGE LOGOUT
   * =====================================================
   */

  server.post<{
    Body: SessionLogoutBody;
  }>(
    "/device-sessions/recharge/logout",

    async (request, reply) => {

      const {
        deviceCode,
      } = request.body;

      if (
        typeof deviceCode !== "string" ||
        deviceCode.trim().length === 0
      ) {

        return reply.status(400).send({
          error:
            "INVALID_DEVICE_CODE",
        });
      }

      const result =
        await db.query(
          `
          update device_recharge_sessions s

          set
              status = 'CLOSED',
              ended_at = now()

          from devices d

          where s.device_id = d.id

            and d.device_code = $1

            and s.status = 'ACTIVE'

            and s.ended_at is null

          returning s.id
          `,
          [
            deviceCode.trim(),
          ]
        );

      if (
        result.rowCount === 0
      ) {

        return reply.status(404).send({
          error:
            "NO_ACTIVE_RECHARGE_SESSION",
        });
      }

      return {
        closed: true,

        mode: "RECHARGE",

        sessionId:
          result.rows[0].id,
      };
    }
  );
}