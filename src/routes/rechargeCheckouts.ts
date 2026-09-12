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

type PrepareCheckoutBody = {
  idempotencyKey: string;
  deviceCode: string;
  targetUid: string;

  /*
   * Recarga normal:
   * amount = dinero/crédito solicitado.
   *
   * TAQUILLA:
   * amount representa dinero pagado por la recarga.
   *
   * ADMIN:
   * amount representa ADMIN_CREDIT otorgado.
   *
   * Cuando promotionId existe, TAQUILLA obtiene los montos
   * directamente desde PostgreSQL y amount deja de ser
   * fuente de verdad.
   */
  amount?: number;
  promotionId?: string;

  /*
   * Solo TAQUILLA:
   *
   * CASH = efectivo físico.
   * CARD = tarjeta bancaria / terminal.
   *
   * No confundir con transactions.credit_fund_type.
   */
  paymentMethod?: string;
};


type CheckoutActorRole =
  | "ADMIN"
  | "RECHARGE";


type CardPath =
  | "NEW"
  | "EXISTING"
  | "REUSED";


/*
 * =========================================================
 * HELPERS
 * =========================================================
 */

function isNonEmptyString(
  value: unknown
): value is string {

  return (
    typeof value ===
      "string" &&
    value
      .trim()
      .length >
      0
  );
}


function normalizeUid(
  value: string
) {

  return value
    .trim()
    .toUpperCase();
}


function normalizePaymentMethod(
  value: unknown
):
  | "CASH"
  | "CARD"
  | null {

  if (
    typeof value !==
    "string"
  ) {

    return null;
  }


  const normalized =
    value
      .trim()
      .toUpperCase();


  if (
    normalized ===
      "CASH" ||
    normalized ===
      "CARD"
  ) {

    return normalized;
  }


  return null;
}


function mapCheckoutRow(
  row: any
) {

  return {
    checkoutId:
      row.id,

    idempotencyKey:
      row.idempotency_key,

    deviceId:
      row.device_id,

    actor: {
      role:
        row.actor_role,

      cardId:
        Number(
          row.actor_card_id
        ),

      rechargePointId:
        row.recharge_point_id,
    },

    targetUid:
      row.target_uid,

    cardId:
      row.card_id !==
      null
        ? Number(
            row.card_id
          )
        : null,

    cardPath:
      row.card_path,

    registrationId:
      row.registration_id,

    activationTransactionId:
      row.activation_transaction_id,

    rechargeTransactionId:
      row.recharge_transaction_id,

    promotionId:
      row.promotion_id,

    amounts: {
      paidRecharge:
        Number(
          row
            .paid_recharge_amount
        ),

      promotionalCredit:
        Number(
          row
            .promotional_credit_amount
        ),

      credited:
        Number(
          row
            .credited_amount
        ),

      activationFee:
        Number(
          row
            .activation_fee_amount
        ),

      totalDue:
        Number(
          row
            .total_due_amount
        ),
    },

    paymentMethod:
      row.payment_method,

    status:
      row.status,

    failureReason:
      row.failure_reason,

    createdAt:
      row.created_at,

    updatedAt:
      row.updated_at,

    confirmedAt:
      row.confirmed_at,

    failedAt:
      row.failed_at,
  };
}


/*
 * =========================================================
 * RECHARGE CHECKOUT ROUTES
 * =========================================================
 *
 * Primera fase:
 *
 * POST /recharge-checkouts/prepare
 *
 * Esta ruta SOLAMENTE prepara y persiste el contenedor lógico.
 *
 * NO:
 * - crea CUSTOMER;
 * - crea activation;
 * - crea CARD_CREATED;
 * - crea RECHARGE;
 * - modifica balance;
 * - modifica transaction_counter;
 * - escribe NFC.
 *
 * El objetivo es probar primero:
 * - clasificación segura de UID;
 * - idempotencia;
 * - promoción;
 * - cuota de activación;
 * - método CASH/CARD;
 * - protección contra dos checkouts abiertos.
 * =========================================================
 */

