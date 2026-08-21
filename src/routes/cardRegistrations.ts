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

type AuthorizeBody = {
  idempotencyKey: string;
  deviceCode: string;
  targetUid: string;
  targetCardType: string;
};


type ConfirmBody = {
  registrationId: string;
  deviceCode: string;
  targetUid: string;
  writtenCardId: number;
  writtenCardType: string;
};


type FailBody = {
  registrationId: string;
  deviceCode: string;
  reason: string;
};


/*
 * =========================================================
 * CARD REGISTRATION ROUTES
 * =========================================================
 *
 * CUSTOMER:
 *
 * ADMIN     ✓
 * RECHARGE  ✓
 * GAME      ✗
 *
 * REGLA ECONÓMICA:
 *
 * Si una CUSTOMER es creada desde una sesión RECHARGE,
 * se registra automáticamente el costo de activación
 * configurado en operational_settings.
 *
 * Ese importe:
 *
 * - NO aumenta el saldo CUSTOMER;
 * - pertenece a la TAQUILLA que creó la tarjeta;
 * - queda registrado históricamente como CARD_CREATED;
 * - conserva el precio vigente al momento de creación.
 *
 * Si ADMIN crea directamente una CUSTOMER:
 *
 * - la tarjeta sí se crea;
 * - NO se registra ingreso de activación en TAQUILLA.
 * =========================================================
 */

