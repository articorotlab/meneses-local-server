import type { FastifyInstance } from "fastify";
import { db } from "../db/database.js";

/*
 * =========================================================
 * TYPES
 * =========================================================
 */

type AdminLoginBody = {
  cardId: number;
  uid: string;
  deviceCode: string;
};

type AdminLogoutBody = {
  deviceCode: string;
};

type AuthorizeCardRegistrationBody = {
  idempotencyKey: string;
  deviceCode: string;
  targetUid: string;
  targetCardType: string;
};

type ConfirmCardRegistrationBody = {
  registrationId: string;
  deviceCode: string;
  targetUid: string;
  writtenCardId: number;
  writtenCardType: string;
};

type FailCardRegistrationBody = {
  registrationId: string;
  deviceCode: string;
  reason: string;
};


/*
 * =========================================================
 * ROUTES
 * =========================================================
 */

export async function adminRoutes(
  server: FastifyInstance
) {

  /*
   * =====================================================
   * ADMIN LOGIN
   * =====================================================
   *
   * POST /admin/login
   */

  server.post<{
    Body: AdminLoginBody;
  }>(
    "/admin/login",

    async (request, reply) => {

      const {
        cardId,
        uid,
        deviceCode,
      } = request.body;

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
         * DISPOSITIVO
         */

        const deviceResult =
          await client.query(
            `
            SELECT
                id,
                device_code,
                name,
                device_type,
                status

            FROM devices

            WHERE device_code = $1

            LIMIT 1

            FOR UPDATE
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
         * ADMIN CARD
         */

        const cardResult =
          await client.query(
            `
            SELECT
                card_id,
                uid,
                card_type,
                status

            FROM cards

            WHERE card_id = $1

            LIMIT 1

            FOR UPDATE
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
          card.card_type !== "ADMIN"
        ) {

          await client.query("ROLLBACK");

          return reply.status(409).send({
            error: "CARD_NOT_ADMIN",
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
         * CERRAR GAME
         */

        await client.query(
          `
          UPDATE device_game_sessions

          SET
              status = 'CLOSED',
              ended_at = now()

          WHERE device_id = $1
            AND status = 'ACTIVE'
            AND ended_at IS NULL
          `,
          [
            device.id,
          ]
        );

        /*
         * CERRAR RECHARGE
         */

        await client.query(
          `
          UPDATE device_recharge_sessions

          SET
              status = 'CLOSED',
              ended_at = now()

          WHERE device_id = $1
            AND status = 'ACTIVE'
            AND ended_at IS NULL
          `,
          [
            device.id,
          ]
        );

        /*
         * BUSCAR ADMIN SESSION
         */

        const existingResult =
          await client.query(
            `
            SELECT
                id,
                admin_card_id,
                started_at

            FROM device_admin_sessions

            WHERE device_id = $1
              AND status = 'ACTIVE'
              AND ended_at IS NULL

            LIMIT 1

            FOR UPDATE
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
            Number(
              existing.admin_card_id
            ) ===
            cardId
          ) {

            await client.query(
              `
              UPDATE devices

              SET
                  device_type = 'ADMIN',
                  updated_at = now()

              WHERE id = $1
              `,
              [
                device.id,
              ]
            );

            await client.query("COMMIT");

            return {
              authenticated: true,

              mode: "ADMIN",

              reusedSession: true,

              sessionId:
                existing.id,

              device: {
                code:
                  device.device_code,

                name:
                  device.name,
              },

              adminCard: {
                cardId:
                  Number(card.card_id),

                uid:
                  card.uid,
              },

              startedAt:
                existing.started_at,
            };
          }

          /*
           * Otro ADMIN estaba activo.
           */

          await client.query(
            `
            UPDATE device_admin_sessions

            SET
                status = 'CLOSED',
                ended_at = now()

            WHERE id = $1
            `,
            [
              existing.id,
            ]
          );
        }

        /*
         * CREAR ADMIN SESSION
         */

        const sessionResult =
          await client.query(
            `
            INSERT INTO device_admin_sessions (
                device_id,
                admin_card_id,
                status
            )
            VALUES (
                $1,
                $2,
                'ACTIVE'
            )

            RETURNING
                id,
                started_at
            `,
            [
              device.id,
              cardId,
            ]
          );

        /*
         * CAMBIAR DISPOSITIVO
         */

        await client.query(
          `
          UPDATE devices

          SET
              device_type = 'ADMIN',
              updated_at = now()

          WHERE id = $1
          `,
          [
            device.id,
          ]
        );

        const session =
          sessionResult.rows[0];

        await client.query("COMMIT");

        return {
          authenticated: true,

          mode: "ADMIN",

          reusedSession: false,

          sessionId:
            session.id,

          device: {
            code:
              device.device_code,

            name:
              device.name,
          },

          adminCard: {
            cardId:
              Number(card.card_id),

            uid:
              card.uid,
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
   * CURRENT ADMIN SESSION
   * =====================================================
   *
   * GET /admin/current/:deviceCode
   */

  server.get<{
    Params: {
      deviceCode: string;
    };
  }>(
    "/admin/current/:deviceCode",

    async (request, reply) => {

      const result =
        await db.query(
          `
          SELECT
              s.id AS session_id,
              s.started_at,

              d.device_code,
              d.name AS device_name,

              c.card_id AS admin_card_id,
              c.uid AS admin_card_uid

          FROM device_admin_sessions s

          JOIN devices d
              ON d.id = s.device_id

          JOIN cards c
              ON c.card_id = s.admin_card_id

          WHERE d.device_code = $1

            AND s.status = 'ACTIVE'

            AND s.ended_at IS NULL

          LIMIT 1
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
            "NO_ACTIVE_ADMIN_SESSION",
        });
      }

      const row =
        result.rows[0];

      return {
        active: true,

        mode: "ADMIN",

        sessionId:
          row.session_id,

        device: {
          code:
            row.device_code,

          name:
            row.device_name,
        },

        adminCard: {
          cardId:
            Number(
              row.admin_card_id
            ),

          uid:
            row.admin_card_uid,
        },

        startedAt:
          row.started_at,
      };
    }
  );


  /*
   * =====================================================
   * ADMIN LOGOUT
   * =====================================================
   */

  server.post<{
    Body: AdminLogoutBody;
  }>(
    "/admin/logout",

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
          UPDATE device_admin_sessions s

          SET
              status = 'CLOSED',
              ended_at = now()

          FROM devices d

          WHERE s.device_id = d.id

            AND d.device_code = $1

            AND s.status = 'ACTIVE'

            AND s.ended_at IS NULL

          RETURNING s.id
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
            "NO_ACTIVE_ADMIN_SESSION",
        });
      }

      return {
        closed: true,

        mode: "ADMIN",

        sessionId:
          result.rows[0].id,
      };
    }
  );


  /*
   * =====================================================
   * AUTORIZAR CREACIÓN DE TARJETA
   * =====================================================
   *
   * POST /admin/card-registrations/authorize
   *
   * IMPORTANTE:
   *
   * Todavía NO insertamos en cards.
   */

  server.post<{
    Body: AuthorizeCardRegistrationBody;
  }>(
    "/admin/card-registrations/authorize",

    async (request, reply) => {

      const {
        idempotencyKey,
        deviceCode,
        targetUid,
        targetCardType,
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
        typeof targetUid !== "string" ||
        targetUid.trim().length === 0
      ) {

        return reply.status(400).send({
          error:
            "INVALID_TARGET_UID",
        });
      }

      /*
       * Primera versión:
       *
       * solo permitiremos crear CUSTOMER.
       *
       * Después extenderemos GAME,
       * RECHARGE y ADMIN.
       */

      if (
        targetCardType !==
        "CUSTOMER"
      ) {

        return reply.status(400).send({
          error:
            "UNSUPPORTED_CARD_TYPE",

          message:
            "Por ahora ADMIN solamente puede crear CUSTOMER.",
        });
      }

      const client =
        await db.connect();

      try {

        await client.query("BEGIN");

        /*
         * IDEMPOTENCIA
         */

        const previousResult =
          await client.query(
            `
            SELECT *

            FROM card_registrations

            WHERE idempotency_key = $1

            LIMIT 1
            `,
            [
              idempotencyKey,
            ]
          );

        if (
          previousResult.rowCount &&
          previousResult.rowCount > 0
        ) {

          const registration =
            previousResult.rows[0];

          await client.query("COMMIT");

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

            cardId:
              Number(
                registration
                  .reserved_card_id
              ),

            uid:
              registration.target_uid,

            cardType:
              registration.target_card_type,
          };
        }

        /*
         * ADMIN SESSION
         */

        const adminResult =
          await client.query(
            `
            SELECT
                s.id AS session_id,

                s.admin_card_id,

                d.id AS device_id

            FROM device_admin_sessions s

            JOIN devices d
                ON d.id = s.device_id

            WHERE d.device_code = $1

              AND s.status = 'ACTIVE'

              AND s.ended_at IS NULL

            LIMIT 1

            FOR UPDATE OF s
            `,
            [
              deviceCode.trim(),
            ]
          );

        if (
          adminResult.rowCount === 0
        ) {

          await client.query("ROLLBACK");

          return reply.status(409).send({
            error:
              "NO_ACTIVE_ADMIN_SESSION",
          });
        }

        const admin =
          adminResult.rows[0];

        /*
         * UID no debe existir ya.
         */

        const existingCardResult =
          await client.query(
            `
            SELECT card_id

            FROM cards

            WHERE upper(uid) =
                  upper($1)

            LIMIT 1
            `,
            [
              targetUid.trim(),
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

            cardId:
              Number(
                existingCardResult
                  .rows[0]
                  .card_id
              ),
          });
        }

        /*
         * Tampoco queremos otro PENDING
         * para el mismo UID.
         */

        const pendingUidResult =
          await client.query(
            `
            SELECT id

            FROM card_registrations

            WHERE upper(target_uid) =
                  upper($1)

              AND status = 'PENDING'

            LIMIT 1
            `,
            [
              targetUid.trim(),
            ]
          );

        if (
          pendingUidResult.rowCount &&
          pendingUidResult.rowCount > 0
        ) {

          await client.query("ROLLBACK");

          return reply.status(409).send({
            error:
              "UID_HAS_PENDING_REGISTRATION",
          });
        }

        /*
         * RESERVAR CARD ID
         */

        const sequenceResult =
          await client.query(
            `
            SELECT nextval(
                'card_id_seq'
            ) AS card_id
            `
          );

        const reservedCardId =
          Number(
            sequenceResult
              .rows[0]
              .card_id
          );

        /*
         * REGISTRATION PENDING
         */

        const registrationResult =
          await client.query(
            `
            INSERT INTO card_registrations (
                idempotency_key,
                device_id,
                admin_card_id,
                target_uid,
                target_card_type,
                reserved_card_id,
                status
            )
            VALUES (
                $1,
                $2,
                $3,
                $4,
                $5,
                $6,
                'PENDING'
            )

            RETURNING *
            `,
            [
              idempotencyKey,

              admin.device_id,

              admin.admin_card_id,

              targetUid.trim(),

              targetCardType,

              reservedCardId,
            ]
          );

        const registration =
          registrationResult.rows[0];

        await client.query("COMMIT");

        return {
          authorized: true,

          duplicated: false,

          registrationId:
            registration.id,

          status:
            registration.status,

          cardId:
            reservedCardId,

          uid:
            registration.target_uid,

          cardType:
            registration.target_card_type,

          initialState: {
            balance: 0,

            transactionCounter: 0,

            status: "ACTIVE",
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
   * CONFIRMAR CREACIÓN
   * =====================================================
   *
   * POST /admin/card-registrations/confirm
   */

  server.post<{
    Body: ConfirmCardRegistrationBody;
  }>(
    "/admin/card-registrations/confirm",

    async (request, reply) => {

      const {
        registrationId,
        deviceCode,
        targetUid,
        writtenCardId,
        writtenCardType,
      } = request.body;

      const client =
        await db.connect();

      try {

        await client.query("BEGIN");

        /*
         * ADMIN SESSION
         */

        const adminResult =
          await client.query(
            `
            SELECT
                s.id

            FROM device_admin_sessions s

            JOIN devices d
                ON d.id = s.device_id

            WHERE d.device_code = $1

              AND s.status = 'ACTIVE'

              AND s.ended_at IS NULL

            LIMIT 1

            FOR UPDATE OF s
            `,
            [
              deviceCode.trim(),
            ]
          );

        if (
          adminResult.rowCount === 0
        ) {

          await client.query("ROLLBACK");

          return reply.status(409).send({
            error:
              "NO_ACTIVE_ADMIN_SESSION",
          });
        }

        /*
         * REGISTRATION
         */

        const registrationResult =
          await client.query(
            `
            SELECT *

            FROM card_registrations

            WHERE id = $1

            FOR UPDATE
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
         * Confirmación repetida.
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

            status:
              registration.status,
          });
        }

        /*
         * Verificar lo que Android dice haber escrito.
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

          await client.query("ROLLBACK");

          return reply.status(409).send({
            error:
              "REGISTRATION_STATE_MISMATCH",
          });
        }

        /*
         * Crear definitivamente cards.
         */

        await client.query(
          `
          INSERT INTO cards (
              card_id,
              uid,
              card_type,
              status,
              balance,
              transaction_counter
          )
          VALUES (
              $1,
              $2,
              $3,
              'ACTIVE',
              0,
              0
          )
          `,
          [
            writtenCardId,

            targetUid.trim(),

            writtenCardType,
          ]
        );

        /*
         * Confirmar registration.
         */

        await client.query(
          `
          UPDATE card_registrations

          SET
              status = 'CONFIRMED',

              confirmed_at = now(),

              failed_at = null,

              failure_reason = null

          WHERE id = $1
          `,
          [
            registrationId,
          ]
        );

        await client.query("COMMIT");

        return {
          confirmed: true,

          duplicated: false,

          registrationId,

          card: {
            cardId:
              writtenCardId,

            uid:
              targetUid.trim(),

            type:
              writtenCardType,

            status:
              "ACTIVE",

            balance:
              0,

            transactionCounter:
              0,
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
              "CARD_ALREADY_EXISTS",
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
   * FALLAR REGISTRO
   * =====================================================
   */

  server.post<{
    Body: FailCardRegistrationBody;
  }>(
    "/admin/card-registrations/fail",

    async (request, reply) => {

      const {
        registrationId,
        deviceCode,
        reason,
      } = request.body;

      /*
       * Confirmar que sigue existiendo ADMIN session.
       */

      const adminResult =
        await db.query(
          `
          SELECT s.id

          FROM device_admin_sessions s

          JOIN devices d
              ON d.id = s.device_id

          WHERE d.device_code = $1

            AND s.status = 'ACTIVE'

            AND s.ended_at IS NULL

          LIMIT 1
          `,
          [
            deviceCode.trim(),
          ]
        );

      if (
        adminResult.rowCount === 0
      ) {

        return reply.status(409).send({
          error:
            "NO_ACTIVE_ADMIN_SESSION",
        });
      }

      const result =
        await db.query(
          `
          UPDATE card_registrations

          SET
              status = 'FAILED',

              failed_at = now(),

              failure_reason = $2

          WHERE id = $1

            AND status = 'PENDING'

          RETURNING
              id,
              reserved_card_id
          `,
          [
            registrationId,

            reason ||
              "Fallo reportado por dispositivo.",
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
      };
    }
  );


  /*
   * =====================================================
   * CONSULTAR REGISTRO
   * =====================================================
   */

  server.get<{
    Params: {
      registrationId: string;
    };
  }>(
    "/admin/card-registrations/:registrationId",

    async (request, reply) => {

      const result =
        await db.query(
          `
          SELECT
              r.id,
              r.idempotency_key,
              r.target_uid,
              r.target_card_type,
              r.reserved_card_id,
              r.status,
              r.created_at,
              r.confirmed_at,
              r.failed_at,
              r.failure_reason,

              d.device_code,

              r.admin_card_id

          FROM card_registrations r

          JOIN devices d
              ON d.id = r.device_id

          WHERE r.id = $1

          LIMIT 1
          `,
          [
            request.params
              .registrationId,
          ]
        );

      if (
        result.rowCount === 0
      ) {

        return reply.status(404).send({
          error:
            "REGISTRATION_NOT_FOUND",
        });
      }

      const row =
        result.rows[0];

      return {
        registrationId:
          row.id,

        idempotencyKey:
          row.idempotency_key,

        deviceCode:
          row.device_code,

        adminCardId:
          Number(
            row.admin_card_id
          ),

        cardId:
          Number(
            row.reserved_card_id
          ),

        uid:
          row.target_uid,

        cardType:
          row.target_card_type,

        status:
          row.status,

        createdAt:
          row.created_at,

        confirmedAt:
          row.confirmed_at,

        failedAt:
          row.failed_at,

        failureReason:
          row.failure_reason,
      };
    }
  );
}