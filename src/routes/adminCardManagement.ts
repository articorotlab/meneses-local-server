import type {
  FastifyInstance,
} from "fastify";

import {
  db,
} from "../db/database.js";


/*
 * =========================================================
 * TYPES
 * =========================================================
 */

type ManagedCardType =
  | "GAME"
  | "RECHARGE";


type ManagedCardStatus =
  | "ACTIVE"
  | "INACTIVE";


type ManagedCardsQuery = {
  deviceCode?: string;
  type?: string;
};


type UpdateManagedCardStatusBody = {
  deviceCode: string;
  status: ManagedCardStatus;
};


type AuthorizeAdminCardBody = {
  idempotencyKey: string;

  deviceCode: string;

  authorizingCardId: number;
  authorizingUid: string;

  targetUid: string;
};


type ConfirmAdminCardBody = {
  registrationId: string;

  deviceCode: string;

  authorizingCardId: number;
  authorizingUid: string;

  targetUid: string;

  writtenCardId: number;
};


type FailAdminCardBody = {
  registrationId: string;

  deviceCode: string;

  authorizingCardId: number;
  authorizingUid: string;

  reason: string;
};


/*
 * =========================================================
 * HELPERS
 * =========================================================
 */

function normalizeUid(
  value: string
) {

  return value
    .trim()
    .toUpperCase();
}


function isManagedCardType(
  value: string
): value is ManagedCardType {

  return (
    value === "GAME" ||
    value === "RECHARGE"
  );
}


function isManagedCardStatus(
  value: string
): value is ManagedCardStatus {

  return (
    value === "ACTIVE" ||
    value === "INACTIVE"
  );
}


/*
 * =========================================================
 * ROUTES
 * =========================================================
 */

