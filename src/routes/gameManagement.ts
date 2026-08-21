import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { db } from "../db/database.js";


/*
 * =========================================================
 * TYPES
 * =========================================================
 */

type CreateGameBody = {
  deviceCode: string;
  name: string;
  price: number;
};

type UpdateGameBody = {
  deviceCode: string;
  name: string;
  price: number;
};

type PrepareGameCardBody = {
  idempotencyKey: string;
  deviceCode: string;
  gameId: string;
  targetUid: string;
};

type ConfirmGameCardBody = {
  registrationId: string;
  deviceCode: string;
  targetUid: string;
  writtenCardId: number;
};

type FailGameCardBody = {
  registrationId: string;
  deviceCode: string;
  reason: string;
};


/*
 * =========================================================
 * GAME MANAGEMENT
 * =========================================================
 *
 * Solamente ADMIN.
 *
 * Flujo:
 *
 * 1. crear game PENDING_SETUP
 * 2. preparar tarjeta GAME
 * 3. escribir NFC desde Android
 * 4. confirmar
 * 5. crear game_cards
 * 6. activar game
 * =========================================================
 */

export async function gameManagementRoutes(
  server: FastifyInstance
) {

  /*
   * =====================================================
   * HELPER: ADMIN SESSION
   * =====================================================
   */

  async function getAdminActor(
    client: any,
    deviceCode: string
  ) {

    const result =
      await client.query(
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

        for update of s
        `,
        [
          deviceCode.trim(),
        ]
      );

    if (
      result.rowCount === 0
    ) {

      return null;
    }

    return result.rows[0];
  }


  /*
   * =====================================================
   * CREAR JUEGO
   * =====================================================
   *
   * POST /admin/games
   * =====================================================
   */


server.post<{
  Body: CreateGameBody;
}>(
  "/admin/games",

  async (request, reply) => {

    const {
      deviceCode,
      name,
      price,
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

    if (
      typeof name !== "string" ||
      name.trim().length < 2
    ) {

      return reply.status(400).send({
        error:
          "INVALID_GAME_NAME",

        message:
          "El nombre del juego debe tener al menos 2 caracteres.",
      });
    }

    if (
      !Number.isSafeInteger(price) ||
      price <= 0
    ) {

      return reply.status(400).send({
        error:
          "INVALID_GAME_PRICE",

        message:
          "El precio debe ser un entero positivo.",
      });
    }

    const normalizedName =
      name.trim();

    const client =
      await db.connect();

    try {

      await client.query("BEGIN");

      const admin =
        await getAdminActor(
          client,
          deviceCode
        );

      if (
        admin === null
      ) {

        await client.query("ROLLBACK");

        return reply.status(403).send({
          error:
            "ADMIN_PERMISSION_REQUIRED",

          message:
            "Se necesita una sesión ADMIN activa.",
        });
      }

      /*
       * El administrador no captura códigos técnicos.
       * Generamos un UUID para el juego y usamos ese mismo
       * identificador para construir un game_code interno.
       *
       * El código no se muestra en la interfaz; queda disponible
       * para logs, soporte e integraciones futuras.
       */
      const gameId =
        randomUUID();

      const generatedCode =
        `GAME-${gameId.replace(/-/g, "").toUpperCase()}`;

      const result =
        await client.query(
          `
          insert into games (
              id,
              game_code,
              name,
              price,
              status
          )
          values (
              $1,
              $2,
              $3,
              $4,
              'PENDING_SETUP'
          )

          returning
              id,
              game_code,
              name,
              price,
              status,
              created_at
          `,
          [
            gameId,
            generatedCode,
            normalizedName,
            price,
          ]
        );

      const game =
        result.rows[0];

      await client.query("COMMIT");

      return {
        created: true,

        game: {
          id:
            game.id,

          code:
            game.game_code,

          name:
            game.name,

          price:
            Number(
              game.price
            ),

          status:
            game.status,

          createdAt:
            game.created_at,
        },

        nextStep:
          "CREATE_GAME_CARD",
      };

    } catch (error) {

      await client.query("ROLLBACK");

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
   * LISTAR JUEGOS
   * =====================================================
   *
   * GET /admin/games
   * =====================================================
   */

  server.get<{
    Querystring: {
      deviceCode?: string;
    };
  }>(
    "/admin/games",

    async (request, reply) => {

      const deviceCode =
        request.query.deviceCode;

      if (
        typeof deviceCode !== "string" ||
        deviceCode.trim().length === 0
      ) {

        return reply.status(400).send({
          error:
            "INVALID_DEVICE_CODE",
        });
      }

      const client =
        await db.connect();

      try {

        await client.query("BEGIN");

        const admin =
          await getAdminActor(
            client,
            deviceCode
          );

        if (
          admin === null
        ) {

          await client.query("ROLLBACK");

          return reply.status(403).send({
            error:
              "ADMIN_PERMISSION_REQUIRED",
          });
        }

        const result =
          await client.query(
            `
            select
                g.id,
                g.game_code,
                g.name,
                g.price,
                g.status,

                c.card_id,
                c.uid as game_card_uid,

                gc.status as game_card_status,

                g.created_at

            from games g

              left join lateral (
                  select
                      gc_inner.card_id,
                      gc_inner.status,
                      gc_inner.created_at

                  from game_cards gc_inner

                  where gc_inner.game_id = g.id

                    and gc_inner.status in (
                        'ACTIVE',
                        'INACTIVE',
                        'BLOCKED'
                    )

                  order by
                      case
                          when gc_inner.status = 'ACTIVE' then 1
                          when gc_inner.status = 'INACTIVE' then 2
                          when gc_inner.status = 'BLOCKED' then 3
                          else 4
                      end,
                      gc_inner.created_at desc

                  limit 1
              ) gc
                  on true

              left join cards c
                  on c.card_id = gc.card_id

              order by g.created_at desc
            `
          );

        await client.query("COMMIT");

        return {
          games:
            result.rows.map(
              (row: any) => ({
                id:
                  row.id,

                code:
                  row.game_code,

                name:
                  row.name,

                price:
                  Number(
                    row.price
                  ),

                status:
                  row.status,

                card:
                  row.card_id !== null
                    ? {
                        cardId:
                          Number(
                            row.card_id
                          ),

                        uid:
                          row.game_card_uid,

                        status:
                          row.game_card_status,
                      }
                    : null,

                createdAt:
                  row.created_at,
              })
            ),
        };

      } catch (error) {

        await client.query("ROLLBACK");

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
   * EDITAR JUEGO
   * =====================================================
   *
   * PUT /admin/games/:gameId
   *
   * Solo ADMIN.
   * Permite modificar nombre y precio.
   * La tarjeta física GAME NO se reescribe: solamente
   * identifica el cardId; nombre/precio viven en servidor.
   * =====================================================
   */

  server.put<{
    Params: {
      gameId: string;
    };
    Body: UpdateGameBody;
  }>(
    "/admin/games/:gameId",

    async (request, reply) => {

      const {
        gameId,
      } = request.params;

      const {
        deviceCode,
        name,
        price,
      } = request.body;

      if (
        typeof gameId !== "string" ||
        gameId.trim().length === 0
      ) {
        return reply.status(400).send({
          error: "INVALID_GAME_ID",
          message: "El juego no tiene un ID válido.",
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

      if (
        typeof name !== "string" ||
        name.trim().length < 2
      ) {
        return reply.status(400).send({
          error: "INVALID_GAME_NAME",
          message: "El nombre del juego debe tener al menos 2 caracteres.",
        });
      }

      if (
        !Number.isSafeInteger(price) ||
        price <= 0
      ) {
        return reply.status(400).send({
          error: "INVALID_GAME_PRICE",
          message: "El precio debe ser un entero positivo.",
        });
      }

      const normalizedName =
        name.trim();

      const client =
        await db.connect();

      try {

        await client.query("BEGIN");

        const admin =
          await getAdminActor(
            client,
            deviceCode
          );

        if (
          admin === null
        ) {
          await client.query("ROLLBACK");

          return reply.status(403).send({
            error: "ADMIN_PERMISSION_REQUIRED",
            message: "Se necesita una sesión ADMIN activa.",
          });
        }

        const currentResult =
          await client.query(
            `
            select
                id,
                game_code,
                name,
                price,
                status

            from games

            where id = $1

            limit 1

            for update
            `,
            [
              gameId.trim(),
            ]
          );

        if (
          currentResult.rowCount === 0
        ) {
          await client.query("ROLLBACK");

          return reply.status(404).send({
            error: "GAME_NOT_FOUND",
            message: "No se encontró el juego.",
          });
        }

        const result =
          await client.query(
            `
            update games

            set
                name = $2,
                price = $3

            where id = $1

            returning
                id,
                game_code,
                name,
                price,
                status,
                created_at
            `,
            [
              gameId.trim(),
              normalizedName,
              price,
            ]
          );

        const game =
          result.rows[0];

        await client.query("COMMIT");

        return {
          updated: true,

          game: {
            id:
              game.id,

            code:
              game.game_code,

            name:
              game.name,

            price:
              Number(
                game.price
              ),

            status:
              game.status,

            createdAt:
              game.created_at,
          },
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
   * PREPARAR TARJETA GAME
   * =====================================================
   *
   * POST /admin/games/card/authorize
   * =====================================================
   */

  server.post<{
    Body: PrepareGameCardBody;
  }>(
    "/admin/games/card/authorize",

    async (request, reply) => {

      const {
        idempotencyKey,
        deviceCode,
        gameId,
        targetUid,
      } = request.body;

      if (
        typeof idempotencyKey !== "string" ||
        idempotencyKey.trim().length === 0
      ) {

        return reply.status(400).send({
          error:
            "INVALID_IDEMPOTENCY_KEY",
        });
      }

      if (
        typeof deviceCode !== "string" ||
        deviceCode.trim().length === 0
      ) {

        return reply.status(400).send({
          error:
            "INVALID_DEVICE_CODE",
        });
      }

      if (
        typeof gameId !== "string" ||
        gameId.trim().length === 0
      ) {

        return reply.status(400).send({
          error:
            "INVALID_GAME_ID",
        });
      }

      if (
        typeof targetUid !== "string" ||
        targetUid.trim().length === 0
      ) {

        return reply.status(400).send({
          error:
            "INVALID_TARGET_UID",
        });
      }

      const normalizedUid =
        targetUid
          .trim()
          .toUpperCase();

      const client =
        await db.connect();

      try {

        await client.query("BEGIN");

        /*
         * -----------------------------------------------
         * IDEMPOTENCIA
         * -----------------------------------------------
         */

        const previousResult =
          await client.query(
            `
            select *

            from card_registrations

            where idempotency_key = $1

            limit 1
            `,
            [
              idempotencyKey,
            ]
          );

        if (
          previousResult.rowCount &&
          previousResult.rowCount > 0
        ) {

          const previous =
            previousResult.rows[0];

          await client.query("COMMIT");

          return {
            authorized:
              previous.status ===
              "PENDING",

            duplicated:
              true,

            registrationId:
              previous.id,

            status:
              previous.status,

            cardId:
              Number(
                previous.reserved_card_id
              ),

            uid:
              previous.target_uid,

            cardType:
              previous.target_card_type,

            gameId:
              previous.game_id,

            initialState: {
              balance:
                0,

              transactionCounter:
                0,

              status:
                "ACTIVE",
            },
          };
        }

        /*
         * -----------------------------------------------
         * ADMIN
         * -----------------------------------------------
         */

        const admin =
          await getAdminActor(
            client,
            deviceCode
          );

        if (
          admin === null
        ) {

          await client.query("ROLLBACK");

          return reply.status(403).send({
            error:
              "ADMIN_PERMISSION_REQUIRED",
          });
        }

        /*
         * -----------------------------------------------
         * GAME
         * -----------------------------------------------
         */

        const gameResult =
          await client.query(
            `
            select
                id,
                game_code,
                name,
                price,
                status

            from games

            where id = $1

            limit 1

            for update
            `,
            [
              gameId,
            ]
          );

        if (
          gameResult.rowCount === 0
        ) {

          await client.query("ROLLBACK");

          return reply.status(404).send({
            error:
              "GAME_NOT_FOUND",
          });
        }

        const game =
          gameResult.rows[0];

        if (
          game.status !==
          "PENDING_SETUP"
        ) {

          await client.query("ROLLBACK");

          return reply.status(409).send({
            error:
              "GAME_NOT_PENDING_SETUP",

            status:
              game.status,
          });
        }

        /*
         * -----------------------------------------------
         * GAME YA TIENE TARJETA
         * -----------------------------------------------
         */

        const assignmentResult =
          await client.query(
            `
            select
                card_id

            from game_cards

            where game_id = $1

              and status = 'ACTIVE'

            limit 1
            `,
            [
              gameId,
            ]
          );

        if (
          assignmentResult.rowCount &&
          assignmentResult.rowCount > 0
        ) {

          await client.query("ROLLBACK");

          return reply.status(409).send({
            error:
              "GAME_ALREADY_HAS_CARD",
          });
        }

        /*
         * -----------------------------------------------
         * UID EXISTENTE
         * -----------------------------------------------
         */

        const existingCardResult =
          await client.query(
            `
            select
                card_id,
                card_type

            from cards

            where upper(uid) =
                  upper($1)

            limit 1
            `,
            [
              normalizedUid,
            ]
          );

        if (
          existingCardResult.rowCount &&
          existingCardResult.rowCount > 0
        ) {

          await client.query("ROLLBACK");

          return reply.status(409).send({
            error:
              "UID_ALREADY_REGISTERED",
          });
        }

        /*
         * -----------------------------------------------
         * UID PENDING
         * -----------------------------------------------
         */

        const pendingResult =
          await client.query(
            `
            select
                id,
                reserved_card_id

            from card_registrations

            where upper(target_uid) =
                  upper($1)

              and status = 'PENDING'

            limit 1
            `,
            [
              normalizedUid,
            ]
          );

        if (
          pendingResult.rowCount &&
          pendingResult.rowCount > 0
        ) {

          await client.query("ROLLBACK");

          return reply.status(409).send({
            error:
              "UID_HAS_PENDING_REGISTRATION",

            registrationId:
              pendingResult.rows[0].id,
          });
        }

        /*
         * -----------------------------------------------
         * RESERVAR CARD ID
         * -----------------------------------------------
         */

        const sequenceResult =
          await client.query(
            `
            select
                nextval(
                  'card_id_seq'
                ) as card_id
            `
          );

        const reservedCardId =
          Number(
            sequenceResult
              .rows[0]
              .card_id
          );

        /*
         * -----------------------------------------------
         * REGISTRATION
         * -----------------------------------------------
         */

        const registrationResult =
          await client.query(
            `
            insert into card_registrations (
                idempotency_key,
                device_id,

                admin_card_id,

                actor_role,
                actor_card_id,

                target_uid,
                target_card_type,

                reserved_card_id,

                game_id,

                status
            )
            values (
                $1,
                $2,

                $3,

                'ADMIN',
                $3,

                $4,
                'GAME',

                $5,

                $6,

                'PENDING'
            )

            returning *
            `,
            [
              idempotencyKey,
              admin.device_id,
              admin.admin_card_id,
              normalizedUid,
              reservedCardId,
              gameId,
            ]
          );

        const registration =
          registrationResult.rows[0];

        await client.query("COMMIT");

        return {
          authorized:
            true,

          duplicated:
            false,

          registrationId:
            registration.id,

          status:
            registration.status,

          cardId:
            reservedCardId,

          uid:
            normalizedUid,

          cardType:
            "GAME",

          game: {
            id:
              game.id,

            code:
              game.game_code,

            name:
              game.name,

            price:
              Number(
                game.price
              ),
          },

          initialState: {
            balance:
              0,

            transactionCounter:
              0,

            status:
              "ACTIVE",
          },
        };

      } catch (error) {

        await client.query("ROLLBACK");

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
   * CONFIRMAR TARJETA GAME
   * =====================================================
   *
   * POST /admin/games/card/confirm
   * =====================================================
   */

  server.post<{
    Body: ConfirmGameCardBody;
  }>(
    "/admin/games/card/confirm",

    async (request, reply) => {

      const {
        registrationId,
        deviceCode,
        targetUid,
        writtenCardId,
      } = request.body;

      const client =
        await db.connect();

      try {

        await client.query("BEGIN");

        /*
         * -----------------------------------------------
         * REGISTRATION
         * -----------------------------------------------
         */

        const registrationResult =
          await client.query(
            `
            select
                r.*,
                d.device_code,

                g.game_code,
                g.name as game_name,
                g.price,
                g.status as game_status

            from card_registrations r

            join devices d
                on d.id = r.device_id

            join games g
                on g.id = r.game_id

            where r.id = $1

            for update of r, g
            `,
            [
              registrationId,
            ]
          );

        if (
          registrationResult.rowCount ===
          0
        ) {

          await client.query("ROLLBACK");

          return reply.status(404).send({
            error:
              "REGISTRATION_NOT_FOUND",
          });
        }

        const registration =
          registrationResult.rows[0];

        /*
         * -----------------------------------------------
         * DEVICE MATCH
         * -----------------------------------------------
         */

        if (
          registration.device_code !==
          deviceCode.trim()
        ) {

          await client.query("ROLLBACK");

          return reply.status(409).send({
            error:
              "REGISTRATION_DEVICE_MISMATCH",
          });
        }

        /*
         * -----------------------------------------------
         * IDEMPOTENCIA DE CONFIRM
         * -----------------------------------------------
         */

        if (
          registration.status ===
          "CONFIRMED"
        ) {

          await client.query("COMMIT");

          return {
            confirmed: true,
            duplicated: true,

            registrationId,

            cardId:
              Number(
                registration
                  .reserved_card_id
              ),

            game: {
              id:
                registration.game_id,

              code:
                registration.game_code,

              name:
                registration.game_name,

              price:
                Number(
                  registration.price
                ),
            },
          };
        }

        if (
          registration.status !==
          "PENDING"
        ) {

          await client.query("ROLLBACK");

          return reply.status(409).send({
            error:
              "REGISTRATION_NOT_PENDING",
          });
        }

        /*
         * -----------------------------------------------
         * TIPO
         * -----------------------------------------------
         */

        if (
          registration.target_card_type !==
          "GAME"
        ) {

          await client.query("ROLLBACK");

          return reply.status(409).send({
            error:
              "REGISTRATION_NOT_GAME",
          });
        }

        /*
         * -----------------------------------------------
         * ADMIN SIGUE ACTIVO
         * -----------------------------------------------
         */

        const admin =
          await getAdminActor(
            client,
            deviceCode
          );

        if (
          admin === null ||
          Number(
            admin.admin_card_id
          ) !==
          Number(
            registration.actor_card_id
          )
        ) {

          await client.query("ROLLBACK");

          return reply.status(403).send({
            error:
              "ADMIN_SESSION_NO_LONGER_ACTIVE",
          });
        }

        /*
         * -----------------------------------------------
         * VALIDAR ESTADO REPORTADO POR ANDROID
         * -----------------------------------------------
         */

        if (
          Number(
            registration.reserved_card_id
          ) !==
          writtenCardId ||

          registration
            .target_uid
            .toUpperCase() !==
          targetUid
            .trim()
            .toUpperCase()
        ) {

          await client.query("ROLLBACK");

          return reply.status(409).send({
            error:
              "REGISTRATION_STATE_MISMATCH",
          });
        }

        /*
         * -----------------------------------------------
         * CREAR CARD GAME
         * -----------------------------------------------
         */

        await client.query(
          `
          insert into cards (
              card_id,
              uid,
              card_type,
              status,
              balance,
              transaction_counter
          )
          values (
              $1,
              $2,
              'GAME',
              'ACTIVE',
              0,
              0
          )
          `,
          [
            writtenCardId,

            targetUid
              .trim()
              .toUpperCase(),
          ]
        );

        /*
         * -----------------------------------------------
         * ASIGNACIÓN GAME_CARD
         * -----------------------------------------------
         */

        await client.query(
          `
          insert into game_cards (
              card_id,
              game_id,
              status
          )
          values (
              $1,
              $2,
              'ACTIVE'
          )
          `,
          [
            writtenCardId,
            registration.game_id,
          ]
        );

        /*
         * -----------------------------------------------
         * ACTIVAR GAME
         * -----------------------------------------------
         */

        await client.query(
          `
          update games

          set
              status = 'ACTIVE',
              updated_at = now()

          where id = $1
          `,
          [
            registration.game_id,
          ]
        );

        /*
         * -----------------------------------------------
         * CONFIRM REGISTRATION
         * -----------------------------------------------
         */

        await client.query(
          `
          update card_registrations

          set
              status =
                'CONFIRMED',

              confirmed_at =
                now(),

              failed_at =
                null,

              failure_reason =
                null

          where id = $1
          `,
          [
            registrationId,
          ]
        );

        await client.query("COMMIT");

        return {
          confirmed:
            true,

          duplicated:
            false,

          registrationId,

          card: {
            cardId:
              writtenCardId,

            uid:
              targetUid
                .trim()
                .toUpperCase(),

            type:
              "GAME",

            status:
              "ACTIVE",
          },

          game: {
            id:
              registration.game_id,

            code:
              registration.game_code,

            name:
              registration.game_name,

            price:
              Number(
                registration.price
              ),

            status:
              "ACTIVE",
          },
        };

      } catch (error: any) {

        await client.query("ROLLBACK");

        if (
          error?.code ===
          "23505"
        ) {

          return reply.status(409).send({
            error:
              "GAME_CARD_ALREADY_EXISTS",
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
   * FAIL GAME CARD
   * =====================================================
   *
   * POST /admin/games/card/fail
   * =====================================================
   */

  server.post<{
    Body: FailGameCardBody;
  }>(
    "/admin/games/card/fail",

    async (request, reply) => {

      const {
        registrationId,
        deviceCode,
        reason,
      } = request.body;

      const result =
        await db.query(
          `
          update card_registrations r

          set
              status = 'FAILED',
              failed_at = now(),
              failure_reason = $3

          from devices d

          where r.device_id = d.id

            and r.id = $1

            and d.device_code = $2

            and r.target_card_type = 'GAME'

            and r.status = 'PENDING'

          returning
              r.id,
              r.reserved_card_id,
              r.game_id
          `,
          [
            registrationId,
            deviceCode.trim(),
            reason ||
              "Fallo creando tarjeta GAME.",
          ]
        );

      if (
        result.rowCount === 0
      ) {

        return reply.status(409).send({
          error:
            "REGISTRATION_CANNOT_BE_FAILED",
        });
      }

      return {
        failed: true,

        registrationId,

        cardId:
          Number(
            result.rows[0]
              .reserved_card_id
          ),

        gameId:
          result.rows[0]
            .game_id,
      };
    }
  );
}