export async function cardRegistrationRoutes(
  server: FastifyInstance
) {

  /*
   * =====================================================
   * AUTHORIZE
   * =====================================================
   *
   * POST /card-registrations/authorize
   */

  server.post<{
    Body:
      AuthorizeBody;
  }>(
    "/card-registrations/authorize",

    async (
      request,
      reply
    ) => {

      const {
        idempotencyKey,
        deviceCode,
        targetUid,
        targetCardType,
      } =
        request.body;


      /*
       * -----------------------------------------------
       * VALIDACIONES
       * -----------------------------------------------
       */

      if (
        typeof idempotencyKey !==
          "string" ||
        idempotencyKey
          .trim()
          .length ===
          0
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
        deviceCode
          .trim()
          .length ===
          0
      ) {

        return reply
          .status(400)
          .send({
            error:
              "INVALID_DEVICE_CODE",
          });
      }


      if (
        typeof targetUid !==
          "string" ||
        targetUid
          .trim()
          .length ===
          0
      ) {

        return reply
          .status(400)
          .send({
            error:
              "INVALID_TARGET_UID",
          });
      }


      /*
       * Primera versión general:
       *
       * solamente CUSTOMER.
       */

      if (
        targetCardType !==
        "CUSTOMER"
      ) {

        return reply
          .status(400)
          .send({
            error:
              "UNSUPPORTED_CARD_TYPE",

            message:
              "Por ahora este flujo solamente permite crear CUSTOMER.",
          });
      }


      const normalizedDeviceCode =
        deviceCode.trim();


      const normalizedUid =
        targetUid
          .trim()
          .toUpperCase();


      const client =
        await db.connect();


      try {

        await client.query(
          "BEGIN"
        );


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
          previousResult.rowCount >
            0
        ) {

          const registration =
            previousResult.rows[0];


          await client.query(
            "COMMIT"
          );


          return {
            authorized:
              registration.status ===
              "PENDING",

            duplicated:
              true,

            registrationId:
              registration.id,

            status:
              registration.status,

            actor: {
              role:
                registration
                  .actor_role,

              cardId:
                Number(
                  registration
                    .actor_card_id
                ),
            },

            cardId:
              Number(
                registration
                  .reserved_card_id
              ),

            uid:
              registration
                .target_uid,

            cardType:
              registration
                .target_card_type,
          };
        }


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
                status

            from devices

            where device_code = $1

            limit 1

            for update
            `,
            [
              normalizedDeviceCode,
            ]
          );


        if (
          deviceResult.rowCount ===
          0
        ) {

          await client.query(
            "ROLLBACK"
          );


          return reply
            .status(404)
            .send({
              error:
                "DEVICE_NOT_FOUND",
            });
        }


        const device =
          deviceResult.rows[0];


        if (
          device.status !==
          "ACTIVE"
        ) {

          await client.query(
            "ROLLBACK"
          );


          return reply
            .status(409)
            .send({
              error:
                "DEVICE_NOT_ACTIVE",
            });
        }


        /*
         * =================================================
         * DETERMINAR ACTOR
         * =================================================
         *
         * ADMIN tiene permiso.
         *
         * RECHARGE tiene permiso únicamente para CUSTOMER.
         */

        const adminResult =
          await client.query(
            `
            select
                s.id,
                s.admin_card_id

            from device_admin_sessions s

            where s.device_id = $1

              and s.status =
                  'ACTIVE'

              and s.ended_at
                  is null

            limit 1

            for update
            `,
            [
              device.id,
            ]
          );


        const rechargeResult =
          await client.query(
            `
            select
                s.id,
                s.opened_by_card_id,
                s.recharge_point_id,

                rp.recharge_code,
                rp.name
                  as recharge_point_name

            from device_recharge_sessions s

            join recharge_points rp
                on rp.id =
                   s.recharge_point_id

            where s.device_id = $1

              and s.status =
                  'ACTIVE'

              and s.ended_at
                  is null

            limit 1

            for update of s
            `,
            [
              device.id,
            ]
          );


        let actorRole:
          "ADMIN" |
          "RECHARGE";


        let actorCardId:
          number;


        let rechargePointId:
          string | null =
            null;


        let rechargePoint:
          {
            code: string;
            name: string;
          } | null =
            null;


        if (
          adminResult.rowCount &&
          adminResult.rowCount >
            0
        ) {

          actorRole =
            "ADMIN";


          actorCardId =
            Number(
              adminResult
                .rows[0]
                .admin_card_id
            );


        } else if (
          rechargeResult.rowCount &&
          rechargeResult.rowCount >
            0
        ) {

          const session =
            rechargeResult
              .rows[0];


          if (
            session
              .opened_by_card_id ===
            null
          ) {

            await client.query(
              "ROLLBACK"
            );


            return reply
              .status(409)
              .send({
                error:
                  "RECHARGE_SESSION_HAS_NO_CARD",
              });
          }


          actorRole =
            "RECHARGE";


          actorCardId =
            Number(
              session
                .opened_by_card_id
            );


          rechargePointId =
            session
              .recharge_point_id;


          rechargePoint = {
            code:
              session
                .recharge_code,

            name:
              session
                .recharge_point_name,
          };


        } else {

          await client.query(
            "ROLLBACK"
          );


          return reply
            .status(403)
            .send({
              error:
                "CARD_REGISTRATION_PERMISSION_REQUIRED",

              message:
                "Se necesita una sesión ADMIN o RECHARGE activa para crear una CUSTOMER.",
            });
        }


        /*
         * -----------------------------------------------
         * UID YA REGISTRADO
         * -----------------------------------------------
         */

        const existingCardResult =
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
              normalizedUid,
            ]
          );


        if (
          existingCardResult
            .rowCount &&
          existingCardResult
            .rowCount >
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
                  existingCardResult
                    .rows[0]
                    .card_id
                ),
            });
        }


        /*
         * -----------------------------------------------
         * PENDING EXISTENTE
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

              and status =
                  'PENDING'

            limit 1
            `,
            [
              normalizedUid,
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

              cardId:
                Number(
                  pendingResult
                    .rows[0]
                    .reserved_card_id
                ),
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

                recharge_point_id,

                target_uid,
                target_card_type,
                reserved_card_id,

                status
            )

            values (
                $1,
                $2,

                $3,

                $4,
                $5,

                $6,

                $7,
                $8,
                $9,

                'PENDING'
            )

            returning *
            `,
            [
              idempotencyKey,

              device.id,

              actorRole ===
              "ADMIN"
                ? actorCardId
                : null,

              actorRole,

              actorCardId,

              rechargePointId,

              normalizedUid,

              targetCardType,

              reservedCardId,
            ]
          );


        const registration =
          registrationResult
            .rows[0];


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

          actor: {
            role:
              actorRole,

            cardId:
              actorCardId,

            rechargePoint,
          },

          cardId:
            reservedCardId,

          uid:
            normalizedUid,

          cardType:
            targetCardType,

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
   * =====================================================
   * CONFIRM
   * =====================================================
   *
   * POST /card-registrations/confirm
   */

  server.post<{
    Body:
      ConfirmBody;
  }>(
    "/card-registrations/confirm",

    async (
      request,
      reply
    ) => {

      const {
        registrationId,
        deviceCode,
        targetUid,
        writtenCardId,
        writtenCardType,
      } =
        request.body;


      /*
       * -----------------------------------------------
       * VALIDACIONES
       * -----------------------------------------------
       */

      if (
        typeof registrationId !==
          "string" ||
        registrationId
          .trim()
          .length ===
          0
      ) {

        return reply
          .status(400)
          .send({
            error:
              "INVALID_REGISTRATION_ID",
          });
      }


      if (
        typeof deviceCode !==
          "string" ||
        deviceCode
          .trim()
          .length ===
          0
      ) {

        return reply
          .status(400)
          .send({
            error:
              "INVALID_DEVICE_CODE",
          });
      }


      if (
        typeof targetUid !==
          "string" ||
        targetUid
          .trim()
          .length ===
          0
      ) {

        return reply
          .status(400)
          .send({
            error:
              "INVALID_TARGET_UID",
          });
      }


      if (
        !Number.isSafeInteger(
          writtenCardId
        ) ||
        writtenCardId <=
          0
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

                d.device_code

            from card_registrations r

            join devices d
                on d.id =
                   r.device_id

            where r.id = $1

            for update
            `,
            [
              registrationId,
            ]
          );


        if (
          registrationResult
            .rowCount ===
          0
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
         * -----------------------------------------------
         * DEVICE
         * -----------------------------------------------
         */

        if (
          registration
            .device_code !==
          deviceCode.trim()
        ) {

          await client.query(
            "ROLLBACK"
          );


          return reply
            .status(409)
            .send({
              error:
                "REGISTRATION_DEVICE_MISMATCH",
            });
        }


        /*
         * -----------------------------------------------
         * CONFIRMACIÓN REPETIDA
         * -----------------------------------------------
         */

        if (
          registration.status ===
          "CONFIRMED"
        ) {

          await client.query(
            "COMMIT"
          );


          return {
            confirmed:
              true,

            duplicated:
              true,

            registrationId,

            cardId:
              Number(
                registration
                  .reserved_card_id
              ),
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
                registration
                  .status,
            });
        }


        /*
         * -----------------------------------------------
         * VERIFICAR ACTOR SIGUE ACTIVO
         * -----------------------------------------------
         */

        if (
          registration
            .actor_role ===
          "ADMIN"
        ) {

          const sessionResult =
            await client.query(
              `
              select id

              from device_admin_sessions

              where device_id = $1

                and admin_card_id =
                    $2

                and status =
                    'ACTIVE'

                and ended_at
                    is null

              limit 1

              for update
              `,
              [
                registration
                  .device_id,

                registration
                  .actor_card_id,
              ]
            );


          if (
            sessionResult
              .rowCount ===
            0
          ) {

            await client.query(
              "ROLLBACK"
            );


            return reply
              .status(403)
              .send({
                error:
                  "ADMIN_SESSION_NO_LONGER_ACTIVE",
              });
          }


        } else if (
          registration
            .actor_role ===
          "RECHARGE"
        ) {

          const sessionResult =
            await client.query(
              `
              select id

              from device_recharge_sessions

              where device_id = $1

                and opened_by_card_id =
                    $2

                and recharge_point_id =
                    $3

                and status =
                    'ACTIVE'

                and ended_at
                    is null

              limit 1

              for update
              `,
              [
                registration
                  .device_id,

                registration
                  .actor_card_id,

                registration
                  .recharge_point_id,
              ]
            );


          if (
            sessionResult
              .rowCount ===
            0
          ) {

            await client.query(
              "ROLLBACK"
            );


            return reply
              .status(403)
              .send({
                error:
                  "RECHARGE_SESSION_NO_LONGER_ACTIVE",
              });
          }


        } else {

          await client.query(
            "ROLLBACK"
          );


          return reply
            .status(409)
            .send({
              error:
                "UNKNOWN_REGISTRATION_ACTOR",
            });
        }


        /*
         * -----------------------------------------------
         * VERIFICAR CONTENIDO NFC REPORTADO
         * -----------------------------------------------
         */

        if (
          Number(
            registration
              .reserved_card_id
          ) !==
            writtenCardId ||

          registration
            .target_card_type !==
            writtenCardType ||

          registration
            .target_uid
            .toUpperCase() !==
            targetUid
              .trim()
              .toUpperCase()
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
         * Actualmente solamente CUSTOMER.
         */

        if (
          writtenCardType !==
          "CUSTOMER"
        ) {

          await client.query(
            "ROLLBACK"
          );


          return reply
            .status(409)
            .send({
              error:
                "UNSUPPORTED_CARD_TYPE",
            });
        }


        /*
         * -----------------------------------------------
         * CREAR CARD DEFINITIVA
         * -----------------------------------------------
         *
         * IMPORTANTE:
         *
         * El costo de activación NO es saldo.
         *
         * La CUSTOMER siempre nace con:
         *
         * balance = 0
         * transaction_counter = 0
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
              'CUSTOMER',
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
         * =================================================
         * INGRESO POR ACTIVACIÓN DE TARJETA
         * =================================================
         *
         * Solamente cuando la CUSTOMER fue creada desde
         * una TAQUILLA.
         *
         * ADMIN puede crear CUSTOMER, pero esa creación
         * no se atribuye como ingreso a ninguna taquilla.
         * =================================================
         */

        let activationFee:
          number | null =
            null;


        if (
          registration
            .actor_role ===
          "RECHARGE"
        ) {

          /*
           * ---------------------------------------------
           * PRECIO VIGENTE
           * ---------------------------------------------
           */

          const settingsResult =
            await client.query(
              `
              select
                  customer_card_activation_fee

              from operational_settings

              where id = 1

              limit 1

              for share
              `
            );


          if (
            settingsResult
              .rowCount ===
            0
          ) {

            throw new Error(
              "OPERATIONAL_SETTINGS_NOT_FOUND"
            );
          }


          activationFee =
            Number(
              settingsResult
                .rows[0]
                .customer_card_activation_fee
            );


          if (
            !Number.isSafeInteger(
              activationFee
            ) ||
            activationFee <
              0
          ) {

            throw new Error(
              "INVALID_CUSTOMER_CARD_ACTIVATION_FEE"
            );
          }


          /*
           * ---------------------------------------------
           * CARD_CREATED
           * ---------------------------------------------
           *
           * La idempotency key es determinista:
           *
           * card-created:<registrationId>
           *
           * Así una misma activación nunca puede crear
           * dos ingresos.
           */

          const transactionIdempotencyKey =
            `card-created:${registrationId}`;


          await client.query(
            `
            insert into transactions (
                idempotency_key,

                card_id,
                device_id,

                transaction_type,
                amount,

                balance_before,
                balance_after,

                counter_before,
                counter_after,

                card_write_status,

                confirmed_at,

                unit_price,
                quantity,

                recharge_point_id,

                actor_role,
                actor_card_id
            )

            values (
                $1,

                $2,
                $3,

                'CARD_CREATED',
                $4,

                0,
                0,

                0,
                0,

                'CONFIRMED',

                now(),

                $5,
                1,

                $6,

                'RECHARGE',
                $7
            )

            on conflict (
                idempotency_key
            )

            do nothing
            `,
            [
              transactionIdempotencyKey,

              writtenCardId,

              registration
                .device_id,

              activationFee,

              /*
               * transactions_unit_price_check:
               *
               * unit_price debe ser > 0 cuando no es NULL.
               *
               * Permitimos configurar activación en $0,
               * por eso en ese caso guardamos NULL.
               */
              activationFee >
              0
                ? activationFee
                : null,

              registration
                .recharge_point_id,

              registration
                .actor_card_id,
            ]
          );
        }


        /*
         * -----------------------------------------------
         * CONFIRMAR REGISTRATION
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


        await client.query(
          "COMMIT"
        );


        return {
          confirmed:
            true,

          duplicated:
            false,

          registrationId,

          actor: {
            role:
              registration
                .actor_role,

            cardId:
              Number(
                registration
                  .actor_card_id
              ),
          },

          card: {
            cardId:
              writtenCardId,

            uid:
              targetUid
                .trim()
                .toUpperCase(),

            type:
              "CUSTOMER",

            status:
              "ACTIVE",

            balance:
              0,

            transactionCounter:
              0,
          },

          activation:
            registration
              .actor_role ===
            "RECHARGE"
              ? {
                  charged:
                    true,

                  amount:
                    activationFee,

                  rechargePointId:
                    registration
                      .recharge_point_id,
                }
              : {
                  charged:
                    false,

                  amount:
                    0,

                  rechargePointId:
                    null,
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
                "CARD_ALREADY_EXISTS",
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
   * =====================================================
   * FAIL
   * =====================================================
   *
   * POST /card-registrations/fail
   */

  server.post<{
    Body:
      FailBody;
  }>(
    "/card-registrations/fail",

    async (
      request,
      reply
    ) => {

      const {
        registrationId,
        deviceCode,
        reason,
      } =
        request.body;


      const result =
        await db.query(
          `
          update card_registrations r

          set
              status =
                'FAILED',

              failed_at =
                now(),

              failure_reason =
                $3

          from devices d

          where r.device_id =
                d.id

            and r.id =
                $1

            and d.device_code =
                $2

            and r.status =
                'PENDING'

          returning
              r.id,
              r.reserved_card_id,
              r.actor_role,
              r.actor_card_id
          `,
          [
            registrationId,

            deviceCode.trim(),

            reason ||
              "Fallo reportado por dispositivo.",
          ]
        );


      if (
        result.rowCount ===
        0
      ) {

        return reply
          .status(409)
          .send({
            error:
              "REGISTRATION_CANNOT_BE_FAILED",
          });
      }


      return {
        failed:
          true,

        registrationId,

        cardId:
          Number(
            result
              .rows[0]
              .reserved_card_id
          ),

        actor: {
          role:
            result
              .rows[0]
              .actor_role,

          cardId:
            Number(
              result
                .rows[0]
                .actor_card_id
            ),
        },
      };
    }
  );
}