export async function adminCardManagementRoutes(
  server: FastifyInstance
) {

  /*
   * =======================================================
   * ADMIN SESSION
   * =======================================================
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

        join cards c
            on c.card_id = s.admin_card_id

        where d.device_code = $1

          and d.status = 'ACTIVE'

          and s.status = 'ACTIVE'
          and s.ended_at is null

          and c.card_type = 'ADMIN'
          and c.status = 'ACTIVE'

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
   * =======================================================
   * VALIDAR ADMIN FÍSICO
   *
   * Este helper no solamente comprueba que exista una
   * sesión ADMIN.
   *
   * También comprueba que la tarjeta que Android acaba de
   * leer corresponde a la tarjeta ADMIN activa.
   * =======================================================
   */

  async function validateAuthorizingAdmin(
    client: any,
    deviceCode: string,
    cardId: number,
    uid: string
  ) {

    const result =
      await client.query(
        `
        select
            d.id as device_id,
            d.device_code,

            s.id as session_id,
            s.admin_card_id,

            c.card_id,
            c.uid,
            c.card_type,
            c.status

        from devices d

        join device_admin_sessions s
            on s.device_id = d.id

        join cards c
            on c.card_id = s.admin_card_id

        where d.device_code = $1

          and d.status = 'ACTIVE'

          and s.status = 'ACTIVE'
          and s.ended_at is null

          and s.admin_card_id = $2

          and c.card_id = $2
          and upper(c.uid) = upper($3)

          and c.card_type = 'ADMIN'
          and c.status = 'ACTIVE'

        limit 1

        for update of s, c
        `,
        [
          deviceCode.trim(),
          cardId,
          normalizeUid(uid),
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
   * =======================================================
   * LISTAR TARJETAS GAME / RECHARGE
   *
   * GET
   * /admin/managed-cards
   *
   * ?deviceCode=ULEFONE-DEV-01&type=GAME
   *
   * o
   *
   * ?deviceCode=ULEFONE-DEV-01&type=RECHARGE
   * =======================================================
   */

  server.get<{
    Querystring: ManagedCardsQuery;
  }>(
    "/admin/managed-cards",

    async (
      request,
      reply
    ) => {

      const deviceCode =
        request.query
          .deviceCode;


      const type =
        request.query.type;


      if (
        typeof deviceCode !==
          "string" ||
        deviceCode.trim()
          .length === 0
      ) {

        return reply
          .status(400)
          .send({
            error:
              "INVALID_DEVICE_CODE",
          });
      }


      if (
        typeof type !==
          "string" ||
        !isManagedCardType(
          type
        )
      ) {

        return reply
          .status(400)
          .send({
            error:
              "INVALID_CARD_TYPE",

            message:
              "El tipo debe ser GAME o RECHARGE.",
          });
      }


      const client =
        await db.connect();


      try {

        await client.query(
          "BEGIN"
        );


        const admin =
          await getAdminActor(
            client,
            deviceCode
          );


        if (
          admin === null
        ) {

          await client.query(
            "ROLLBACK"
          );


          return reply
            .status(403)
            .send({
              error:
                "ADMIN_PERMISSION_REQUIRED",

              message:
                "Se necesita una sesión ADMIN activa.",
            });
        }


        if (
          type === "GAME"
        ) {

          const result =
            await client.query(
              `
              select
                  c.card_id,
                  c.uid,
                  c.card_type,
                  c.status,

                  gc.status
                    as assignment_status,

                  g.id
                    as owner_id,

                  g.name
                    as owner_name,

                  g.status
                    as owner_status

              from cards c

              join game_cards gc
                  on gc.card_id =
                     c.card_id

              join games g
                  on g.id =
                     gc.game_id

              where c.card_type =
                    'GAME'

                and gc.status <>
                    'RETIRED'

              order by
                  g.name asc,
                  c.card_id asc
              `
            );


          await client.query(
            "COMMIT"
          );


          return {
            type:
              "GAME",

            cards:
              result.rows.map(
                (
                  row: any
                ) => ({
                  cardId:
                    Number(
                      row.card_id
                    ),

                  uid:
                    row.uid,

                  type:
                    row.card_type,

                  status:
                    row.status,

                  assignmentStatus:
                    row.assignment_status,

                  owner: {
                    id:
                      row.owner_id,

                    name:
                      row.owner_name,

                    status:
                      row.owner_status,
                  },
                })
              ),
          };
        }


        const result =
          await client.query(
            `
            select
                c.card_id,
                c.uid,
                c.card_type,
                c.status,

                rc.status
                  as assignment_status,

                rp.id
                  as owner_id,

                rp.name
                  as owner_name,

                rp.status
                  as owner_status

            from cards c

            join recharge_cards rc
                on rc.card_id =
                   c.card_id

            join recharge_points rp
                on rp.id =
                   rc.recharge_point_id

            where c.card_type =
                  'RECHARGE'

              and rc.status <>
                  'RETIRED'

            order by
                rp.name asc,
                c.card_id asc
            `
          );


        await client.query(
          "COMMIT"
        );


        return {
          type:
            "RECHARGE",

          cards:
            result.rows.map(
              (
                row: any
              ) => ({
                cardId:
                  Number(
                    row.card_id
                  ),

                uid:
                  row.uid,

                type:
                  row.card_type,

                status:
                  row.status,

                assignmentStatus:
                  row.assignment_status,

                owner: {
                  id:
                    row.owner_id,

                  name:
                    row.owner_name,

                  status:
                    row.owner_status,
                },
              })
            ),
        };


      } catch (
        error
      ) {

        await client.query(
          "ROLLBACK"
        );


        server.log.error(
          error
        );


        return reply
          .status(500)
          .send({
            error:
              "INTERNAL_ERROR",
          });


      } finally {

        client.release();
      }
    }
  );


  /*
   * =======================================================
   * ACTIVAR / DESACTIVAR GAME O RECHARGE CARD
   *
   * PATCH
   * /admin/managed-cards/:cardId/status
   *
   * BODY:
   *
   * {
   *   "deviceCode": "...",
   *   "status": "INACTIVE"
   * }
   *
   * o ACTIVE para reactivarla.
   * =======================================================
   */

  server.patch<{
    Params: {
      cardId: string;
    };

    Body:
      UpdateManagedCardStatusBody;
  }>(
    "/admin/managed-cards/:cardId/status",

    async (
      request,
      reply
    ) => {

      const cardId =
        Number(
          request.params
            .cardId
        );


      const {
        deviceCode,
        status,
      } =
        request.body;


      if (
        !Number.isSafeInteger(
          cardId
        ) ||
        cardId <= 0
      ) {

        return reply
          .status(400)
          .send({
            error:
              "INVALID_CARD_ID",
          });
      }


      if (
        typeof deviceCode !==
          "string" ||
        deviceCode.trim()
          .length === 0
      ) {

        return reply
          .status(400)
          .send({
            error:
              "INVALID_DEVICE_CODE",
          });
      }


      if (
        typeof status !==
          "string" ||
        !isManagedCardStatus(
          status
        )
      ) {

        return reply
          .status(400)
          .send({
            error:
              "INVALID_CARD_STATUS",

            message:
              "El estado debe ser ACTIVE o INACTIVE.",
          });
      }


      const client =
        await db.connect();


      try {

        await client.query(
          "BEGIN"
        );


        const admin =
          await getAdminActor(
            client,
            deviceCode
          );


        if (
          admin === null
        ) {

          await client.query(
            "ROLLBACK"
          );


          return reply
            .status(403)
            .send({
              error:
                "ADMIN_PERMISSION_REQUIRED",
            });
        }


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
          cardResult.rowCount ===
          0
        ) {

          await client.query(
            "ROLLBACK"
          );


          return reply
            .status(404)
            .send({
              error:
                "CARD_NOT_FOUND",
            });
        }


        const card =
          cardResult.rows[0];


        if (
          card.card_type !==
            "GAME" &&
          card.card_type !==
            "RECHARGE"
        ) {

          await client.query(
            "ROLLBACK"
          );


          return reply
            .status(409)
            .send({
              error:
                "CARD_TYPE_NOT_MANAGEABLE",

              message:
                "Este endpoint solamente administra tarjetas GAME y RECHARGE.",
            });
        }


        /*
         * Una asignación RETIRED es histórica y ya no puede
         * volver a ACTIVE / INACTIVE.
         */

        const assignmentStatusResult =
          await client.query(
            card.card_type === "GAME"
              ? `
                select status

                from game_cards

                where card_id = $1

                limit 1

                for update
                `
              : `
                select status

                from recharge_cards

                where card_id = $1

                limit 1

                for update
                `,
            [
              cardId,
            ]
          );


        if (
          assignmentStatusResult.rowCount ===
          0
        ) {

          await client.query(
            "ROLLBACK"
          );


          return reply
            .status(404)
            .send({
              error:
                "CARD_ASSIGNMENT_NOT_FOUND",
            });
        }


        if (
          assignmentStatusResult
            .rows[0]
            .status ===
          "RETIRED"
        ) {

          await client.query(
            "ROLLBACK"
          );


          return reply
            .status(409)
            .send({
              error:
                "CARD_ASSIGNMENT_RETIRED",

              message:
                "La tarjeta fue desvinculada definitivamente y no puede reactivarse.",
            });
        }


        /*
         * Estado principal de la tarjeta.
         */

        await client.query(
          `
          update cards

          set
              status = $2,
              updated_at = now()

          where card_id = $1
          `,
          [
            cardId,
            status,
          ]
        );


        if (
          card.card_type ===
          "GAME"
        ) {

          /*
           * También desactivamos/reactivamos
           * la asignación GAME.
           */

          await client.query(
            `
            update game_cards

            set
                status = $2,
                updated_at = now()

            where card_id = $1
            `,
            [
              cardId,
              status,
            ]
          );


          /*
           * Si se desactiva mientras está siendo
           * utilizada, la sesión queda cerrada.
           */

          if (
            status ===
            "INACTIVE"
          ) {

            await client.query(
              `
              update device_game_sessions

              set
                  status = 'CLOSED',
                  ended_at = now()

              where opened_by_card_id = $1

                and status = 'ACTIVE'

                and ended_at is null
              `,
              [
                cardId,
              ]
            );
          }

        } else {

          await client.query(
            `
            update recharge_cards

            set
                status = $2,
                updated_at = now()

            where card_id = $1
            `,
            [
              cardId,
              status,
            ]
          );


          if (
            status ===
            "INACTIVE"
          ) {

            await client.query(
              `
              update device_recharge_sessions

              set
                  status = 'CLOSED',
                  ended_at = now()

              where opened_by_card_id = $1

                and status = 'ACTIVE'

                and ended_at is null
              `,
              [
                cardId,
              ]
            );
          }
        }


        await client.query(
          "COMMIT"
        );


        return {
          updated:
            true,

          card: {
            cardId,

            uid:
              card.uid,

            type:
              card.card_type,

            status,
          },
        };


      } catch (
        error
      ) {

        await client.query(
          "ROLLBACK"
        );


        server.log.error(
          error
        );


        return reply
          .status(500)
          .send({
            error:
              "INTERNAL_ERROR",
          });


      } finally {

        client.release();
      }
    }
  );


  /*
   * =======================================================
   * DESVINCULAR GAME / RECHARGE CARD
   *
   * POST
   * /admin/managed-cards/:cardId/unlink
   *
   * BODY:
   * {
   *   "deviceCode": "ULEFONE-DEV-01"
   * }
   *
   * IMPORTANTE:
   *
   * - NO elimina cards;
   * - NO elimina game_cards/recharge_cards;
   * - conserva sesiones y transacciones históricas;
   * - cards queda INACTIVE;
   * - la asignación queda RETIRED;
   * - el juego/taquilla queda PENDING_SETUP.
   * =======================================================
   */

  server.post<{
    Params: {
      cardId: string;
    };

    Body: {
      deviceCode: string;
    };
  }>(
    "/admin/managed-cards/:cardId/unlink",

    async (
      request,
      reply
    ) => {

      const cardId =
        Number(
          request.params
            .cardId
        );


      const deviceCode =
        request.body
          ?.deviceCode;


      if (
        !Number.isSafeInteger(
          cardId
        ) ||
        cardId <= 0
      ) {

        return reply
          .status(400)
          .send({
            error:
              "INVALID_CARD_ID",
          });
      }


      if (
        typeof deviceCode !==
          "string" ||
        deviceCode.trim()
          .length === 0
      ) {

        return reply
          .status(400)
          .send({
            error:
              "INVALID_DEVICE_CODE",
          });
      }


      const client =
        await db.connect();


      try {

        await client.query(
          "BEGIN"
        );


        const admin =
          await getAdminActor(
            client,
            deviceCode
          );


        if (
          admin === null
        ) {

          await client.query(
            "ROLLBACK"
          );


          return reply
            .status(403)
            .send({
              error:
                "ADMIN_PERMISSION_REQUIRED",

              message:
                "Se necesita una sesión ADMIN activa.",
            });
        }


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
          cardResult.rowCount ===
          0
        ) {

          await client.query(
            "ROLLBACK"
          );


          return reply
            .status(404)
            .send({
              error:
                "CARD_NOT_FOUND",
            });
        }


        const card =
          cardResult.rows[0];


        if (
          card.card_type !==
            "GAME" &&
          card.card_type !==
            "RECHARGE"
        ) {

          await client.query(
            "ROLLBACK"
          );


          return reply
            .status(409)
            .send({
              error:
                "CARD_TYPE_NOT_MANAGEABLE",

              message:
                "Sólo se pueden desvincular tarjetas GAME o RECHARGE.",
            });
        }


        if (
          card.card_type ===
          "GAME"
        ) {

          const assignmentResult =
            await client.query(
              `
              select
                  gc.id,
                  gc.game_id,
                  gc.status,
                  g.name

              from game_cards gc

              join games g
                  on g.id =
                     gc.game_id

              where gc.card_id = $1

              limit 1

              for update of gc, g
              `,
              [
                cardId,
              ]
            );


          if (
            assignmentResult.rowCount ===
            0
          ) {

            await client.query(
              "ROLLBACK"
            );


            return reply
              .status(404)
              .send({
                error:
                  "GAME_CARD_ASSIGNMENT_NOT_FOUND",
              });
          }


          const assignment =
            assignmentResult.rows[0];


          if (
            assignment.status ===
            "RETIRED"
          ) {

            await client.query(
              "ROLLBACK"
            );


            return reply
              .status(409)
              .send({
                error:
                  "CARD_ALREADY_UNLINKED",
              });
          }


          const otherCurrentResult =
            await client.query(
              `
              select card_id

              from game_cards

              where game_id = $1

                and card_id <> $2

                and status in (
                    'ACTIVE',
                    'INACTIVE',
                    'BLOCKED'
                )

              limit 1
              `,
              [
                assignment.game_id,
                cardId,
              ]
            );


          if (
            otherCurrentResult.rowCount &&
            otherCurrentResult.rowCount > 0
          ) {

            await client.query(
              "ROLLBACK"
            );


            return reply
              .status(409)
              .send({
                error:
                  "GAME_HAS_ANOTHER_CURRENT_CARD",
              });
          }


          await client.query(
            `
            update device_game_sessions

            set
                status = 'CLOSED',
                ended_at = now()

            where opened_by_card_id = $1

              and status = 'ACTIVE'

              and ended_at is null
            `,
            [
              cardId,
            ]
          );


          await client.query(
            `
            update cards

            set
                status = 'INACTIVE',
                updated_at = now()

            where card_id = $1
            `,
            [
              cardId,
            ]
          );


          await client.query(
            `
            update game_cards

            set
                status = 'RETIRED',
                updated_at = now()

            where card_id = $1
            `,
            [
              cardId,
            ]
          );


          await client.query(
            `
            update games

            set
                status = 'PENDING_SETUP',
                updated_at = now()

            where id = $1
            `,
            [
              assignment.game_id,
            ]
          );


          await client.query(
            "COMMIT"
          );


          return {
            unlinked:
              true,

            type:
              "GAME",

            card: {
              cardId,
              status:
                "INACTIVE",

              assignmentStatus:
                "RETIRED",
            },

            owner: {
              id:
                assignment.game_id,

              name:
                assignment.name,

              status:
                "PENDING_SETUP",
            },
          };
        }


        const assignmentResult =
          await client.query(
            `
            select
                rc.id,
                rc.recharge_point_id,
                rc.status,
                rp.name

            from recharge_cards rc

            join recharge_points rp
                on rp.id =
                   rc.recharge_point_id

            where rc.card_id = $1

            limit 1

            for update of rc, rp
            `,
            [
              cardId,
            ]
          );


        if (
          assignmentResult.rowCount ===
          0
        ) {

          await client.query(
            "ROLLBACK"
          );


          return reply
            .status(404)
            .send({
              error:
                "RECHARGE_CARD_ASSIGNMENT_NOT_FOUND",
            });
        }


        const assignment =
          assignmentResult.rows[0];


        if (
          assignment.status ===
          "RETIRED"
        ) {

          await client.query(
            "ROLLBACK"
          );


          return reply
            .status(409)
            .send({
              error:
                "CARD_ALREADY_UNLINKED",
            });
        }


        const otherCurrentResult =
          await client.query(
            `
            select card_id

            from recharge_cards

            where recharge_point_id = $1

              and card_id <> $2

              and status in (
                  'ACTIVE',
                  'INACTIVE',
                  'BLOCKED'
              )

            limit 1
            `,
            [
              assignment.recharge_point_id,
              cardId,
            ]
          );


        if (
          otherCurrentResult.rowCount &&
          otherCurrentResult.rowCount > 0
        ) {

          await client.query(
            "ROLLBACK"
          );


          return reply
            .status(409)
            .send({
              error:
                "RECHARGE_POINT_HAS_ANOTHER_CURRENT_CARD",
            });
        }


        await client.query(
          `
          update device_recharge_sessions

          set
              status = 'CLOSED',
              ended_at = now()

          where opened_by_card_id = $1

            and status = 'ACTIVE'

            and ended_at is null
          `,
          [
            cardId,
          ]
        );


        await client.query(
          `
          update cards

          set
              status = 'INACTIVE',
              updated_at = now()

          where card_id = $1
          `,
          [
            cardId,
          ]
        );


        await client.query(
          `
          update recharge_cards

          set
              status = 'RETIRED',
              updated_at = now()

          where card_id = $1
          `,
          [
            cardId,
          ]
        );


        await client.query(
          `
          update recharge_points

          set
              status = 'PENDING_SETUP',
              updated_at = now()

          where id = $1
          `,
          [
            assignment.recharge_point_id,
          ]
        );


        await client.query(
          "COMMIT"
        );


        return {
          unlinked:
            true,

          type:
            "RECHARGE",

          card: {
            cardId,
            status:
              "INACTIVE",

            assignmentStatus:
              "RETIRED",
          },

          owner: {
            id:
              assignment.recharge_point_id,

            name:
              assignment.name,

            status:
              "PENDING_SETUP",
          },
        };


      } catch (
        error
      ) {

        await client.query(
          "ROLLBACK"
        );


        server.log.error(
          error
        );


        return reply
          .status(500)
          .send({
            error:
              "INTERNAL_ERROR",
          });


      } finally {

        client.release();
      }
    }
  );


  /*
   * =======================================================
   * AUTORIZAR CREACIÓN DE NUEVA ADMIN CARD
   *
   * Paso 1:
   * Android acaba de leer una ADMIN física.
   *
   * Paso 2:
   * Android ya leyó el UID de la tarjeta vacía.
   *
   * Todavía NO se crea cards.
   *
   * POST /admin/admin-cards/authorize
   * =======================================================
   */

  server.post<{
    Body:
      AuthorizeAdminCardBody;
  }>(
    "/admin/admin-cards/authorize",

    async (
      request,
      reply
    ) => {

      const {
        idempotencyKey,
        deviceCode,
        authorizingCardId,
        authorizingUid,
        targetUid,
      } =
        request.body;


      if (
        typeof idempotencyKey !==
          "string" ||
        idempotencyKey.trim()
          .length === 0
      ) {

        return reply
          .status(400)
          .send({
            error:
              "INVALID_IDEMPOTENCY_KEY",
          });
      }


      if (
        typeof deviceCode !==
          "string" ||
        deviceCode.trim()
          .length === 0
      ) {

        return reply
          .status(400)
          .send({
            error:
              "INVALID_DEVICE_CODE",
          });
      }


      if (
        !Number.isSafeInteger(
          authorizingCardId
        ) ||
        authorizingCardId <= 0
      ) {

        return reply
          .status(400)
          .send({
            error:
              "INVALID_ADMIN_CARD_ID",
          });
      }


      if (
        typeof authorizingUid !==
          "string" ||
        authorizingUid.trim()
          .length === 0
      ) {

        return reply
          .status(400)
          .send({
            error:
              "INVALID_ADMIN_UID",
          });
      }


      if (
        typeof targetUid !==
          "string" ||
        targetUid.trim()
          .length === 0
      ) {

        return reply
          .status(400)
          .send({
            error:
              "INVALID_TARGET_UID",
          });
      }


      const normalizedTargetUid =
        normalizeUid(
          targetUid
        );


      const client =
        await db.connect();


      try {

        await client.query(
          "BEGIN"
        );


        /*
         * Debe ser la ADMIN que Android acaba
         * de presentar físicamente.
         */

        const authorizer =
          await validateAuthorizingAdmin(
            client,
            deviceCode,
            authorizingCardId,
            authorizingUid
          );


        if (
          authorizer === null
        ) {

          await client.query(
            "ROLLBACK"
          );


          return reply
            .status(403)
            .send({
              error:
                "ADMIN_CARD_AUTHORIZATION_REQUIRED",

              message:
                "Acerca una tarjeta ADMIN activa para autorizar la operación.",
            });
        }


        /*
         * Idempotencia.
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
              idempotencyKey.trim(),
            ]
          );


        if (
          previousResult.rowCount &&
          previousResult.rowCount >
            0
        ) {

          const previous =
            previousResult.rows[0];


          await client.query(
            "COMMIT"
          );


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
                previous
                  .reserved_card_id
              ),

            uid:
              previous.target_uid,

            cardType:
              previous
                .target_card_type,

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
         * El UID nuevo no puede existir.
         */

        const existingResult =
          await client.query(
            `
            select
                card_id,
                card_type,
                status

            from cards

            where upper(uid) =
                  upper($1)

            limit 1
            `,
            [
              normalizedTargetUid,
            ]
          );


        if (
          existingResult.rowCount &&
          existingResult.rowCount >
            0
        ) {

          await client.query(
            "ROLLBACK"
          );


          return reply
            .status(409)
            .send({
              error:
                "UID_ALREADY_REGISTERED",

              cardId:
                Number(
                  existingResult
                    .rows[0]
                    .card_id
                ),
            });
        }


        /*
         * Evitar otro registro pendiente
         * sobre la misma tarjeta física.
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
              normalizedTargetUid,
            ]
          );


        if (
          pendingResult.rowCount &&
          pendingResult.rowCount >
            0
        ) {

          await client.query(
            "ROLLBACK"
          );


          return reply
            .status(409)
            .send({
              error:
                "UID_HAS_PENDING_REGISTRATION",

              registrationId:
                pendingResult
                  .rows[0]
                  .id,
            });
        }


        /*
         * Reservar Card ID.
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
         * Registro PENDING.
         *
         * Todavía NO existe la tarjeta
         * definitiva en cards.
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

                status
            )
            values (
                $1,

                $2,

                $3,

                'ADMIN',
                $3,

                $4,
                'ADMIN',

                $5,

                'PENDING'
            )

            returning *
            `,
            [
              idempotencyKey.trim(),

              authorizer.device_id,

              authorizingCardId,

              normalizedTargetUid,

              reservedCardId,
            ]
          );


        const registration =
          registrationResult.rows[0];


        await client.query(
          "COMMIT"
        );


        return {
          authorized:
            true,

          duplicated:
            false,

          registrationId:
            registration.id,

          status:
            registration.status,

          authorizingAdmin: {
            cardId:
              authorizingCardId,

            uid:
              normalizeUid(
                authorizingUid
              ),
          },

          cardId:
            reservedCardId,

          uid:
            normalizedTargetUid,

          cardType:
            "ADMIN",

          initialState: {
            balance:
              0,

            transactionCounter:
              0,

            status:
              "ACTIVE",
          },
        };


      } catch (
        error: any
      ) {

        await client.query(
          "ROLLBACK"
        );


        if (
          error?.code ===
          "23505"
        ) {

          return reply
            .status(409)
            .send({
              error:
                "ADMIN_CARD_REGISTRATION_CONFLICT",
            });
        }


        server.log.error(
          error
        );


        return reply
          .status(500)
          .send({
            error:
              "INTERNAL_ERROR",
          });


      } finally {

        client.release();
      }
    }
  );


  /*
   * =======================================================
   * CONFIRMAR NUEVA ADMIN CARD
   *
   * Android ya:
   *
   * 1. escribió la NTAG215;
   * 2. volvió a leerla;
   * 3. comprobó que coincide.
   *
   * Ahora creamos el registro definitivo.
   * =======================================================
   */

  server.post<{
    Body:
      ConfirmAdminCardBody;
  }>(
    "/admin/admin-cards/confirm",

    async (
      request,
      reply
    ) => {

      const {
        registrationId,
        deviceCode,
        authorizingCardId,
        authorizingUid,
        targetUid,
        writtenCardId,
      } =
        request.body;


      if (
        typeof registrationId !==
          "string" ||
        registrationId.trim()
          .length === 0
      ) {

        return reply
          .status(400)
          .send({
            error:
              "INVALID_REGISTRATION_ID",
          });
      }


      if (
        !Number.isSafeInteger(
          writtenCardId
        ) ||
        writtenCardId <= 0
      ) {

        return reply
          .status(400)
          .send({
            error:
              "INVALID_WRITTEN_CARD_ID",
          });
      }


      const client =
        await db.connect();


      try {

        await client.query(
          "BEGIN"
        );


        const authorizer =
          await validateAuthorizingAdmin(
            client,
            deviceCode,
            authorizingCardId,
            authorizingUid
          );


        if (
          authorizer === null
        ) {

          await client.query(
            "ROLLBACK"
          );


          return reply
            .status(403)
            .send({
              error:
                "ADMIN_CARD_AUTHORIZATION_REQUIRED",
            });
        }


        const registrationResult =
          await client.query(
            `
            select *

            from card_registrations

            where id = $1

            limit 1

            for update
            `,
            [
              registrationId.trim(),
            ]
          );


        if (
          registrationResult
            .rowCount === 0
        ) {

          await client.query(
            "ROLLBACK"
          );


          return reply
            .status(404)
            .send({
              error:
                "REGISTRATION_NOT_FOUND",
            });
        }


        const registration =
          registrationResult
            .rows[0];


        /*
         * Confirmación repetida.
         */

        if (
          registration.status ===
          "CONFIRMED"
        ) {

          const existingCard =
            await client.query(
              `
              select
                  card_id,
                  uid,
                  card_type,
                  status,
                  balance,
                  transaction_counter

              from cards

              where card_id = $1

              limit 1
              `,
              [
                writtenCardId,
              ]
            );


          await client.query(
            "COMMIT"
          );


          return {
            confirmed:
              true,

            duplicated:
              true,

            registrationId:

              registration.id,

            card:
              existingCard.rows[0]
                ? {
                    cardId:
                      Number(
                        existingCard
                          .rows[0]
                          .card_id
                      ),

                    uid:
                      existingCard
                        .rows[0]
                        .uid,

                    type:
                      existingCard
                        .rows[0]
                        .card_type,

                    status:
                      existingCard
                        .rows[0]
                        .status,

                    balance:
                      Number(
                        existingCard
                          .rows[0]
                          .balance
                      ),

                    transactionCounter:
                      Number(
                        existingCard
                          .rows[0]
                          .transaction_counter
                      ),
                  }
                : null,
          };
        }


        if (
          registration.status !==
          "PENDING"
        ) {

          await client.query(
            "ROLLBACK"
          );


          return reply
            .status(409)
            .send({
              error:
                "REGISTRATION_NOT_PENDING",

              status:
                registration.status,
            });
        }


        if (
          registration
            .target_card_type !==
            "ADMIN"
        ) {

          await client.query(
            "ROLLBACK"
          );


          return reply
            .status(409)
            .send({
              error:
                "REGISTRATION_NOT_ADMIN",
            });
        }


        if (
          Number(
            registration
              .admin_card_id
          ) !==
            authorizingCardId ||

          Number(
            registration
              .actor_card_id
          ) !==
            authorizingCardId ||

          registration
            .actor_role !==
            "ADMIN"
        ) {

          await client.query(
            "ROLLBACK"
          );


          return reply
            .status(409)
            .send({
              error:
                "ADMIN_AUTHORIZATION_MISMATCH",
            });
        }


        if (
          Number(
            registration
              .reserved_card_id
          ) !==
            writtenCardId ||

          normalizeUid(
            registration.target_uid
          ) !==
            normalizeUid(
              targetUid
            )
        ) {

          await client.query(
            "ROLLBACK"
          );


          return reply
            .status(409)
            .send({
              error:
                "REGISTRATION_STATE_MISMATCH",
            });
        }


        /*
         * Crear ADMIN definitiva.
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
              'ADMIN',
              'ACTIVE',
              0,
              0
          )
          `,
          [
            writtenCardId,

            normalizeUid(
              targetUid
            ),
          ]
        );


        /*
         * Confirmar registro.
         */

        await client.query(
          `
          update card_registrations

          set
              status = 'CONFIRMED',
              confirmed_at = now()

          where id = $1
          `,
          [
            registration.id,
          ]
        );


        await client.query(
          "COMMIT"
        );


        return {
          confirmed:
            true,

          duplicated:
            false,

          registrationId:
            registration.id,

          createdByAdminCardId:
            authorizingCardId,

          card: {
            cardId:
              writtenCardId,

            uid:
              normalizeUid(
                targetUid
              ),

            type:
              "ADMIN",

            status:
              "ACTIVE",

            balance:
              0,

            transactionCounter:
              0,
          },
        };


      } catch (
        error: any
      ) {

        await client.query(
          "ROLLBACK"
        );


        if (
          error?.code ===
          "23505"
        ) {

          return reply
            .status(409)
            .send({
              error:
                "ADMIN_CARD_ALREADY_EXISTS",
            });
        }


        server.log.error(
          error
        );


        return reply
          .status(500)
          .send({
            error:
              "INTERNAL_ERROR",
          });


      } finally {

        client.release();
      }
    }
  );


  /*
   * =======================================================
   * FALLÓ CREACIÓN DE ADMIN
   * =======================================================
   */

  server.post<{
    Body:
      FailAdminCardBody;
  }>(
    "/admin/admin-cards/fail",

    async (
      request,
      reply
    ) => {

      const {
        registrationId,
        deviceCode,
        authorizingCardId,
        authorizingUid,
        reason,
      } =
        request.body;


      const client =
        await db.connect();


      try {

        await client.query(
          "BEGIN"
        );


        const authorizer =
          await validateAuthorizingAdmin(
            client,
            deviceCode,
            authorizingCardId,
            authorizingUid
          );


        if (
          authorizer === null
        ) {

          await client.query(
            "ROLLBACK"
          );


          return reply
            .status(403)
            .send({
              error:
                "ADMIN_CARD_AUTHORIZATION_REQUIRED",
            });
        }


        const result =
          await client.query(
            `
            update card_registrations

            set
                status = 'FAILED',
                failed_at = now(),
                failure_reason = $2

            where id = $1

              and target_card_type =
                  'ADMIN'

              and status =
                  'PENDING'

            returning id
            `,
            [
              registrationId.trim(),

              reason?.trim() ||
              "Fallo durante creación de ADMIN.",
            ]
          );


        if (
          result.rowCount === 0
        ) {

          await client.query(
            "ROLLBACK"
          );


          return reply
            .status(404)
            .send({
              error:
                "PENDING_ADMIN_REGISTRATION_NOT_FOUND",
            });
        }


        await client.query(
          "COMMIT"
        );


        return {
          failed:
            true,

          registrationId:
            result.rows[0].id,
        };


      } catch (
        error
      ) {

        await client.query(
          "ROLLBACK"
        );


        server.log.error(
          error
        );


        return reply
          .status(500)
          .send({
            error:
              "INTERNAL_ERROR",
          });


      } finally {

        client.release();
      }
    }
  );
}