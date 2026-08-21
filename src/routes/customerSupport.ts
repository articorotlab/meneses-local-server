import type { FastifyInstance } from "fastify";
import { db } from "../db/database.js";

/*
 * =========================================================
 * TYPES
 * =========================================================
 */

type CardHistoryBody = {
  cardId: number;
  uid: string;
  deviceCode: string;
};

/*
 * =========================================================
 * CUSTOMER SUPPORT ROUTES
 * =========================================================
 *
 * Funciones de atención al cliente disponibles para:
 *
 * - ADMIN
 * - RECHARGE / TAQUILLA
 *
 * GAME no tiene acceso al historial completo.
 * =========================================================
 */

export async function customerSupportRoutes(
  server: FastifyInstance
) {

  /*
   * =====================================================
   * CONSULTAR HISTORIAL DE CUSTOMER
   * =====================================================
   *
   * POST /customer-support/card-history
   *
   * El dispositivo debe tener:
   *
   * - sesión ADMIN activa
   *
   * O
   *
   * - sesión RECHARGE activa
   *
   * La tarjeta enviada debe coincidir físicamente
   * con card_id + UID registrados en PostgreSQL.
   * =====================================================
   */

  server.post<{
    Body: CardHistoryBody;
  }>(
    "/customer-support/card-history",

    async (request, reply) => {

      const {
        cardId,
        uid,
        deviceCode,
      } = request.body;

      /*
       * =================================================
       * VALIDACIONES BÁSICAS
       * =================================================
       */

      if (
        !Number.isSafeInteger(cardId) ||
        cardId <= 0
      ) {

        return reply.status(400).send({
          error: "INVALID_CARD_ID",
          message:
            "Card ID inválido.",
        });
      }

      if (
        typeof uid !== "string" ||
        uid.trim().length === 0
      ) {

        return reply.status(400).send({
          error: "INVALID_UID",
          message:
            "UID inválido.",
        });
      }

      if (
        typeof deviceCode !== "string" ||
        deviceCode.trim().length === 0
      ) {

        return reply.status(400).send({
          error: "INVALID_DEVICE_CODE",
          message:
            "Device Code inválido.",
        });
      }

      const normalizedUid =
        uid
          .trim()
          .toUpperCase();

      const normalizedDeviceCode =
        deviceCode.trim();

      /*
       * =================================================
       * DISPOSITIVO
       * =================================================
       */

      const deviceResult =
        await db.query(
          `
          select
              id,
              device_code,
              name,
              status

          from devices

          where device_code = $1

          limit 1
          `,
          [
            normalizedDeviceCode,
          ]
        );

      if (
        deviceResult.rowCount === 0
      ) {

        return reply.status(404).send({
          error: "DEVICE_NOT_FOUND",
          message:
            "El dispositivo no existe.",
        });
      }

      const device =
        deviceResult.rows[0];

      if (
        device.status !== "ACTIVE"
      ) {

        return reply.status(409).send({
          error: "DEVICE_NOT_ACTIVE",
          message:
            "El dispositivo no está activo.",
        });
      }

      /*
       * =================================================
       * AUTORIZACIÓN
       * =================================================
       *
       * Primero buscamos ADMIN.
       */

      const adminSessionResult =
        await db.query(
          `
          select
              s.id,
              s.started_at,
              s.admin_card_id

          from device_admin_sessions s

          where s.device_id = $1

            and s.status = 'ACTIVE'

            and s.ended_at is null

          limit 1
          `,
          [
            device.id,
          ]
        );

      /*
       * Si no es ADMIN, buscamos RECHARGE.
       */

      const rechargeSessionResult =
        await db.query(
          `
          select
              s.id,
              s.started_at,
              s.recharge_point_id,

              rp.recharge_code,
              rp.name as recharge_point_name

          from device_recharge_sessions s

          join recharge_points rp
              on rp.id = s.recharge_point_id

          where s.device_id = $1

            and s.status = 'ACTIVE'

            and s.ended_at is null

          limit 1
          `,
          [
            device.id,
          ]
        );

      const hasAdminSession =
        Boolean(
          adminSessionResult.rowCount &&
          adminSessionResult.rowCount > 0
        );

      const hasRechargeSession =
        Boolean(
          rechargeSessionResult.rowCount &&
          rechargeSessionResult.rowCount > 0
        );

      if (
        !hasAdminSession &&
        !hasRechargeSession
      ) {

        return reply.status(403).send({
          error:
            "CUSTOMER_SUPPORT_PERMISSION_REQUIRED",

          message:
            "Se necesita una sesión ADMIN o RECHARGE activa para consultar el historial.",
        });
      }

      /*
       * Rol que realizó la consulta.
       */

      const requester =
        hasAdminSession
          ? {
              role: "ADMIN",

              sessionId:
                adminSessionResult
                  .rows[0]
                  .id,

              location: null,
            }
          : {
              role: "RECHARGE",

              sessionId:
                rechargeSessionResult
                  .rows[0]
                  .id,

              location: {
                code:
                  rechargeSessionResult
                    .rows[0]
                    .recharge_code,

                name:
                  rechargeSessionResult
                    .rows[0]
                    .recharge_point_name,
              },
            };

      /*
       * =================================================
       * CUSTOMER
       * =================================================
       */

      const cardResult =
        await db.query(
          `
          select
              card_id,
              uid,
              card_type,
              status,
              balance,
              transaction_counter,
              created_at,
              updated_at

          from cards

          where card_id = $1

          limit 1
          `,
          [
            cardId,
          ]
        );

      if (
        cardResult.rowCount === 0
      ) {

        return reply.status(404).send({
          error: "CARD_NOT_FOUND",
          message:
            "La tarjeta no existe.",
        });
      }

      const card =
        cardResult.rows[0];

      if (
        card.uid
          .trim()
          .toUpperCase() !==
        normalizedUid
      ) {

        return reply.status(409).send({
          error: "UID_MISMATCH",
          message:
            "El UID físico no coincide con la tarjeta registrada.",
        });
      }

      if (
        card.card_type !== "CUSTOMER"
      ) {

        return reply.status(409).send({
          error: "CARD_NOT_CUSTOMER",
          message:
            "El historial de atención al cliente solo está disponible para tarjetas CUSTOMER.",
        });
      }

      /*
       * =================================================
       * TRANSACCIONES
       * =================================================
       */

      const historyResult =
        await db.query(
          `
          select
              t.id,

              t.transaction_type,

              t.amount,

              t.balance_before,

              t.balance_after,

              t.counter_before,

              t.counter_after,

              t.card_write_status,

              t.unit_price,

              t.quantity,

              t.created_at,

              t.confirmed_at,

              t.failed_at,

              t.failure_reason,

              d.device_code,

              g.game_code,

              g.name as game_name,

              rp.recharge_code,

              rp.name as recharge_point_name

          from transactions t

          left join devices d
              on d.id = t.device_id

          left join games g
              on g.id = t.game_id

          left join recharge_points rp
              on rp.id = t.recharge_point_id

          where t.card_id = $1

          order by t.created_at desc

          limit 100
          `,
          [
            cardId,
          ]
        );

      const history =
        historyResult.rows.map(
          (row) => {

            const transactionType =
              row.transaction_type;

            /*
             * Para UI:
             *
             * RECHARGE = dinero agregado.
             * CHARGE    = saldo consumido.
             */

            const direction =
              transactionType === "RECHARGE"
                ? "CREDIT"
                : transactionType === "CHARGE"
                  ? "DEBIT"
                  : "NEUTRAL";

            return {
              transactionId:
                row.id,

              type:
                transactionType,

              direction,

              amount:
                Number(
                  row.amount
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

              game:
                row.game_code !== null
                  ? {
                      code:
                        row.game_code,

                      name:
                        row.game_name,

                      unitPrice:
                        row.unit_price !== null
                          ? Number(
                              row.unit_price
                            )
                          : null,

                      quantity:
                        row.quantity !== null
                          ? Number(
                              row.quantity
                            )
                          : null,
                    }
                  : null,

              rechargePoint:
                row.recharge_code !== null
                  ? {
                      code:
                        row.recharge_code,

                      name:
                        row.recharge_point_name,
                    }
                  : null,

              deviceCode:
                row.device_code,

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

      /*
       * =================================================
       * RESPONSE
       * =================================================
       */

      return {
        authorized: true,

        requester,

        card: {
          cardId:
            Number(
              card.card_id
            ),

          uid:
            card.uid,

          type:
            card.card_type,

          status:
            card.status,

          balance:
            Number(
              card.balance
            ),

          transactionCounter:
            Number(
              card.transaction_counter
            ),

          createdAt:
            card.created_at,

          updatedAt:
            card.updated_at,
        },

        historyCount:
          history.length,

        history,
      };
    }
  );
}