export async function rechargeCheckoutRoutes(
  server: FastifyInstance
) {

  server.post<{
    Body:
      PrepareCheckoutBody;
  }>(
    "/recharge-checkouts/prepare",

    async (
      request,
      reply
    ) => {

      const {
        idempotencyKey,
        deviceCode,
        targetUid,
        amount,
        promotionId,
        paymentMethod,
      } =
        request.body;


      /*
       * =====================================================
       * VALIDACIÓN BÁSICA
       * =====================================================
       */

      if (
        !isNonEmptyString(
          idempotencyKey
        )
      ) {

        return reply
          .status(400)
          .send({
            error:
              "INVALID_IDEMPOTENCY_KEY",
          });
      }


      if (
        !isNonEmptyString(
          deviceCode
        )
      ) {

        return reply
          .status(400)
          .send({
            error:
              "INVALID_DEVICE_CODE",
          });
      }


      if (
        !isNonEmptyString(
          targetUid
        )
      ) {

        return reply
          .status(400)
          .send({
            error:
              "INVALID_TARGET_UID",
          });
      }


      const normalizedIdempotencyKey =
        idempotencyKey
          .trim();


      const normalizedDeviceCode =
        deviceCode
          .trim();


      const normalizedTargetUid =
        normalizeUid(
          targetUid
        );


      const hasPromotion =
        isNonEmptyString(
          promotionId
        );


      const normalizedPromotionId =
        hasPromotion
          ? promotionId
              .trim()
          : null;


      const normalizedMethod =
        normalizePaymentMethod(
          paymentMethod
        );


      const client =
        await db.connect();


      try {

        await client.query(
          "BEGIN"
        );


        /*
         * =================================================
         * DISPOSITIVO
         * =================================================
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
          deviceResult
            .rows[0];


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
         * ACTOR ACTIVO
         * =================================================
         *
         * Mismo criterio que el registro/inspect CUSTOMER:
         *
         * ADMIN tiene prioridad si por algún motivo existen
         * ambas sesiones activas en el dispositivo.
         */

        const adminResult =
          await client.query(
            `
            select
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


        const rechargeResult =
          await client.query(
            `
            select
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
              and s.status = 'ACTIVE'
              and s.ended_at is null

            limit 1
            `,
            [
              device.id,
            ]
          );


        let actorRole:
          CheckoutActorRole;


        let actorCardId:
          number;


        let rechargePointId:
          string | null =
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


        } else {

          await client.query(
            "ROLLBACK"
          );


          return reply
            .status(403)
            .send({
              error:
                "RECHARGE_CHECKOUT_PERMISSION_REQUIRED",

              message:
                "Se necesita una sesión ADMIN o RECHARGE activa.",
            });
        }


        if (
          !Number.isSafeInteger(
            actorCardId
          ) ||
          actorCardId <=
            0
        ) {

          await client.query(
            "ROLLBACK"
          );


          return reply
            .status(409)
            .send({
              error:
                "INVALID_ACTIVE_ACTOR_CARD",
            });
        }


        /*
         * =================================================
         * SEMÁNTICA SEGÚN ACTOR
         * =================================================
         */

        if (
          actorRole ===
          "RECHARGE"
        ) {

          if (
            normalizedMethod ===
            null
          ) {

            await client.query(
              "ROLLBACK"
            );


            return reply
              .status(400)
              .send({
                error:
                  "INVALID_PAYMENT_METHOD",

                message:
                  "TAQUILLA requiere paymentMethod CASH o CARD.",
              });
          }


        } else {

          /*
           * ADMIN no representa una venta de taquilla.
           */

          if (
            paymentMethod !==
              undefined &&
            paymentMethod !==
              null &&
            String(
              paymentMethod
            )
              .trim()
              .length >
              0
          ) {

            await client.query(
              "ROLLBACK"
            );


            return reply
              .status(400)
              .send({
                error:
                  "ADMIN_PAYMENT_METHOD_NOT_ALLOWED",
              });
          }


          if (
            hasPromotion
          ) {

            await client.query(
              "ROLLBACK"
            );


            return reply
              .status(400)
              .send({
                error:
                  "ADMIN_PROMOTION_NOT_ALLOWED",
              });
          }
        }


        /*
         * =================================================
         * RESOLVER MONTOS
         * =================================================
         */

        let paidRechargeAmount =
          0;


        let promotionalCreditAmount =
          0;


        let creditedAmount =
          0;


        let resolvedPromotion:
          | {
              id: string;
              name: string;
            }
          | null =
            null;


        if (
          actorRole ===
          "RECHARGE" &&
          hasPromotion
        ) {

          const promotionResult =
            await client.query(
              `
              select
                  id,
                  name,
                  cash_amount,
                  promotional_amount,
                  total_credit_amount

              from promotions

              where id = $1
                and active = true

              limit 1
              `,
              [
                normalizedPromotionId,
              ]
            );


          if (
            promotionResult.rowCount ===
            0
          ) {

            await client.query(
              "ROLLBACK"
            );


            return reply
              .status(404)
              .send({
                error:
                  "PROMOTION_NOT_FOUND_OR_INACTIVE",
              });
          }


          const promotion =
            promotionResult
              .rows[0];


          paidRechargeAmount =
            Number(
              promotion
                .cash_amount
            );


          promotionalCreditAmount =
            Number(
              promotion
                .promotional_amount
            );


          creditedAmount =
            Number(
              promotion
                .total_credit_amount
            );


          if (
            !Number.isSafeInteger(
              paidRechargeAmount
            ) ||
            paidRechargeAmount <=
              0 ||
            !Number.isSafeInteger(
              promotionalCreditAmount
            ) ||
            promotionalCreditAmount <
              0 ||
            !Number.isSafeInteger(
              creditedAmount
            ) ||
            creditedAmount <=
              0 ||
            creditedAmount !==
              paidRechargeAmount +
                promotionalCreditAmount
          ) {

            await client.query(
              "ROLLBACK"
            );


            return reply
              .status(409)
              .send({
                error:
                  "INVALID_PROMOTION_CONFIGURATION",
              });
          }


          resolvedPromotion = {
            id:
              promotion.id,

            name:
              promotion.name,
          };


        } else {

          if (
            !Number.isSafeInteger(
              amount
            ) ||
            Number(
              amount
            ) <=
              0
          ) {

            await client.query(
              "ROLLBACK"
            );


            return reply
              .status(400)
              .send({
                error:
                  "INVALID_AMOUNT",
              });
          }


          creditedAmount =
            Number(
              amount
            );


          if (
            actorRole ===
            "RECHARGE"
          ) {

            paidRechargeAmount =
              creditedAmount;
          }
        }


        /*
         * =================================================
         * IDEMPOTENCIA EXISTENTE
         * =================================================
         *
         * El mismo idempotencyKey devuelve el mismo checkout
         * únicamente si corresponde a la misma intención.
         */

        const duplicateResult =
          await client.query(
            `
            select
                *

            from recharge_checkouts

            where idempotency_key = $1

            limit 1
            `,
            [
              normalizedIdempotencyKey,
            ]
          );


        if (
          duplicateResult.rowCount &&
          duplicateResult.rowCount >
            0
        ) {

          const existing =
            duplicateResult
              .rows[0];


          const sameIntent =
            String(
              existing
                .device_id
            ) ===
              String(
                device.id
              ) &&

            String(
              existing
                .actor_role
            ) ===
              actorRole &&

            Number(
              existing
                .actor_card_id
            ) ===
              actorCardId &&

            String(
              existing
                .target_uid
            )
              .toUpperCase() ===
              normalizedTargetUid &&

            (
              existing
                .promotion_id ??
              null
            ) ===
              (
                resolvedPromotion
                  ?.id ??
                null
              ) &&

            Number(
              existing
                .paid_recharge_amount
            ) ===
              paidRechargeAmount &&

            Number(
              existing
                .promotional_credit_amount
            ) ===
              promotionalCreditAmount &&

            Number(
              existing
                .credited_amount
            ) ===
              creditedAmount &&

            (
              existing
                .payment_method ??
              null
            ) ===
              (
                actorRole ===
                  "RECHARGE"
                  ? normalizedMethod
                  : null
              );


          if (
            !sameIntent
          ) {

            await client.query(
              "ROLLBACK"
            );


            return reply
              .status(409)
              .send({
                error:
                  "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST",
              });
          }


          await client.query(
            "COMMIT"
          );


          return {
            prepared:
              true,

            duplicated:
              true,

            checkout:
              mapCheckoutRow(
                existing
              ),

            promotion:
              resolvedPromotion,
          };
        }


        /*
         * =================================================
         * CHECKOUT ABIERTO DEL MISMO UID
         * =================================================
         */

        const openCheckoutResult =
          await client.query(
            `
            select
                *

            from recharge_checkouts

            where upper(target_uid) =
                  upper($1)

              and status in (
                'PENDING',
                'IN_PROGRESS',
                'MANUAL_REVIEW_REQUIRED'
              )

            order by
                created_at desc

            limit 1
            `,
            [
              normalizedTargetUid,
            ]
          );


        if (
          openCheckoutResult.rowCount &&
          openCheckoutResult.rowCount >
            0
        ) {

          const openCheckout =
            openCheckoutResult
              .rows[0];


          await client.query(
            "ROLLBACK"
          );


          return reply
            .status(409)
            .send({
              error:
                "CHECKOUT_ALREADY_OPEN_FOR_UID",

              checkout:
                mapCheckoutRow(
                  openCheckout
                ),
            });
        }


        /*
         * =================================================
         * REGISTRATION PENDIENTE DEL UID
         * =================================================
         */

        const pendingRegistrationResult =
          await client.query(
            `
            select
                id,
                reserved_card_id,
                created_at

            from card_registrations

            where upper(target_uid) =
                  upper($1)

              and status =
                  'PENDING'

            order by
                created_at desc

            limit 1
            `,
            [
              normalizedTargetUid,
            ]
          );


        if (
          pendingRegistrationResult.rowCount &&
          pendingRegistrationResult.rowCount >
            0
        ) {

          const pendingRegistration =
            pendingRegistrationResult
              .rows[0];


          await client.query(
            "ROLLBACK"
          );


          return reply
            .status(409)
            .send({
              error:
                "UID_HAS_PENDING_REGISTRATION",

              registration: {
                registrationId:
                  pendingRegistration.id,

                cardId:
                  Number(
                    pendingRegistration
                      .reserved_card_id
                  ),

                createdAt:
                  pendingRegistration
                    .created_at,
              },
            });
        }


        /*
         * =================================================
         * CLASIFICAR CUSTOMER
         * =================================================
         */

        const cardResult =
          await client.query(
            `
            select
                c.card_id,
                c.uid,
                c.card_type,
                c.status,
                c.balance,
                c.transaction_counter,
                c.current_activation_id,
                c.financial_hold,
                c.financial_hold_reason,
                c.financial_hold_at,

                last_activation.id
                  as last_activation_id,

                last_activation.status
                  as last_activation_status,

                last_activation.activation_number
                  as last_activation_number,

                (
                  r.id is not null
                ) as has_return_audit

            from cards c

            left join lateral (
              select
                  a.id,
                  a.status,
                  a.activation_number

              from customer_card_activations a

              where a.card_id =
                    c.card_id

              order by
                  a.activation_number desc

              limit 1
            ) last_activation
                on true

            left join customer_card_returns r
                on r.activation_id =
                   last_activation.id

            where upper(c.uid) =
                  upper($1)

            limit 1
            `,
            [
              normalizedTargetUid,
            ]
          );


        let cardPath:
          CardPath;


        let targetCardId:
          number | null =
            null;


        let activationFeeAmount =
          0;


        if (
          cardResult.rowCount ===
          0
        ) {

          cardPath =
            "NEW";


        } else {

          const card =
            cardResult
              .rows[0];


          targetCardId =
            Number(
              card.card_id
            );


          if (
            card.card_type !==
            "CUSTOMER"
          ) {

            await client.query(
              "ROLLBACK"
            );


            return reply
              .status(409)
              .send({
                error:
                  "UID_REGISTERED_AS_OTHER_CARD_TYPE",

                cardType:
                  card.card_type,

                cardId:
                  targetCardId,
              });
          }


          if (
            card.financial_hold ===
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

                cardId:
                  targetCardId,

                reason:
                  card
                    .financial_hold_reason,

                heldAt:
                  card
                    .financial_hold_at,
              });
          }


          if (
            card.status ===
              "ACTIVE" &&
            card
              .current_activation_id !==
              null
          ) {

            cardPath =
              "EXISTING";


          } else {

            const reusable =
              card.status ===
                "INACTIVE" &&

              Number(
                card.balance
              ) ===
                0 &&

              Number(
                card
                  .transaction_counter
              ) ===
                0 &&

              card
                .current_activation_id ===
                null &&

              card
                .last_activation_id !==
                null &&

              card
                .last_activation_status ===
                "RETURNED" &&

              Boolean(
                card
                  .has_return_audit
              );


            if (
              !reusable
            ) {

              await client.query(
                "ROLLBACK"
              );


              return reply
                .status(409)
                .send({
                  error:
                    "CUSTOMER_STATE_NOT_SAFE_FOR_AUTOMATIC_USE",

                  card: {
                    cardId:
                      targetCardId,

                    status:
                      card.status,

                    balance:
                      Number(
                        card.balance
                      ),

                    transactionCounter:
                      Number(
                        card
                          .transaction_counter
                      ),

                    currentActivationId:
                      card
                        .current_activation_id,

                    lastActivationStatus:
                      card
                        .last_activation_status,
                  },
                });
            }


            cardPath =
              "REUSED";
          }
        }


        /*
         * =================================================
         * CUOTA DE ACTIVACIÓN
         * =================================================
         *
         * Solo TAQUILLA cobra la cuota y solamente cuando
         * habrá una activación nueva:
         *
         * NEW / REUSED.
         *
         * ADMIN nunca crea ingreso de activación.
         */

        if (
          actorRole ===
            "RECHARGE" &&
          cardPath !==
            "EXISTING"
        ) {

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
            settingsResult.rowCount ===
            0
          ) {

            await client.query(
              "ROLLBACK"
            );


            return reply
              .status(409)
              .send({
                error:
                  "OPERATIONAL_SETTINGS_NOT_FOUND",
              });
          }


          activationFeeAmount =
            Number(
              settingsResult
                .rows[0]
                .customer_card_activation_fee
            );


          if (
            !Number.isSafeInteger(
              activationFeeAmount
            ) ||
            activationFeeAmount <
              0
          ) {

            await client.query(
              "ROLLBACK"
            );


            return reply
              .status(409)
              .send({
                error:
                  "INVALID_CUSTOMER_CARD_ACTIVATION_FEE",
              });
          }
        }


        const totalDueAmount =
          actorRole ===
            "RECHARGE"
            ? paidRechargeAmount +
              activationFeeAmount
            : 0;


        /*
         * =================================================
         * CREAR CHECKOUT PENDING
         * =================================================
         */

        let insertResult;


        try {

          insertResult =
            await client.query(
              `
              insert into recharge_checkouts (
                  idempotency_key,
                  device_id,
                  actor_role,
                  actor_card_id,
                  recharge_point_id,
                  target_uid,
                  card_id,
                  card_path,
                  promotion_id,
                  paid_recharge_amount,
                  promotional_credit_amount,
                  credited_amount,
                  activation_fee_amount,
                  total_due_amount,
                  payment_method,
                  status,
                  created_at,
                  updated_at
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
                  $10,
                  $11,
                  $12,
                  $13,
                  $14,
                  $15,
                  'PENDING',
                  now(),
                  now()
              )

              returning *
              `,
              [
                normalizedIdempotencyKey,
                device.id,
                actorRole,
                actorCardId,
                rechargePointId,
                normalizedTargetUid,
                targetCardId,
                cardPath,
                resolvedPromotion
                  ?.id ??
                  null,
                paidRechargeAmount,
                promotionalCreditAmount,
                creditedAmount,
                activationFeeAmount,
                totalDueAmount,
                actorRole ===
                  "RECHARGE"
                  ? normalizedMethod
                  : null,
              ]
            );


        } catch (
          error: any
        ) {

          /*
           * Defensa final ante concurrencia real:
           *
           * aunque dos solicitudes pasen el SELECT previo al
           * mismo tiempo, PostgreSQL mantiene la unicidad.
           */

          if (
            error?.code ===
            "23505"
          ) {

            await client.query(
              "ROLLBACK"
            );


            return reply
              .status(409)
              .send({
                error:
                  "RECHARGE_CHECKOUT_CONFLICT",

                constraint:
                  error
                    ?.constraint ??
                  null,
              });
          }


          throw error;
        }


        const checkout =
          insertResult
            .rows[0];


        await client.query(
          "COMMIT"
        );


        return {
          prepared:
            true,

          duplicated:
            false,

          checkout:
            mapCheckoutRow(
              checkout
            ),

          promotion:
            resolvedPromotion,
        };


      } catch (
        error: any
      ) {

        try {

          await client.query(
            "ROLLBACK"
          );

        } catch {
        }


        /*
         * UUID inválido de promotionId.
         */

        if (
          error?.code ===
            "22P02"
        ) {

          return reply
            .status(400)
            .send({
              error:
                "INVALID_PROMOTION_ID",
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
}
