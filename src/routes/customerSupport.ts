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


type CardHistoryPaymentMethodChangeBody = {
  checkoutId: string;
  cardId: number;
  uid: string;
  deviceCode: string;
  newPaymentMethod: "CASH" | "CARD";
  reason?: string;
};


type CardReturnAuthorizeBody = {
  idempotencyKey: string;
  cardId: number;
  uid: string;
  deviceCode: string;
};


type CardReturnConfirmBody = {
  operationId: string;
  cardId: number;
  uid: string;
  deviceCode: string;

  writtenCardId: number;
  writtenCardType: string;
  writtenStatus: string;
  writtenBalance: number;
  writtenTransactionCounter: number;
};


type CardReturnFailBody = {
  operationId: string;
  deviceCode: string;
  reason?: string;
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
              current_activation_id,
              financial_hold,
              financial_hold_reason,
              financial_hold_at,
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
       * Una tarjeta física puede reutilizarse.
       *
       * El historial operativo SIEMPRE pertenece a la
       * activación actual, nunca a todo el card_id.
       */
      if (
        card.current_activation_id ===
        null
      ) {

        return reply.status(409).send({
          error:
            "CARD_HAS_NO_ACTIVE_ACTIVATION",

          message:
            "La tarjeta no tiene una activación CUSTOMER activa.",
        });
      }


      const activationResult =
        await db.query(
          `
          select
              id,
              activation_number,
              activation_fee,
              activation_fee_known,
              status,
              started_at

          from customer_card_activations

          where id = $1
            and card_id = $2

          limit 1
          `,
          [
            card.current_activation_id,
            cardId,
          ]
        );


      if (
        activationResult.rowCount ===
        0
      ) {

        return reply.status(409).send({
          error:
            "CURRENT_ACTIVATION_NOT_FOUND",

          message:
            "No fue posible localizar la activación actual de la tarjeta.",
        });
      }


      const activation =
        activationResult.rows[0];


      if (
        activation.status !==
        "ACTIVE"
      ) {

        return reply.status(409).send({
          error:
            "CURRENT_ACTIVATION_NOT_ACTIVE",

          message:
            "La activación actual de la tarjeta no está activa.",
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

              rp.name as recharge_point_name,

              rc.id as checkout_id,

              coalesce(
                rc.promotion_id,
                t.promotion_id
              ) as promotion_id,

              p.name as promotion_name,

              rc.paid_recharge_amount,

              rc.promotional_credit_amount,

              rc.credited_amount,

              rc.payment_method

          from transactions t

          left join devices d
              on d.id = t.device_id

          left join games g
              on g.id = t.game_id

          left join recharge_points rp
              on rp.id = t.recharge_point_id

          left join recharge_checkouts rc
              on rc.recharge_transaction_id = t.id
             and rc.status = 'CONFIRMED'

          left join promotions p
              on p.id = coalesce(
                rc.promotion_id,
                t.promotion_id
              )

          where t.card_id = $1
            and t.activation_id = $2
            and t.card_write_status = 'CONFIRMED'

          order by t.created_at desc

          limit 100
          `,
          [
            cardId,
            card.current_activation_id,
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

              checkoutId:
                row.checkout_id,

              promotionId:
                row.promotion_id,

              promotionName:
                row.promotion_name,

              paidRechargeAmount:
                row.paid_recharge_amount !== null
                  ? Number(
                      row.paid_recharge_amount
                    )
                  : null,

              promotionalCreditAmount:
                row.promotional_credit_amount !== null
                  ? Number(
                      row.promotional_credit_amount
                    )
                  : null,

              creditedAmount:
                row.credited_amount !== null
                  ? Number(
                      row.credited_amount
                    )
                  : null,

              paymentMethod:
                row.payment_method,

              paymentMethodEditable:
                row.checkout_id !== null &&
                row.payment_method !== null,

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
       * INCIDENTES FINANCIEROS / SNAPSHOT FORENSE
       * =================================================
       *
       * Visible únicamente aquí, porque esta ruta ya exige
       * sesión ADMIN o RECHARGE / TAQUILLA.
       */

      const incidentResult =
        await db.query(
          `
          select
              i.id,
              i.transaction_id,
              i.detected_at,
              i.incident_type,
              i.device_code,

              i.nfc_balance,
              i.nfc_counter,

              i.server_balance,
              i.server_counter,

              i.ledger_balance,

              i.expected_before_balance,
              i.expected_before_counter,

              i.expected_after_balance,
              i.expected_after_counter,

              i.transaction_type,
              i.transaction_amount,
              i.promotion_id,
              i.transaction_status_before,
              i.failure_reason

          from card_financial_incidents i

          where i.card_id = $1
            and i.activation_id = $2

          order by i.detected_at desc
          `,
          [
            cardId,
            card.current_activation_id,
          ]
        );


      const financialIncidents =
        incidentResult.rows.map(
          (row) => ({
            incidentId:
              row.id,

            type:
              row.incident_type,

            detectedAt:
              row.detected_at,

            transactionId:
              row.transaction_id,

            deviceCode:
              row.device_code,

            transaction: {
              type:
                row.transaction_type,

              amount:
                row.transaction_amount !== null
                  ? Number(row.transaction_amount)
                  : null,

              promotionId:
                row.promotion_id,

              statusBefore:
                row.transaction_status_before,
            },

            nfc: {
              balance:
                Number(row.nfc_balance),

              transactionCounter:
                Number(row.nfc_counter),
            },

            postgreSQL: {
              balance:
                Number(row.server_balance),

              transactionCounter:
                Number(row.server_counter),
            },

            ledger: {
              balance:
                Number(row.ledger_balance),
            },

            expectedBefore: {
              balance:
                Number(
                  row.expected_before_balance
                ),

              transactionCounter:
                Number(
                  row.expected_before_counter
                ),
            },

            expectedAfter: {
              balance:
                Number(
                  row.expected_after_balance
                ),

              transactionCounter:
                Number(
                  row.expected_after_counter
                ),
            },

            differences: {
              nfcVsPostgreSQL:
                Number(row.nfc_balance) -
                Number(row.server_balance),

              nfcVsLedger:
                Number(row.nfc_balance) -
                Number(row.ledger_balance),

              postgreSQLVsLedger:
                Number(row.server_balance) -
                Number(row.ledger_balance),
            },

            failureReason:
              row.failure_reason,
          })
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

          financialHold: {
            active:
              Boolean(
                card.financial_hold
              ),

            reason:
              card.financial_hold_reason,

            heldAt:
              card.financial_hold_at,
          },
        },

        financialIncidentsCount:
          financialIncidents.length,

        financialIncidents,

        activation: {
          activationId:
            activation.id,

          activationNumber:
            Number(
              activation.activation_number
            ),

          activationFee:
            Number(
              activation.activation_fee
            ),

          activationFeeKnown:
            Boolean(
              activation.activation_fee_known
            ),

          startedAt:
            activation.started_at,
        },

        historyCount:
          history.length,

        history,
      };
    }
  );


  /*
   * =====================================================
   * CORREGIR MÉTODO DE PAGO DESDE HISTORIAL CUSTOMER
   * =====================================================
   *
   * POST /customer-support/card-history/payment-method
   *
   * Este endpoint SOLO corrige la clasificación física
   * CASH / CARD de un checkout ya CONFIRMED.
   *
   * No modifica:
   * - saldo NFC;
   * - cards.balance / transaction_counter;
   * - transactions;
   * - Financial Ledger V2.
   *
   * La evidencia anterior se conserva en
   * recharge_checkout_payment_method_changes.
   * =====================================================
   */

  server.post<{
    Body:
      CardHistoryPaymentMethodChangeBody;
  }>(
    "/customer-support/card-history/payment-method",

    async (
      request,
      reply
    ) => {

      const {
        checkoutId,
        cardId,
        uid,
        deviceCode,
        newPaymentMethod,
        reason,
      } =
        request.body;


      if (
        typeof checkoutId !==
          "string" ||
        checkoutId
          .trim()
          .length ===
          0
      ) {

        return reply
          .status(400)
          .send({
            error:
              "INVALID_CHECKOUT_ID",
          });
      }


      if (
        !Number.isSafeInteger(
          cardId
        ) ||
        cardId <=
          0
      ) {

        return reply
          .status(400)
          .send({
            error:
              "INVALID_CARD_ID",
          });
      }


      if (
        typeof uid !==
          "string" ||
        uid
          .trim()
          .length ===
          0
      ) {

        return reply
          .status(400)
          .send({
            error:
              "INVALID_UID",
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
        newPaymentMethod !==
          "CASH" &&
        newPaymentMethod !==
          "CARD"
      ) {

        return reply
          .status(400)
          .send({
            error:
              "INVALID_PAYMENT_METHOD",

            message:
              "El método debe ser CASH o CARD.",
          });
      }


      const normalizedUid =
        uid
          .trim()
          .toUpperCase();


      const normalizedDeviceCode =
        deviceCode.trim();


      const normalizedReason =
        typeof reason ===
          "string" &&
        reason
          .trim()
          .length >
          0
          ? reason
              .trim()
              .slice(
                0,
                500
              )
          : "Corrección desde historial CUSTOMER";


      const client =
        await db.connect();


      try {

        await client.query(
          "BEGIN"
        );


        const deviceResult =
          await client.query(
            `
            select
                id,
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
         * ADMIN tiene prioridad si por un error operativo
         * coexistieran ambas sesiones.
         */
        const adminSessionResult =
          await client.query(
            `
            select
                s.id,
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


        const rechargeSessionResult =
          await client.query(
            `
            select
                s.id,
                s.opened_by_card_id,
                s.recharge_point_id

            from device_recharge_sessions s

            where s.device_id = $1
              and s.status = 'ACTIVE'
              and s.ended_at is null

            limit 1
            `,
            [
              device.id,
            ]
          );


        let changedByRole:
          "ADMIN" |
          "RECHARGE";


        let changedByCardId:
          number;


        let activeRechargePointId:
          string | null =
            null;


        if (
          adminSessionResult.rowCount &&
          adminSessionResult.rowCount >
            0
        ) {

          changedByRole =
            "ADMIN";


          changedByCardId =
            Number(
              adminSessionResult
                .rows[0]
                .admin_card_id
            );


        } else if (
          rechargeSessionResult.rowCount &&
          rechargeSessionResult.rowCount >
            0
        ) {

          const rechargeSession =
            rechargeSessionResult
              .rows[0];


          if (
            rechargeSession
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


          changedByRole =
            "RECHARGE";


          changedByCardId =
            Number(
              rechargeSession
                .opened_by_card_id
            );


          activeRechargePointId =
            rechargeSession
              .recharge_point_id;


        } else {

          await client.query(
            "ROLLBACK"
          );


          return reply
            .status(403)
            .send({
              error:
                "CUSTOMER_SUPPORT_PERMISSION_REQUIRED",

              message:
                "Se necesita una sesión ADMIN o RECHARGE activa para corregir el método de pago.",
            });
        }


        const checkoutResult =
          await client.query(
            `
            select
                rc.id,
                rc.card_id,
                rc.target_uid,
                rc.actor_role,
                rc.recharge_point_id,
                rc.recharge_transaction_id,
                rc.payment_method,
                rc.status,

                c.current_activation_id,
                c.financial_hold,

                t.activation_id
                  as transaction_activation_id

            from recharge_checkouts rc

            join cards c
                on c.card_id =
                   rc.card_id

            join transactions t
                on t.id =
                   rc.recharge_transaction_id

            where rc.id = $1

            limit 1

            for update of rc
            `,
            [
              checkoutId.trim(),
            ]
          );


        if (
          checkoutResult.rowCount ===
          0
        ) {

          await client.query(
            "ROLLBACK"
          );


          return reply
            .status(404)
            .send({
              error:
                "CHECKOUT_NOT_FOUND",
            });
        }


        const checkout =
          checkoutResult.rows[0];


        if (
          Number(
            checkout.card_id
          ) !==
          cardId ||
          String(
            checkout.target_uid
          )
            .trim()
            .toUpperCase() !==
          normalizedUid
        ) {

          await client.query(
            "ROLLBACK"
          );


          return reply
            .status(409)
            .send({
              error:
                "CHECKOUT_CARD_MISMATCH",

              message:
                "El checkout no corresponde a la tarjeta consultada.",
            });
        }


        if (
          checkout.status !==
          "CONFIRMED"
        ) {

          await client.query(
            "ROLLBACK"
          );


          return reply
            .status(409)
            .send({
              error:
                "CHECKOUT_NOT_CONFIRMED",

              message:
                "Solo se puede corregir el método de pago de operaciones confirmadas.",
            });
        }


        if (
          checkout.actor_role !==
          "RECHARGE"
        ) {

          await client.query(
            "ROLLBACK"
          );


          return reply
            .status(409)
            .send({
              error:
                "CHECKOUT_NOT_RECHARGE",

              message:
                "La operación no corresponde a un cobro de taquilla.",
            });
        }


        if (
          checkout.payment_method !==
            "CASH" &&
          checkout.payment_method !==
            "CARD"
        ) {

          await client.query(
            "ROLLBACK"
          );


          return reply
            .status(409)
            .send({
              error:
                "CHECKOUT_PAYMENT_METHOD_NOT_EDITABLE",

              message:
                "La operación no tiene un método de pago corregible.",
            });
        }


        if (
          checkout.financial_hold ===
          true
        ) {

          await client.query(
            "ROLLBACK"
          );


          return reply
            .status(409)
            .send({
              error:
                "CARD_FINANCIAL_HOLD",

              message:
                "La tarjeta está en revisión manual. No se puede corregir el método de pago hasta resolver el incidente.",
            });
        }


        /*
         * Una TAQUILLA solamente puede corregir operaciones
         * pertenecientes a su propio punto de recarga.
         * ADMIN puede corregir cualquier checkout confirmado.
         */
        if (
          changedByRole ===
            "RECHARGE" &&
          checkout.recharge_point_id !==
            activeRechargePointId
        ) {

          await client.query(
            "ROLLBACK"
          );


          return reply
            .status(403)
            .send({
              error:
                "CHECKOUT_BELONGS_TO_ANOTHER_RECHARGE_POINT",

              message:
                "Esta operación pertenece a otra taquilla.",
            });
        }


        /*
         * El historial mostrado corresponde únicamente a la
         * activación CUSTOMER actual. No permitimos modificar
         * desde aquí un checkout perteneciente a otra activación.
         */
        if (
          checkout.current_activation_id ===
            null ||
          checkout.transaction_activation_id ===
            null ||
          checkout.current_activation_id !==
            checkout.transaction_activation_id
        ) {

          await client.query(
            "ROLLBACK"
          );


          return reply
            .status(409)
            .send({
              error:
                "CHECKOUT_NOT_IN_CURRENT_ACTIVATION",

              message:
                "La operación no pertenece a la activación actual de la tarjeta.",
            });
        }


        const previousMethod =
          String(
            checkout.payment_method
          );


        if (
          previousMethod ===
          newPaymentMethod
        ) {

          await client.query(
            "COMMIT"
          );


          return {
            changed:
              false,

            checkoutId:
              checkout.id,

            previousMethod,

            newMethod:
              previousMethod,
          };
        }


        await client.query(
          `
          insert into recharge_checkout_payment_method_changes (
              checkout_id,
              previous_method,
              new_method,
              changed_by_role,
              changed_by_card_id,
              device_id,
              reason
          )
          values (
              $1,
              $2,
              $3,
              $4,
              $5,
              $6,
              $7
          )
          `,
          [
            checkout.id,
            previousMethod,
            newPaymentMethod,
            changedByRole,
            changedByCardId,
            device.id,
            normalizedReason,
          ]
        );


        await client.query(
          `
          update recharge_checkouts

          set
              payment_method = $2,
              updated_at = now()

          where id = $1
          `,
          [
            checkout.id,
            newPaymentMethod,
          ]
        );


        await client.query(
          "COMMIT"
        );


        return {
          changed:
            true,

          checkoutId:
            checkout.id,

          previousMethod,

          newMethod:
            newPaymentMethod,

          changedByRole,

          changedByCardId,
        };


      } catch (
        error
      ) {

        try {

          await client.query(
            "ROLLBACK"
          );

        } catch (
          _: unknown
        ) {
        }


        throw error;


      } finally {

        client.release();
      }
    }
  );


  /*
   * =====================================================
   * AUTORIZAR DEVOLUCIÓN / RESET DE CUSTOMER
   * =====================================================
   *
   * POST /customer-support/card-return/authorize
   *
   * NO modifica todavía la tarjeta ni el ledger.
   * Solamente calcula y congela:
   *
   * - reembolso de activación;
   * - CASH restante;
   * - PROMOTIONAL restante;
   * - ADMIN_CREDIT restante;
   * - LEGACY restante.
   * =====================================================
   */

  server.post<{
    Body:
      CardReturnAuthorizeBody;
  }>(
    "/customer-support/card-return/authorize",

    async (
      request,
      reply
    ) => {

      const {
        idempotencyKey,
        cardId,
        uid,
        deviceCode,
      } =
        request.body;


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
        !Number.isSafeInteger(
          cardId
        ) ||
        cardId <=
          0
      ) {

        return reply
          .status(400)
          .send({
            error:
              "INVALID_CARD_ID",

            message:
              "Card ID inválido.",
          });
      }


      if (
        typeof uid !==
          "string" ||
        uid
          .trim()
          .length ===
          0
      ) {

        return reply
          .status(400)
          .send({
            error:
              "INVALID_UID",
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


      const normalizedUid =
        uid
          .trim()
          .toUpperCase();


      const normalizedDeviceCode =
        deviceCode.trim();


      const client =
        await db.connect();


      try {

        await client.query(
          "BEGIN"
        );


        const deviceResult =
          await client.query(
            `
            select
                id,
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
         * ADMIN tiene prioridad si ambas sesiones
         * existieran accidentalmente.
         */
        const adminResult =
          await client.query(
            `
            select
                id,
                admin_card_id

            from device_admin_sessions

            where device_id = $1

              and status =
                  'ACTIVE'

              and ended_at
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


        let returnedByRole:
          "ADMIN" |
          "RECHARGE";


        let returnedByCardId:
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

          returnedByRole =
            "ADMIN";


          returnedByCardId =
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


          returnedByRole =
            "RECHARGE";


          returnedByCardId =
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
                "CUSTOMER_RETURN_PERMISSION_REQUIRED",

              message:
                "Se necesita una sesión ADMIN o RECHARGE activa para devolver una CUSTOMER.",
            });
        }


        /*
         * Una tarjeta en cuarentena no puede devolverse/resetearse.
         * El historial y el diagnóstico siguen disponibles.
         */
        const holdResult =
          await client.query(
            `
            select
                financial_hold,
                financial_hold_reason,
                financial_hold_at

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
          holdResult.rowCount &&
          holdResult.rowCount > 0 &&
          holdResult.rows[0]
            .financial_hold === true
        ) {

          await client.query(
            "ROLLBACK"
          );


          return reply
            .status(409)
            .send({
              error:
                "CARD_FINANCIAL_HOLD",

              reason:
                holdResult.rows[0]
                  .financial_hold_reason ??
                "MANUAL_REVIEW_REQUIRED",

              heldAt:
                holdResult.rows[0]
                  .financial_hold_at,

              message:
                "La tarjeta está en revisión manual y no puede devolverse ni reutilizarse.",
            });
        }


        const result =
          await client.query(
            `
            select *

            from financial_authorize_card_return(
              $1,
              $2,
              $3,
              $4,
              $5,
              $6,
              $7
            )
            `,
            [
              idempotencyKey.trim(),
              device.id,
              cardId,
              normalizedUid,
              returnedByRole,
              returnedByCardId,
              rechargePointId,
            ]
          );


        const row =
          result.rows[0];


        /*
         * =================================================
         * ORIGEN DE LA ACTIVACIÓN / POLÍTICA DE REEMBOLSO
         * =================================================
         *
         * No inferimos el origen únicamente a partir de
         * refundAmount = 0.
         *
         * Una activación creada por ADMIN puede resetearse,
         * pero no debe generar devolución de efectivo.
         */
        const activationOriginResult =
          await client.query(
            `
              select
                activated_by_role,
                activation_fee,
                activation_fee_known

              from customer_card_activations

              where id = $1
                and card_id = $2

              limit 1
            `,
            [
              row.activation_id,
              cardId,
            ]
          );


        if (
          activationOriginResult.rowCount ===
          0
        ) {

          throw new Error(
            "ACTIVATION_NOT_FOUND_AFTER_RETURN_AUTHORIZATION"
          );
        }


        const activationOrigin =
          activationOriginResult.rows[0];


        const activatedByRole =
          String(
            activationOrigin
              .activated_by_role
          );


        const activationFeeKnown =
          Boolean(
            activationOrigin
              .activation_fee_known
          );


        const refundAmount =
          Number(
            row.refund_amount
          );


        const adminCreatedWithoutRefund =
          activatedByRole ===
            "ADMIN" &&
          !activationFeeKnown;


        const refundPolicy =
          adminCreatedWithoutRefund
            ? {
                shouldRefundMoney:
                  false,

                reason:
                  "ADMIN_CREATED",

                message:
                  "NO DEVOLVER DINERO. Esta tarjeta fue creada por ADMIN y no tiene depósito de activación reembolsable.",
              }
            : {
                shouldRefundMoney:
                  refundAmount > 0,

                reason:
                  activationFeeKnown
                    ? "ACTIVATION_FEE"
                    : "NO_REFUND",

                message:
                  refundAmount > 0
                    ? `Devolver $${refundAmount.toFixed(2)} al cliente.`
                    : "No hay dinero de activación que devolver.",
              };


        await client.query(
          "COMMIT"
        );


        return {
          authorized:
            true,

          duplicated:
            Boolean(
              row.duplicated
            ),

          operationId:
            row.operation_id,

          requester: {
            role:
              returnedByRole,

            cardId:
              returnedByCardId,

            rechargePoint,
          },

          card: {
            cardId:
              Number(
                row.card_id
              ),

            uid:
              row.uid,

            type:
              "CUSTOMER",

            activationId:
              row.activation_id,

            balanceBefore:
              Number(
                row.balance_before
              ),

            transactionCounterBefore:
              Number(
                row.counter_before
              ),
          },

          activation: {
            activationId:
              row.activation_id,

            activatedByRole,

            activationFee:
              Number(
                activationOrigin
                  .activation_fee
              ),

            activationFeeKnown,
          },

          refundAmount,

          refundPolicy,

          discarded: {
            cash:
              Number(
                row.discarded_cash
              ),

            promotional:
              Number(
                row.discarded_promotional
              ),

            adminCredit:
              Number(
                row.discarded_admin_credit
              ),

            legacy:
              Number(
                row.discarded_legacy
              ),

            total:
              Number(
                row.discarded_cash
              ) +
              Number(
                row.discarded_promotional
              ) +
              Number(
                row.discarded_admin_credit
              ) +
              Number(
                row.discarded_legacy
              ),
          },

          /*
           * Estado que Android debe escribir y posteriormente
           * verificar físicamente antes de CONFIRM.
           */
          targetState: {
            cardId:
              Number(
                row.card_id
              ),

            uid:
              row.uid,

            cardType:
              "CUSTOMER",

            status:
              "INACTIVE",

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


        const message =
          typeof error?.message ===
          "string"
            ? error.message
            : "INTERNAL_ERROR";


        if (
          message.includes(
            "ACTIVATION_FEE_UNKNOWN"
          )
        ) {

          return reply
            .status(409)
            .send({
              error:
                "ACTIVATION_FEE_UNKNOWN",

              message:
                "No conocemos con certeza cuánto pagó el cliente por esta activación. La devolución automática requiere revisión ADMIN.",
            });
        }


        if (
          message.includes(
            "CARD_RETURN_LEDGER_MISMATCH"
          )
        ) {

          return reply
            .status(409)
            .send({
              error:
                "CARD_RETURN_LEDGER_MISMATCH",

              message:
                "El saldo de la tarjeta no coincide con Financial Ledger V2. No se autorizó la devolución.",
            });
        }


        const knownConflictErrors = [
          "CARD_NOT_FOUND",
          "CARD_NOT_CUSTOMER",
          "UID_MISMATCH",
          "CARD_NOT_ACTIVE",
          "CARD_HAS_NO_ACTIVE_ACTIVATION",
          "ACTIVATION_NOT_FOUND",
          "ACTIVATION_CARD_MISMATCH",
          "ACTIVATION_NOT_ACTIVE",
          "ACTIVATION_NOT_FOUND_AFTER_RETURN_AUTHORIZATION",
        ];


        const knownError =
          knownConflictErrors.find(
            (code) =>
              message.includes(
                code
              )
          );


        if (
          knownError
        ) {

          return reply
            .status(409)
            .send({
              error:
                knownError,
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
   * CONFIRMAR DEVOLUCIÓN / RESET
   * =====================================================
   *
   * POST /customer-support/card-return/confirm
   *
   * Android debe llamar este endpoint únicamente después
   * de escribir y releer la tarjeta física.
   * =====================================================
   */

  server.post<{
    Body:
      CardReturnConfirmBody;
  }>(
    "/customer-support/card-return/confirm",

    async (
      request,
      reply
    ) => {

      const {
        operationId,
        cardId,
        uid,
        deviceCode,

        writtenCardId,
        writtenCardType,
        writtenStatus,
        writtenBalance,
        writtenTransactionCounter,
      } =
        request.body;


      if (
        typeof operationId !==
          "string" ||
        operationId
          .trim()
          .length ===
          0
      ) {

        return reply
          .status(400)
          .send({
            error:
              "INVALID_OPERATION_ID",
          });
      }


      if (
        !Number.isSafeInteger(
          cardId
        ) ||
        cardId <=
          0 ||
        typeof uid !==
          "string" ||
        uid
          .trim()
          .length ===
          0 ||
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
              "INVALID_CONFIRMATION_BODY",
          });
      }


      /*
       * Verificación de lo que Android leyó DESPUÉS
       * de escribir el NFC.
       */
      if (
        writtenCardId !==
          cardId ||
        writtenCardType !==
          "CUSTOMER" ||
        writtenStatus !==
          "INACTIVE" ||
        writtenBalance !==
          0 ||
        writtenTransactionCounter !==
          0
      ) {

        return reply
          .status(409)
          .send({
            error:
              "RETURNED_CARD_STATE_MISMATCH",

            message:
              "La tarjeta física no quedó en el estado esperado. La devolución no fue confirmada.",
          });
      }


      const normalizedDeviceCode =
        deviceCode.trim();


      const normalizedUid =
        uid
          .trim()
          .toUpperCase();


      const client =
        await db.connect();


      try {

        await client.query(
          "BEGIN"
        );


        const deviceResult =
          await client.query(
            `
            select
                id,
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
         * Revalidamos que la misma sesión que autorizó
         * la devolución siga activa.
         */
        const operationResult =
          await client.query(
            `
            select
                returned_by_role,
                returned_by_card_id,
                recharge_point_id

            from customer_card_return_operations

            where id = $1

            limit 1

            for update
            `,
            [
              operationId.trim(),
            ]
          );


        if (
          operationResult.rowCount ===
          0
        ) {

          await client.query(
            "ROLLBACK"
          );


          return reply
            .status(404)
            .send({
              error:
                "CARD_RETURN_OPERATION_NOT_FOUND",
            });
        }


        const operation =
          operationResult
            .rows[0];


        let sessionStillActive =
          false;


        if (
          operation
            .returned_by_role ===
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
              `,
              [
                device.id,
                operation
                  .returned_by_card_id,
              ]
            );


          sessionStillActive =
            Boolean(
              sessionResult.rowCount &&
              sessionResult.rowCount >
                0
            );


        } else if (
          operation
            .returned_by_role ===
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
              `,
              [
                device.id,
                operation
                  .returned_by_card_id,
                operation
                  .recharge_point_id,
              ]
            );


          sessionStillActive =
            Boolean(
              sessionResult.rowCount &&
              sessionResult.rowCount >
                0
            );
        }


        if (
          !sessionStillActive
        ) {

          await client.query(
            "ROLLBACK"
          );


          return reply
            .status(403)
            .send({
              error:
                "RETURN_SESSION_NO_LONGER_ACTIVE",
            });
        }


        /*
         * Revalidación de cuarentena antes de confirmar el reset.
         * Evita que una devolución previamente autorizada pueda
         * modificar una tarjeta que entró a revisión manual.
         */
        const holdResult =
          await client.query(
            `
            select
                financial_hold,
                financial_hold_reason,
                financial_hold_at

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
          holdResult.rowCount &&
          holdResult.rowCount > 0 &&
          holdResult.rows[0]
            .financial_hold === true
        ) {

          await client.query(
            "ROLLBACK"
          );


          return reply
            .status(409)
            .send({
              error:
                "CARD_FINANCIAL_HOLD",

              reason:
                holdResult.rows[0]
                  .financial_hold_reason ??
                "MANUAL_REVIEW_REQUIRED",

              heldAt:
                holdResult.rows[0]
                  .financial_hold_at,

              message:
                "La tarjeta está en revisión manual y la devolución no puede confirmarse.",
            });
        }


        const result =
          await client.query(
            `
            select *

            from financial_confirm_card_return(
              $1,
              $2,
              $3,
              $4
            )
            `,
            [
              operationId.trim(),
              device.id,
              cardId,
              normalizedUid,
            ]
          );


        const row =
          result.rows[0];


        await client.query(
          "COMMIT"
        );


        return {
          confirmed:
            true,

          duplicated:
            Boolean(
              row.duplicated
            ),

          returnId:
            row.return_id,

          operationId:
            row.operation_id,

          cardId:
            Number(
              row.card_id
            ),

          activationId:
            row.activation_id,

          refundAmount:
            Number(
              row.refund_amount
            ),

          discarded: {
            cash:
              Number(
                row.discarded_cash
              ),

            promotional:
              Number(
                row.discarded_promotional
              ),

            adminCredit:
              Number(
                row.discarded_admin_credit
              ),

            legacy:
              Number(
                row.discarded_legacy
              ),

            total:
              Number(
                row.discarded_cash
              ) +
              Number(
                row.discarded_promotional
              ) +
              Number(
                row.discarded_admin_credit
              ) +
              Number(
                row.discarded_legacy
              ),
          },

          card: {
            cardId,

            uid:
              normalizedUid,

            type:
              "CUSTOMER",

            status:
              "INACTIVE",

            balance:
              0,

            transactionCounter:
              0,

            currentActivationId:
              null,
          },
        };


      } catch (
        error: any
      ) {

        await client.query(
          "ROLLBACK"
        );


        const message =
          typeof error?.message ===
          "string"
            ? error.message
            : "INTERNAL_ERROR";


        const knownConflictErrors = [
          "CARD_RETURN_DEVICE_MISMATCH",
          "CARD_RETURN_CARD_MISMATCH",
          "CARD_RETURN_UID_MISMATCH",
          "CARD_RETURN_OPERATION_NOT_AUTHORIZED",
          "CARD_ACTIVATION_CHANGED",
          "CARD_BALANCE_CHANGED_AFTER_RETURN_AUTHORIZATION",
          "CARD_COUNTER_CHANGED_AFTER_RETURN_AUTHORIZATION",
          "ACTIVE_ACTIVATION_NOT_FOUND_DURING_CONFIRM",
          "CARD_NOT_CUSTOMER",
          "UID_MISMATCH",
        ];


        const knownError =
          knownConflictErrors.find(
            (code) =>
              message.includes(
                code
              )
          );


        if (
          knownError
        ) {

          return reply
            .status(409)
            .send({
              error:
                knownError,
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
   * REPORTAR FALLO DE DEVOLUCIÓN
   * =====================================================
   *
   * POST /customer-support/card-return/fail
   * =====================================================
   */

  server.post<{
    Body:
      CardReturnFailBody;
  }>(
    "/customer-support/card-return/fail",

    async (
      request,
      reply
    ) => {

      const {
        operationId,
        deviceCode,
        reason,
      } =
        request.body;


      if (
        typeof operationId !==
          "string" ||
        operationId
          .trim()
          .length ===
          0 ||
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
              "INVALID_FAIL_BODY",
          });
      }


      const deviceResult =
        await db.query(
          `
          select
              id,
              status

          from devices

          where device_code = $1

          limit 1
          `,
          [
            deviceCode.trim(),
          ]
        );


      if (
        deviceResult.rowCount ===
        0
      ) {

        return reply
          .status(404)
          .send({
            error:
              "DEVICE_NOT_FOUND",
          });
      }


      if (
        deviceResult
          .rows[0]
          .status !==
        "ACTIVE"
      ) {

        return reply
          .status(409)
          .send({
            error:
              "DEVICE_NOT_ACTIVE",
          });
      }


      const result =
        await db.query(
          `
          select
              financial_fail_card_return(
                $1,
                $2,
                $3
              ) as failed
          `,
          [
            operationId.trim(),
            deviceResult
              .rows[0]
              .id,
            reason ??
              "Fallo reportado por dispositivo.",
          ]
        );


      if (
        !result
          .rows[0]
          .failed
      ) {

        return reply
          .status(409)
          .send({
            error:
              "CARD_RETURN_CANNOT_BE_FAILED",
          });
      }


      return {
        failed:
          true,

        operationId:
          operationId.trim(),
      };
    }
  );

}
