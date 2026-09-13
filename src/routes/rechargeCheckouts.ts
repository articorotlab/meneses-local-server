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


type AuthorizeCheckoutBody = {
  checkoutId: string;
  deviceCode: string;
  targetUid: string;

  /*
   * EXISTING solamente:
   * estado físico leído del NFC antes de autorizar.
   * NEW no necesita estos campos porque todavía no existe
   * una Meneses Card física.
   */
  cardBalance?: number;
  cardCounter?: number;
};


type ResumeCheckoutBody = {
  deviceCode: string;
  targetUid: string;
};


type ReconcileCheckoutBody = {
  checkoutId: string;
  deviceCode: string;
  targetUid: string;

  /*
   * NEW:
   * isVirgin = true significa que Android verificó que la NFC
   * continúa sin una Meneses Card escrita.
   *
   * Si isVirgin = false, Android debe enviar el estado físico
   * Meneses observado para comparar contra AFTER.
   *
   * EXISTING:
   * siempre requiere cardId / cardBalance / cardCounter.
   */
  isVirgin?: boolean;
  cardId?: number;
  cardBalance?: number;
  cardCounter?: number;
};


type ConfirmCheckoutBody = {
  checkoutId: string;
  deviceCode: string;
  targetUid: string;
  cardId: number;
  writtenBalance: number;
  writtenCounter: number;
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


  /*
   * =====================================================
   * AUTHORIZE CHECKOUT - NEW CUSTOMER
   * =====================================================
   *
   * POST /recharge-checkouts/authorize
   *
   * Segunda fase segura del flujo automático.
   *
   * En esta primera versión de AUTHORIZE solamente se permite
   * card_path = NEW.
   *
   * Esta ruta:
   * - bloquea el checkout con FOR UPDATE;
   * - vuelve a validar dispositivo, actor y UID;
   * - reserva card_id usando card_id_seq;
   * - crea card_registrations PENDING;
   * - enlaza registration_id al checkout;
   * - cambia el checkout a IN_PROGRESS;
   * - devuelve el estado FINAL que Android deberá escribir.
   *
   * Esta ruta NO:
   * - inserta todavía la CUSTOMER en cards;
   * - crea customer_card_activations;
   * - crea CARD_CREATED;
   * - crea RECHARGE;
   * - crea card_fund_lots;
   * - cambia saldo o contador en PostgreSQL;
   * - confirma dinero.
   *
   * Si la transacción SQL falla, la reservación completa hace
   * ROLLBACK. Los huecos de card_id_seq son aceptables.
   * =====================================================
   */

  server.post<{
    Body: AuthorizeCheckoutBody;
  }>(
    "/recharge-checkouts/authorize",

    async (
      request,
      reply
    ) => {

      const {
        checkoutId,
        deviceCode,
        targetUid,
        cardBalance,
        cardCounter,
      } = request.body;


      if (
        !isNonEmptyString(
          checkoutId
        )
      ) {

        return reply
          .status(400)
          .send({
            error:
              "INVALID_CHECKOUT_ID",
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


      const normalizedCheckoutId =
        checkoutId.trim();


      const normalizedDeviceCode =
        deviceCode.trim();


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
         * -------------------------------------------------
         * CHECKOUT + DISPOSITIVO
         * -------------------------------------------------
         */

        const checkoutResult =
          await client.query(
            `
              select
                  c.*,
                  d.device_code,
                  d.status
                    as device_status

              from recharge_checkouts c

              join devices d
                  on d.id =
                     c.device_id

              where c.id = $1

              limit 1

              for update of c
            `,
            [
              normalizedCheckoutId,
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
                "RECHARGE_CHECKOUT_NOT_FOUND",
            });
        }


        const checkout =
          checkoutResult.rows[0];


        if (
          checkout.device_code !==
          normalizedDeviceCode
        ) {

          await client.query(
            "ROLLBACK"
          );


          return reply
            .status(409)
            .send({
              error:
                "CHECKOUT_DEVICE_MISMATCH",
            });
        }


        if (
          checkout.device_status !==
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


        if (
          String(
            checkout.target_uid
          )
            .trim()
            .toUpperCase() !==
          normalizedTargetUid
        ) {

          await client.query(
            "ROLLBACK"
          );


          return reply
            .status(409)
            .send({
              error:
                "CHECKOUT_UID_MISMATCH",
            });
        }


        /*
         * -------------------------------------------------
         * RETRY IDEMPOTENTE DE AUTHORIZE
         * -------------------------------------------------
         */

        if (
          checkout.status ===
          "IN_PROGRESS"
        ) {

          /*
           * EXISTING: la autorización financiera ya vive en
           * transactions y debe devolverse sin crear otra.
           */
          if (
            checkout.card_path ===
            "EXISTING"
          ) {

            if (
              checkout.recharge_transaction_id ===
              null ||
              checkout.card_id ===
              null
            ) {

              await client.query(
                "ROLLBACK"
              );

              return reply
                .status(409)
                .send({
                  error:
                    "CHECKOUT_IN_PROGRESS_WITHOUT_RECHARGE_TRANSACTION",
                });
            }

            const transactionResult =
              await client.query(
                `
                  select *
                  from transactions
                  where id = $1
                  limit 1
                `,
                [
                  checkout.recharge_transaction_id,
                ]
              );

            if (
              transactionResult.rowCount ===
              0
            ) {

              await client.query(
                "ROLLBACK"
              );

              return reply
                .status(409)
                .send({
                  error:
                    "CHECKOUT_RECHARGE_TRANSACTION_NOT_FOUND",
                });
            }

            const transaction =
              transactionResult.rows[0];

            if (
              Number(
                transaction.card_id
              ) !==
                Number(
                  checkout.card_id
                ) ||
              transaction.card_write_status !==
                "AUTHORIZED"
            ) {

              await client.query(
                "ROLLBACK"
              );

              return reply
                .status(409)
                .send({
                  error:
                    "CHECKOUT_RECHARGE_TRANSACTION_STATE_MISMATCH",
                });
            }

            await client.query(
              "COMMIT"
            );

            return {
              authorized:
                true,

              duplicated:
                true,

              checkout:
                mapCheckoutRow(
                  checkout
                ),

              registration:
                null,

              transaction: {
                transactionId:
                  transaction.id,

                status:
                  transaction.card_write_status,
              },

              beforeCardState: {
                cardId:
                  Number(
                    transaction.card_id
                  ),

                uid:
                  normalizedTargetUid,

                cardType:
                  "CUSTOMER",

                status:
                  "ACTIVE",

                balance:
                  Number(
                    transaction.balance_before
                  ),

                transactionCounter:
                  Number(
                    transaction.counter_before
                  ),
              },

              finalCardState: {
                cardId:
                  Number(
                    transaction.card_id
                  ),

                uid:
                  normalizedTargetUid,

                cardType:
                  "CUSTOMER",

                status:
                  "ACTIVE",

                balance:
                  Number(
                    transaction.balance_after
                  ),

                transactionCounter:
                  Number(
                    transaction.counter_after
                  ),
              },
            };
          }


          /*
           * NEW y REUSED conservan una reservación en
           * card_registrations. En REUSED reserved_card_id es
           * el mismo card_id físico ya existente.
           */
          if (
            checkout.card_path !==
              "NEW" &&
            checkout.card_path !==
              "REUSED"
          ) {

            await client.query(
              "ROLLBACK"
            );

            return reply
              .status(409)
              .send({
                error:
                  "CHECKOUT_CARD_PATH_NOT_SUPPORTED_YET",

                cardPath:
                  checkout.card_path,
              });
          }

          if (
            checkout.registration_id ===
            null
          ) {

            await client.query(
              "ROLLBACK"
            );

            return reply
              .status(409)
              .send({
                error:
                  "CHECKOUT_IN_PROGRESS_WITHOUT_REGISTRATION",
              });
          }

          const registrationResult =
            await client.query(
              `
                select
                    id,
                    target_uid,
                    target_card_type,
                    reserved_card_id,
                    status,
                    actor_role,
                    actor_card_id,
                    recharge_point_id

                from card_registrations

                where id = $1

                limit 1
              `,
              [
                checkout.registration_id,
              ]
            );

          if (
            registrationResult.rowCount ===
            0
          ) {

            await client.query(
              "ROLLBACK"
            );

            return reply
              .status(409)
              .send({
                error:
                  "CHECKOUT_REGISTRATION_NOT_FOUND",
              });
          }

          const registration =
            registrationResult.rows[0];

          const registrationMatches =
            String(
              registration.target_uid
            )
              .trim()
              .toUpperCase() ===
              normalizedTargetUid &&

            registration.target_card_type ===
              "CUSTOMER" &&

            registration.status ===
              "PENDING" &&

            registration.actor_role ===
              checkout.actor_role &&

            Number(
              registration.actor_card_id
            ) ===
              Number(
                checkout.actor_card_id
              ) &&

            (
              registration.recharge_point_id ??
              null
            ) ===
              (
                checkout.recharge_point_id ??
                null
              );

          if (
            !registrationMatches
          ) {

            await client.query(
              "ROLLBACK"
            );

            return reply
              .status(409)
              .send({
                error:
                  "CHECKOUT_REGISTRATION_STATE_MISMATCH",
              });
          }

          const reservedCardId =
            Number(
              registration.reserved_card_id
            );

          if (
            !Number.isSafeInteger(
              reservedCardId
            ) ||
            reservedCardId <=
              0
          ) {

            await client.query(
              "ROLLBACK"
            );

            return reply
              .status(409)
              .send({
                error:
                  "INVALID_RESERVED_CARD_ID",
              });
          }

          await client.query(
            "COMMIT"
          );

          return {
            authorized:
              true,

            duplicated:
              true,

            checkout:
              mapCheckoutRow(
                checkout
              ),

            registration: {
              registrationId:
                registration.id,

              status:
                registration.status,

              reservedCardId,
            },

            beforeCardState:
              checkout.card_path ===
                "REUSED"
                ? {
                    cardId:
                      reservedCardId,

                    uid:
                      normalizedTargetUid,

                    cardType:
                      "CUSTOMER",

                    status:
                      "INACTIVE",

                    balance:
                      0,

                    transactionCounter:
                      0,
                  }
                : null,

            finalCardState: {
              cardId:
                reservedCardId,

              uid:
                normalizedTargetUid,

              cardType:
                "CUSTOMER",

              status:
                "ACTIVE",

              balance:
                Number(
                  checkout.credited_amount
                ),

              transactionCounter:
                1,
            },
          };
        }

        if (
          checkout.status !==
          "PENDING"
        ) {

          await client.query(
            "ROLLBACK"
          );


          return reply
            .status(409)
            .send({
              error:
                "CHECKOUT_NOT_PENDING",

              status:
                checkout.status,
            });
        }


        /*
         * -------------------------------------------------
         * EXISTING CUSTOMER
         * -------------------------------------------------
         *
         * Reutiliza exactamente la semántica financiera de
         * /transactions/recharge/authorize, pero enlaza la
         * transacción al checkout para poder RESUME/CONFIRM.
         */

        if (
          checkout.card_path ===
          "EXISTING"
        ) {

          if (
            checkout.card_id ===
              null ||
            checkout.registration_id !==
              null
          ) {

            await client.query(
              "ROLLBACK"
            );

            return reply
              .status(409)
              .send({
                error:
                  "EXISTING_CHECKOUT_STATE_INVALID",
              });
          }

          if (
            !Number.isSafeInteger(
              cardBalance
            ) ||
            Number(cardBalance) <
              0 ||
            !Number.isSafeInteger(
              cardCounter
            ) ||
            Number(cardCounter) <
              0
          ) {

            await client.query(
              "ROLLBACK"
            );

            return reply
              .status(400)
              .send({
                error:
                  "EXISTING_CARD_STATE_REQUIRED",
              });
          }

          /* Actor/session sigue activo. */
          if (
            checkout.actor_role ===
            "ADMIN"
          ) {

            const sessionResult =
              await client.query(
                `
                  select id
                  from device_admin_sessions
                  where device_id = $1
                    and admin_card_id = $2
                    and status = 'ACTIVE'
                    and ended_at is null
                  limit 1
                  for update
                `,
                [
                  checkout.device_id,
                  checkout.actor_card_id,
                ]
              );

            if (
              sessionResult.rowCount ===
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
            checkout.actor_role ===
            "RECHARGE"
          ) {

            const sessionResult =
              await client.query(
                `
                  select id
                  from device_recharge_sessions
                  where device_id = $1
                    and opened_by_card_id = $2
                    and recharge_point_id = $3
                    and status = 'ACTIVE'
                    and ended_at is null
                  limit 1
                  for update
                `,
                [
                  checkout.device_id,
                  checkout.actor_card_id,
                  checkout.recharge_point_id,
                ]
              );

            if (
              sessionResult.rowCount ===
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
                  "UNKNOWN_CHECKOUT_ACTOR",
              });
          }

          const cardResult =
            await client.query(
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
                    financial_hold_at

                from cards

                where card_id = $1

                for update
              `,
              [
                checkout.card_id,
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
            normalizeUid(
              card.uid
            ) !==
              normalizedTargetUid ||
            card.card_type !==
              "CUSTOMER" ||
            card.status !==
              "ACTIVE" ||
            card.current_activation_id ===
              null
          ) {

            await client.query(
              "ROLLBACK"
            );

            return reply
              .status(409)
              .send({
                error:
                  "EXISTING_CUSTOMER_STATE_INVALID",
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

                reason:
                  card.financial_hold_reason ??
                  "MANUAL_REVIEW_REQUIRED",

                heldAt:
                  card.financial_hold_at,
              });
          }

          const serverBalance =
            Number(
              card.balance
            );

          const serverCounter =
            Number(
              card.transaction_counter
            );

          if (
            serverBalance !==
              Number(cardBalance) ||
            serverCounter !==
              Number(cardCounter)
          ) {

            await client.query(
              "ROLLBACK"
            );

            return reply
              .status(409)
              .send({
                error:
                  "CARD_STATE_MISMATCH",

                serverState: {
                  balance:
                    serverBalance,

                  transactionCounter:
                    serverCounter,
                },

                cardState: {
                  balance:
                    Number(cardBalance),

                  transactionCounter:
                    Number(cardCounter),
                },
              });
          }

          const creditedAmount =
            Number(
              checkout.credited_amount
            );

          const paidRechargeAmount =
            Number(
              checkout.paid_recharge_amount
            );

          const promotionalCreditAmount =
            Number(
              checkout.promotional_credit_amount
            );

          const balanceAfter =
            serverBalance +
            creditedAmount;

          const counterAfter =
            serverCounter +
            1;

          const transactionIdempotencyKey =
            `checkout:${checkout.id}:recharge`;

          const transactionResult =
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
                    recharge_point_id,
                    actor_role,
                    actor_card_id,
                    activation_id,
                    ledger_action,
                    credit_fund_type,
                    promotion_id
                )

                values (
                    $1,
                    $2,
                    $3,
                    'RECHARGE',
                    $4,
                    $5,
                    $6,
                    $7,
                    $8,
                    'AUTHORIZED',
                    $9,
                    $10,
                    $11,
                    $12,
                    'CREDIT',
                    $13,
                    $14
                )

                returning *
              `,
              [
                transactionIdempotencyKey,
                checkout.card_id,
                checkout.device_id,
                creditedAmount,
                serverBalance,
                balanceAfter,
                serverCounter,
                counterAfter,
                checkout.actor_role ===
                  "RECHARGE"
                  ? checkout.recharge_point_id
                  : null,
                checkout.actor_role,
                checkout.actor_card_id,
                card.current_activation_id,
                checkout.actor_role ===
                  "ADMIN"
                  ? "ADMIN_CREDIT"
                  : "CASH",
                checkout.promotion_id,
              ]
            );

          const transaction =
            transactionResult.rows[0];

          if (
            checkout.actor_role ===
              "RECHARGE" &&
            checkout.promotion_id !==
              null
          ) {

            if (
              paidRechargeAmount <=
                0 ||
              promotionalCreditAmount <=
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
                    "INVALID_CHECKOUT_PROMOTION_AMOUNTS",
                });
            }

            await client.query(
              `
                insert into
                  transaction_credit_components (
                    transaction_id,
                    fund_type,
                    amount,
                    promotion_id
                  )

                values (
                    $1,
                    'CASH',
                    $2,
                    $4
                ),
                (
                    $1,
                    'PROMOTIONAL',
                    $3,
                    $4
                )
              `,
              [
                transaction.id,
                paidRechargeAmount,
                promotionalCreditAmount,
                checkout.promotion_id,
              ]
            );
          }

          const updatedCheckoutResult =
            await client.query(
              `
                update recharge_checkouts

                set
                    recharge_transaction_id = $2,
                    status = 'IN_PROGRESS',
                    updated_at = now()

                where id = $1

                returning *
              `,
              [
                checkout.id,
                transaction.id,
              ]
            );

          const updatedCheckout =
            updatedCheckoutResult.rows[0];

          await client.query(
            "COMMIT"
          );

          return {
            authorized:
              true,

            duplicated:
              false,

            checkout:
              mapCheckoutRow(
                updatedCheckout
              ),

            registration:
              null,

            transaction: {
              transactionId:
                transaction.id,

              status:
                transaction.card_write_status,
            },

            beforeCardState: {
              cardId:
                Number(
                  checkout.card_id
                ),

              uid:
                normalizedTargetUid,

              cardType:
                "CUSTOMER",

              status:
                "ACTIVE",

              balance:
                serverBalance,

              transactionCounter:
                serverCounter,
            },

            finalCardState: {
              cardId:
                Number(
                  checkout.card_id
                ),

              uid:
                normalizedTargetUid,

              cardType:
                "CUSTOMER",

              status:
                "ACTIVE",

              balance:
                balanceAfter,

              transactionCounter:
                counterAfter,
            },
          };
        }


        /*
         * -------------------------------------------------
         * REUSED CUSTOMER
         * -------------------------------------------------
         *
         * La tarjeta física ya existe, pero su activación anterior
         * terminó en RETURNED. AUTHORIZE no reactiva todavía cards
         * ni crea dinero: solamente vuelve a validar el estado
         * reusable, crea card_registrations PENDING reservando el
         * MISMO card_id y devuelve BEFORE/AFTER para la NFC.
         */

        if (
          checkout.card_path ===
          "REUSED"
        ) {

          if (
            checkout.card_id ===
              null ||
            checkout.registration_id !==
              null ||
            checkout.recharge_transaction_id !==
              null ||
            checkout.activation_transaction_id !==
              null
          ) {

            await client.query(
              "ROLLBACK"
            );

            return reply
              .status(409)
              .send({
                error:
                  "REUSED_CHECKOUT_STATE_INVALID",
              });
          }

          /* Actor/session sigue activo. */
          if (
            checkout.actor_role ===
            "ADMIN"
          ) {

            const sessionResult =
              await client.query(
                `
                  select id
                  from device_admin_sessions
                  where device_id = $1
                    and admin_card_id = $2
                    and status = 'ACTIVE'
                    and ended_at is null
                  limit 1
                  for update
                `,
                [
                  checkout.device_id,
                  checkout.actor_card_id,
                ]
              );

            if (
              sessionResult.rowCount ===
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
            checkout.actor_role ===
            "RECHARGE"
          ) {

            const sessionResult =
              await client.query(
                `
                  select id
                  from device_recharge_sessions
                  where device_id = $1
                    and opened_by_card_id = $2
                    and recharge_point_id = $3
                    and status = 'ACTIVE'
                    and ended_at is null
                  limit 1
                  for update
                `,
                [
                  checkout.device_id,
                  checkout.actor_card_id,
                  checkout.recharge_point_id,
                ]
              );

            if (
              sessionResult.rowCount ===
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
                  "UNKNOWN_CHECKOUT_ACTOR",
              });
          }

          const reusableCardResult =
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
                    last_activation.id as last_activation_id,
                    last_activation.status as last_activation_status,
                    last_activation.activation_number as last_activation_number,
                    (r.id is not null) as has_return_audit
                from cards c
                left join lateral (
                  select id, status, activation_number
                  from customer_card_activations
                  where card_id = c.card_id
                  order by activation_number desc
                  limit 1
                ) last_activation on true
                left join customer_card_returns r
                  on r.activation_id = last_activation.id
                where c.card_id = $1
                for update of c
              `,
              [
                checkout.card_id,
              ]
            );

          if (
            reusableCardResult.rowCount ===
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

          const reusableCard =
            reusableCardResult.rows[0];

          if (
            reusableCard.financial_hold ===
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
                reason:
                  reusableCard.financial_hold_reason ??
                  "MANUAL_REVIEW_REQUIRED",
                heldAt:
                  reusableCard.financial_hold_at,
              });
          }

          const reusable =
            normalizeUid(
              reusableCard.uid
            ) ===
              normalizedTargetUid &&
            reusableCard.card_type ===
              "CUSTOMER" &&
            reusableCard.status ===
              "INACTIVE" &&
            Number(
              reusableCard.balance
            ) ===
              0 &&
            Number(
              reusableCard.transaction_counter
            ) ===
              0 &&
            reusableCard.current_activation_id ===
              null &&
            reusableCard.last_activation_id !==
              null &&
            reusableCard.last_activation_status ===
              "RETURNED" &&
            Boolean(
              reusableCard.has_return_audit
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
                  "CARD_NOT_REUSABLE",
              });
          }

          const pendingRegistrationResult =
            await client.query(
              `
                select id, reserved_card_id
                from card_registrations
                where upper(target_uid) = upper($1)
                  and status = 'PENDING'
                order by created_at desc
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

            await client.query(
              "ROLLBACK"
            );

            return reply
              .status(409)
              .send({
                error:
                  "UID_HAS_PENDING_REGISTRATION",
                registrationId:
                  pendingRegistrationResult.rows[0].id,
                cardId:
                  Number(
                    pendingRegistrationResult.rows[0].reserved_card_id
                  ),
              });
          }

          const registrationIdempotencyKey =
            `checkout:${checkout.id}:registration`;

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
                    'CUSTOMER',
                    $8,
                    'PENDING'
                )
                returning *
              `,
              [
                registrationIdempotencyKey,
                checkout.device_id,
                checkout.actor_role ===
                  "ADMIN"
                  ? checkout.actor_card_id
                  : null,
                checkout.actor_role,
                checkout.actor_card_id,
                checkout.recharge_point_id,
                normalizedTargetUid,
                Number(
                  checkout.card_id
                ),
              ]
            );

          const registration =
            registrationResult.rows[0];

          const updatedCheckoutResult =
            await client.query(
              `
                update recharge_checkouts
                set
                    registration_id = $2,
                    status = 'IN_PROGRESS',
                    updated_at = now()
                where id = $1
                returning *
              `,
              [
                checkout.id,
                registration.id,
              ]
            );

          const updatedCheckout =
            updatedCheckoutResult.rows[0];

          await client.query(
            "COMMIT"
          );

          return {
            authorized:
              true,
            duplicated:
              false,
            checkout:
              mapCheckoutRow(
                updatedCheckout
              ),
            registration: {
              registrationId:
                registration.id,
              status:
                registration.status,
              reservedCardId:
                Number(
                  checkout.card_id
                ),
            },
            beforeCardState: {
              cardId:
                Number(
                  checkout.card_id
                ),
              uid:
                normalizedTargetUid,
              cardType:
                "CUSTOMER",
              status:
                "INACTIVE",
              balance:
                0,
              transactionCounter:
                0,
            },
            finalCardState: {
              cardId:
                Number(
                  checkout.card_id
                ),
              uid:
                normalizedTargetUid,
              cardType:
                "CUSTOMER",
              status:
                "ACTIVE",
              balance:
                Number(
                  updatedCheckout.credited_amount
                ),
              transactionCounter:
                1,
            },
          };
        }


        /*
         * -------------------------------------------------
         * NEW CUSTOMER
         * -------------------------------------------------
         *
         * REUSED necesita validar explícitamente su semántica de
         * nueva activación antes de habilitarlo.
         */

        if (
          checkout.card_path !==
          "NEW"
        ) {

          await client.query(
            "ROLLBACK"
          );

          return reply
            .status(409)
            .send({
              error:
                "CHECKOUT_CARD_PATH_NOT_SUPPORTED_YET",

              cardPath:
                checkout.card_path,
            });
        }


        if (
          checkout.card_id !==
          null
        ) {

          await client.query(
            "ROLLBACK"
          );


          return reply
            .status(409)
            .send({
              error:
                "NEW_CHECKOUT_ALREADY_HAS_CARD_ID",
            });
        }


        if (
          checkout.registration_id !==
          null
        ) {

          await client.query(
            "ROLLBACK"
          );


          return reply
            .status(409)
            .send({
              error:
                "NEW_CHECKOUT_ALREADY_HAS_REGISTRATION",
            });
        }


        /*
         * -------------------------------------------------
         * ACTOR SIGUE ACTIVO
         * -------------------------------------------------
         */

        if (
          checkout.actor_role ===
          "ADMIN"
        ) {

          const sessionResult =
            await client.query(
              `
                select id

                from device_admin_sessions

                where device_id = $1
                  and admin_card_id = $2
                  and status = 'ACTIVE'
                  and ended_at is null

                limit 1

                for update
              `,
              [
                checkout.device_id,
                checkout.actor_card_id,
              ]
            );


          if (
            sessionResult.rowCount ===
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
          checkout.actor_role ===
          "RECHARGE"
        ) {

          const sessionResult =
            await client.query(
              `
                select id

                from device_recharge_sessions

                where device_id = $1
                  and opened_by_card_id = $2
                  and recharge_point_id = $3
                  and status = 'ACTIVE'
                  and ended_at is null

                limit 1

                for update
              `,
              [
                checkout.device_id,
                checkout.actor_card_id,
                checkout.recharge_point_id,
              ]
            );


          if (
            sessionResult.rowCount ===
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
                "UNKNOWN_CHECKOUT_ACTOR",
            });
        }


        /*
         * -------------------------------------------------
         * UID SIGUE VIRGEN EN POSTGRESQL
         * -------------------------------------------------
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
              normalizedTargetUid,
            ]
          );


        if (
          existingCardResult.rowCount &&
          existingCardResult.rowCount >
          0
        ) {

          await client.query(
            "ROLLBACK"
          );


          return reply
            .status(409)
            .send({
              error:
                "UID_NO_LONGER_NEW",

              cardId:
                Number(
                  existingCardResult
                    .rows[0]
                    .card_id
                ),

              cardType:
                existingCardResult
                  .rows[0]
                  .card_type,

              status:
                existingCardResult
                  .rows[0]
                  .status,
            });
        }


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

          await client.query(
            "ROLLBACK"
          );


          return reply
            .status(409)
            .send({
              error:
                "UID_HAS_PENDING_REGISTRATION",

              registrationId:
                pendingRegistrationResult
                  .rows[0]
                  .id,

              cardId:
                Number(
                  pendingRegistrationResult
                    .rows[0]
                    .reserved_card_id
                ),
            });
        }


        /*
         * -------------------------------------------------
         * RESERVAR card_id SIN CREAR cards
         * -------------------------------------------------
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


        if (
          !Number.isSafeInteger(
            reservedCardId
          ) ||
          reservedCardId <=
            0
        ) {

          throw new Error(
            "INVALID_RESERVED_CARD_ID"
          );
        }


        /*
         * -------------------------------------------------
         * REGISTRATION PENDING DEL CHECKOUT
         * -------------------------------------------------
         */

        const registrationIdempotencyKey =
          `checkout:${checkout.id}:registration`;


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
                  'CUSTOMER',
                  $8,
                  'PENDING'
              )

              returning *
            `,
            [
              registrationIdempotencyKey,
              checkout.device_id,
              checkout.actor_role ===
                "ADMIN"
                ? checkout.actor_card_id
                : null,
              checkout.actor_role,
              checkout.actor_card_id,
              checkout.recharge_point_id,
              normalizedTargetUid,
              reservedCardId,
            ]
          );


        const registration =
          registrationResult.rows[0];


        const updatedCheckoutResult =
          await client.query(
            `
              update recharge_checkouts

              set
                  registration_id = $2,
                  status = 'IN_PROGRESS',
                  updated_at = now()

              where id = $1

              returning *
            `,
            [
              checkout.id,
              registration.id,
            ]
          );


        const updatedCheckout =
          updatedCheckoutResult.rows[0];


        await client.query(
          "COMMIT"
        );


        return {
          authorized:
            true,

          duplicated:
            false,

          checkout:
            mapCheckoutRow(
              updatedCheckout
            ),

          registration: {
            registrationId:
              registration.id,

            status:
              registration.status,

            reservedCardId,
          },

          beforeCardState:
            null,

          finalCardState: {
            cardId:
              reservedCardId,

            uid:
              normalizedTargetUid,

            cardType:
              "CUSTOMER",

            status:
              "ACTIVE",

            balance:
              Number(
                updatedCheckout
                  .credited_amount
              ),

            transactionCounter:
              1,
          },
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


        if (
          error?.code ===
          "22P02"
        ) {

          return reply
            .status(400)
            .send({
              error:
                "INVALID_CHECKOUT_ID",
            });
        }


        if (
          error?.code ===
          "23505"
        ) {

          return reply
            .status(409)
            .send({
              error:
                "CHECKOUT_AUTHORIZATION_CONFLICT",

              constraint:
                error
                  ?.constraint ??
                null,
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
   * RESUME / RECOVER OPEN CHECKOUT
   * =====================================================
   *
   * POST /recharge-checkouts/resume
   *
   * Ruta READ-ONLY para recuperar una operación abierta por UID.
   *
   * Casos:
   *
   * NONE
   *   No existe checkout abierto para ese UID.
   *
   * PREPARED
   *   Existe checkout PENDING. Android puede volver a llamar
   *   /authorize con el checkoutId devuelto.
   *
   * IN_PROGRESS
   *   Existe checkout autorizado. Para NEW se devuelve el mismo
   *   reservedCardId y el estado NFC final esperado. Android debe:
   *   - si NFC sigue virgen/BEFORE: escribir ese estado;
   *   - si NFC ya coincide con AFTER: NO reescribir y confirmar;
   *   - si NFC es otro estado: detener y escalar a revisión manual.
   *
   * MANUAL_REVIEW_REQUIRED
   *   Nunca se intenta reparar automáticamente.
   *
   * Esta ruta NO modifica ninguna tabla.
   * =====================================================
   */

  server.post<{
    Body: ResumeCheckoutBody;
  }>(
    "/recharge-checkouts/resume",

    async (request, reply) => {

      const {
        deviceCode,
        targetUid,
      } = request.body;


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


      const normalizedDeviceCode =
        deviceCode.trim();

      const normalizedTargetUid =
        normalizeUid(
          targetUid
        );


      const client =
        await db.connect();


      try {

        const deviceResult =
          await client.query(
            `
              select
                  id,
                  device_code,
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

          return reply
            .status(403)
            .send({
              error:
                "DEVICE_NOT_ACTIVE",
            });
        }


        const checkoutResult =
          await client.query(
            `
              select *

              from recharge_checkouts

              where upper(target_uid) = $1
                and status in (
                  'PENDING',
                  'IN_PROGRESS',
                  'MANUAL_REVIEW_REQUIRED'
                )

              order by created_at desc

              limit 1
            `,
            [
              normalizedTargetUid,
            ]
          );


        if (
          checkoutResult.rowCount ===
          0
        ) {

          return {
            found:
              false,

            state:
              "NONE",

            checkout:
              null,

            registration:
              null,

            finalCardState:
              null,
          };
        }


        const checkout =
          checkoutResult.rows[0];


        if (
          checkout.device_id !==
          device.id
        ) {

          return reply
            .status(409)
            .send({
              error:
                "CHECKOUT_OWNED_BY_ANOTHER_DEVICE",

              checkoutId:
                checkout.id,
            });
        }


        if (
          checkout.status ===
          "MANUAL_REVIEW_REQUIRED"
        ) {

          return {
            found:
              true,

            state:
              "MANUAL_REVIEW_REQUIRED",

            checkout:
              mapCheckoutRow(
                checkout
              ),

            registration:
              null,

            finalCardState:
              null,
          };
        }


        if (
          checkout.status ===
          "PENDING"
        ) {

          return {
            found:
              true,

            state:
              "PREPARED",

            checkout:
              mapCheckoutRow(
                checkout
              ),

            registration:
              null,

            finalCardState:
              null,
          };
        }


        /*
         * IN_PROGRESS - EXISTING.
         * La transacción AUTHORIZED contiene BEFORE y AFTER.
         */
        if (
          checkout.card_path ===
          "EXISTING"
        ) {

          if (
            checkout.recharge_transaction_id ===
              null ||
            checkout.card_id ===
              null
          ) {

            return reply
              .status(409)
              .send({
                error:
                  "CHECKOUT_STATE_INCONSISTENT",

                reason:
                  "EXISTING_WITHOUT_RECHARGE_TRANSACTION",
              });
          }

          const transactionResult =
            await client.query(
              `
                select *
                from transactions
                where id = $1
                limit 1
              `,
              [
                checkout.recharge_transaction_id,
              ]
            );

          if (
            transactionResult.rowCount ===
            0
          ) {

            return reply
              .status(409)
              .send({
                error:
                  "CHECKOUT_STATE_INCONSISTENT",

                reason:
                  "RECHARGE_TRANSACTION_NOT_FOUND",
              });
          }

          const transaction =
            transactionResult.rows[0];

          if (
            Number(
              transaction.card_id
            ) !==
              Number(
                checkout.card_id
              ) ||
            transaction.card_write_status !==
              "AUTHORIZED"
          ) {

            return reply
              .status(409)
              .send({
                error:
                  "CHECKOUT_STATE_INCONSISTENT",

                reason:
                  "RECHARGE_TRANSACTION_STATE_MISMATCH",
              });
          }

          return {
            found:
              true,

            state:
              "IN_PROGRESS",

            checkout:
              mapCheckoutRow(
                checkout
              ),

            registration:
              null,

            transaction: {
              transactionId:
                transaction.id,

              status:
                transaction.card_write_status,
            },

            beforeCardState: {
              cardId:
                Number(
                  transaction.card_id
                ),

              uid:
                normalizedTargetUid,

              cardType:
                "CUSTOMER",

              status:
                "ACTIVE",

              balance:
                Number(
                  transaction.balance_before
                ),

              transactionCounter:
                Number(
                  transaction.counter_before
                ),
            },

            finalCardState: {
              cardId:
                Number(
                  transaction.card_id
                ),

              uid:
                normalizedTargetUid,

              cardType:
                "CUSTOMER",

              status:
                "ACTIVE",

              balance:
                Number(
                  transaction.balance_after
                ),

              transactionCounter:
                Number(
                  transaction.counter_after
                ),
            },
          };
        }


        if (
          checkout.card_path !==
            "NEW" &&
          checkout.card_path !==
            "REUSED"
        ) {

          return reply
            .status(409)
            .send({
              error:
                "RESUME_CARD_PATH_NOT_SUPPORTED",

              cardPath:
                checkout.card_path,
            });
        }


        if (
          checkout.registration_id ===
          null
        ) {

          return reply
            .status(409)
            .send({
              error:
                "CHECKOUT_STATE_INCONSISTENT",

              reason:
                "IN_PROGRESS_WITHOUT_REGISTRATION",
            });
        }


        const registrationResult =
          await client.query(
            `
              select
                  id,
                  target_uid,
                  target_card_type,
                  reserved_card_id,
                  status,
                  actor_role,
                  actor_card_id,
                  recharge_point_id,
                  confirmed_at,
                  failed_at,
                  failure_reason

              from card_registrations

              where id = $1

              limit 1
            `,
            [
              checkout.registration_id,
            ]
          );


        if (
          registrationResult.rowCount ===
          0
        ) {

          return reply
            .status(409)
            .send({
              error:
                "CHECKOUT_STATE_INCONSISTENT",

              reason:
                "REGISTRATION_NOT_FOUND",
            });
        }


        const registration =
          registrationResult.rows[0];


        if (
          registration.status !==
          "PENDING" ||
          normalizeUid(
            registration.target_uid
          ) !==
            normalizedTargetUid ||
          registration.target_card_type !==
            "CUSTOMER"
        ) {

          return reply
            .status(409)
            .send({
              error:
                "CHECKOUT_STATE_INCONSISTENT",

              reason:
                "REGISTRATION_STATE_MISMATCH",
            });
        }


        const reservedCardId =
          Number(
            registration.reserved_card_id
          );


        if (
          !Number.isSafeInteger(
            reservedCardId
          ) ||
          reservedCardId <= 0
        ) {

          return reply
            .status(409)
            .send({
              error:
                "CHECKOUT_STATE_INCONSISTENT",

              reason:
                "INVALID_RESERVED_CARD_ID",
            });
        }


        return {
          found:
            true,

          state:
            "IN_PROGRESS",

          checkout:
            mapCheckoutRow(
              checkout
            ),

          registration: {
            registrationId:
              registration.id,

            status:
              registration.status,

            reservedCardId,
          },

          beforeCardState:
            checkout.card_path ===
              "REUSED"
              ? {
                  cardId:
                    reservedCardId,
                  uid:
                    normalizedTargetUid,
                  cardType:
                    "CUSTOMER",
                  status:
                    "INACTIVE",
                  balance:
                    0,
                  transactionCounter:
                    0,
                }
              : null,

          finalCardState: {
            cardId:
              reservedCardId,

            uid:
              normalizedTargetUid,

            cardType:
              "CUSTOMER",

            status:
              "ACTIVE",

            balance:
              Number(
                checkout.credited_amount
              ),

            transactionCounter:
              1,
          },
        };


      } catch (
        error: any
      ) {

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
   * RECONCILE CHECKOUT
   * =====================================================
   *
   * POST /recharge-checkouts/reconcile
   *
   * Recuperación checkout-aware después de una interrupción.
   *
   * IMPORTANTE:
   * - nunca decide por timeout;
   * - nunca inventa el estado físico;
   * - AFTER no se vuelve a escribir: Android debe llamar /confirm;
   * - BEFORE libera la operación de forma explícita;
   * - un tercer estado entra en MANUAL_REVIEW_REQUIRED.
   *
   * EXISTING:
   *   BEFORE -> transaction FAILED + checkout FAILED.
   *   AFTER  -> CONFIRM_REQUIRED.
   *   otro   -> incidente forense + REVERSAL_REQUIRED +
   *             financial_hold + checkout MANUAL_REVIEW_REQUIRED.
   *
   * NEW:
   *   virgen -> registration FAILED + checkout FAILED.
   *   AFTER  -> CONFIRM_REQUIRED.
   *   otro   -> checkout MANUAL_REVIEW_REQUIRED.
   *
   * Para NEW todavía no existe una fila cards ni una transaction antes
   * de /confirm. Por eso un estado físico inesperado NO crea una fila
   * falsa en cards ni un card_financial_incident artificial. El checkout
   * y la reservación quedan preservados para revisión manual.
   * =====================================================
   */

  server.post<{
    Body: ReconcileCheckoutBody;
  }>(
    "/recharge-checkouts/reconcile",

    async (request, reply) => {

      const {
        checkoutId,
        deviceCode,
        targetUid,
        isVirgin,
        cardId,
        cardBalance,
        cardCounter,
      } = request.body;


      if (
        !isNonEmptyString(
          checkoutId
        )
      ) {

        return reply
          .status(400)
          .send({
            error:
              "INVALID_CHECKOUT_ID",
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


      const normalizedCheckoutId =
        checkoutId.trim();


      const normalizedDeviceCode =
        deviceCode.trim();


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
         * -------------------------------------------------
         * CHECKOUT + DEVICE
         * -------------------------------------------------
         */

        const checkoutResult =
          await client.query(
            `
              select
                  c.*,
                  d.device_code,
                  d.status
                    as device_status

              from recharge_checkouts c

              join devices d
                  on d.id =
                     c.device_id

              where c.id = $1

              limit 1

              for update of c
            `,
            [
              normalizedCheckoutId,
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
                "RECHARGE_CHECKOUT_NOT_FOUND",
            });
        }


        const checkout =
          checkoutResult.rows[0];


        if (
          checkout.device_code !==
          normalizedDeviceCode
        ) {

          await client.query(
            "ROLLBACK"
          );


          return reply
            .status(409)
            .send({
              error:
                "CHECKOUT_DEVICE_MISMATCH",
            });
        }


        if (
          checkout.device_status !==
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


        if (
          normalizeUid(
            String(
              checkout.target_uid
            )
          ) !==
          normalizedTargetUid
        ) {

          await client.query(
            "ROLLBACK"
          );


          return reply
            .status(409)
            .send({
              error:
                "CHECKOUT_UID_MISMATCH",
            });
        }


        /*
         * -------------------------------------------------
         * ESTADOS TERMINALES / PREPARED
         * -------------------------------------------------
         */

        if (
          checkout.status ===
          "CONFIRMED"
        ) {

          await client.query(
            "COMMIT"
          );


          return {
            reconciled:
              true,

            action:
              "ALREADY_CONFIRMED",

            checkout:
              mapCheckoutRow(
                checkout
              ),
          };
        }


        if (
          checkout.status ===
          "FAILED"
        ) {

          await client.query(
            "COMMIT"
          );


          return {
            reconciled:
              true,

            action:
              "ALREADY_FAILED",

            checkout:
              mapCheckoutRow(
                checkout
              ),
          };
        }


        if (
          checkout.status ===
          "MANUAL_REVIEW_REQUIRED"
        ) {

          await client.query(
            "COMMIT"
          );


          return reply
            .status(409)
            .send({
              error:
                "MANUAL_REVIEW_REQUIRED",

              checkout:
                mapCheckoutRow(
                  checkout
                ),
            });
        }


        if (
          checkout.status ===
          "PENDING"
        ) {

          await client.query(
            "COMMIT"
          );


          return {
            reconciled:
              false,

            action:
              "CHECKOUT_STILL_PREPARED",

            checkout:
              mapCheckoutRow(
                checkout
              ),
          };
        }


        if (
          checkout.status !==
          "IN_PROGRESS"
        ) {

          await client.query(
            "ROLLBACK"
          );


          return reply
            .status(409)
            .send({
              error:
                "CHECKOUT_STATE_NOT_RECONCILABLE",

              status:
                checkout.status,
            });
        }


        /*
         * -------------------------------------------------
         * REUSED CUSTOMER
         * -------------------------------------------------
         *
         * BEFORE físico = misma CUSTOMER devuelta 0/0.
         * AFTER físico  = misma CUSTOMER ACTIVE con crédito/1.
         * PostgreSQL debe seguir en BEFORE hasta /confirm.
         */

        if (
          checkout.card_path ===
          "REUSED"
        ) {

          if (
            checkout.card_id ===
              null ||
            checkout.registration_id ===
              null ||
            checkout.recharge_transaction_id !==
              null ||
            checkout.activation_transaction_id !==
              null
          ) {

            await client.query(
              "ROLLBACK"
            );

            return reply
              .status(409)
              .send({
                error:
                  "REUSED_CHECKOUT_STATE_INVALID",
              });
          }

          const registrationResult =
            await client.query(
              `
                select *
                from card_registrations
                where id = $1
                for update
              `,
              [
                checkout.registration_id,
              ]
            );

          if (
            registrationResult.rowCount ===
            0
          ) {

            await client.query(
              "ROLLBACK"
            );

            return reply
              .status(409)
              .send({
                error:
                  "CHECKOUT_REGISTRATION_NOT_FOUND",
              });
          }

          const registration =
            registrationResult.rows[0];

          if (
            registration.status !==
              "PENDING" ||
            normalizeUid(
              registration.target_uid
            ) !==
              normalizedTargetUid ||
            registration.target_card_type !==
              "CUSTOMER" ||
            Number(
              registration.reserved_card_id
            ) !==
              Number(
                checkout.card_id
              )
          ) {

            await client.query(
              "ROLLBACK"
            );

            return reply
              .status(409)
              .send({
                error:
                  "CHECKOUT_REGISTRATION_STATE_MISMATCH",
              });
          }

          const reusableCardResult =
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
                    last_activation.id as last_activation_id,
                    last_activation.status as last_activation_status,
                    (r.id is not null) as has_return_audit
                from cards c
                left join lateral (
                  select id, status, activation_number
                  from customer_card_activations
                  where card_id = c.card_id
                  order by activation_number desc
                  limit 1
                ) last_activation on true
                left join customer_card_returns r
                  on r.activation_id = last_activation.id
                where c.card_id = $1
                for update of c
              `,
              [
                checkout.card_id,
              ]
            );

          if (
            reusableCardResult.rowCount ===
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

          const reusableCard =
            reusableCardResult.rows[0];

          const serverIsBefore =
            normalizeUid(
              reusableCard.uid
            ) ===
              normalizedTargetUid &&
            reusableCard.card_type ===
              "CUSTOMER" &&
            reusableCard.status ===
              "INACTIVE" &&
            Number(
              reusableCard.balance
            ) ===
              0 &&
            Number(
              reusableCard.transaction_counter
            ) ===
              0 &&
            reusableCard.current_activation_id ===
              null &&
            reusableCard.last_activation_id !==
              null &&
            reusableCard.last_activation_status ===
              "RETURNED" &&
            Boolean(
              reusableCard.has_return_audit
            ) &&
            reusableCard.financial_hold !==
              true;

          if (
            !serverIsBefore
          ) {

            await client.query(
              "ROLLBACK"
            );

            return reply
              .status(409)
              .send({
                error:
                  "REUSED_SERVER_STATE_MISMATCH",
              });
          }

          if (
            isVirgin ===
            true
          ) {

            const manualCheckoutResult =
              await client.query(
                `
                  update recharge_checkouts
                  set
                      status = 'MANUAL_REVIEW_REQUIRED',
                      failure_reason = 'Reconciliación checkout REUSED: Android reportó NFC virgen.',
                      updated_at = now()
                  where id = $1
                  returning *
                `,
                [
                  checkout.id,
                ]
              );

            await client.query(
              `
                update cards
                set
                    financial_hold = true,
                    financial_hold_reason = 'MANUAL_REVIEW_REQUIRED',
                    financial_hold_at = coalesce(financial_hold_at, now()),
                    updated_at = now()
                where card_id = $1
              `,
              [
                checkout.card_id,
              ]
            );

            await client.query(
              "COMMIT"
            );

            return reply
              .status(409)
              .send({
                error:
                  "MANUAL_REVIEW_REQUIRED",
                reason:
                  "REUSED_CARD_OBSERVED_AS_VIRGIN",
                financialHold:
                  true,
                checkout:
                  mapCheckoutRow(
                    manualCheckoutResult.rows[0]
                  ),
              });
          }

          if (
            !Number.isSafeInteger(
              cardId
            ) ||
            Number(cardId) <=
              0 ||
            !Number.isSafeInteger(
              cardBalance
            ) ||
            Number(cardBalance) <
              0 ||
            !Number.isSafeInteger(
              cardCounter
            ) ||
            Number(cardCounter) <
              0
          ) {

            await client.query(
              "ROLLBACK"
            );

            return reply
              .status(400)
              .send({
                error:
                  "REUSED_OBSERVED_CARD_STATE_REQUIRED",
              });
          }

          const expectedCardId =
            Number(
              checkout.card_id
            );
          const expectedAfterBalance =
            Number(
              checkout.credited_amount
            );
          const expectedAfterCounter =
            1;

          const observedIsBefore =
            Number(cardId) ===
              expectedCardId &&
            Number(cardBalance) ===
              0 &&
            Number(cardCounter) ===
              0;

          const observedIsAfter =
            Number(cardId) ===
              expectedCardId &&
            Number(cardBalance) ===
              expectedAfterBalance &&
            Number(cardCounter) ===
              expectedAfterCounter;

          if (
            observedIsAfter
          ) {

            await client.query(
              "COMMIT"
            );

            return {
              reconciled:
                false,
              action:
                "CONFIRM_REQUIRED",
              cardPath:
                "REUSED",
              checkoutId:
                checkout.id,
              registrationId:
                registration.id,
              expectedAfter: {
                cardId:
                  expectedCardId,
                balance:
                  expectedAfterBalance,
                transactionCounter:
                  expectedAfterCounter,
              },
              checkout:
                mapCheckoutRow(
                  checkout
                ),
            };
          }

          if (
            observedIsBefore
          ) {

            await client.query(
              `
                update card_registrations
                set
                    status = 'FAILED',
                    failed_at = coalesce(failed_at, now()),
                    failure_reason = 'Reconciliación checkout REUSED: la NFC permaneció en estado devuelto 0/0.'
                where id = $1
              `,
              [
                registration.id,
              ]
            );

            const failedCheckoutResult =
              await client.query(
                `
                  update recharge_checkouts
                  set
                      status = 'FAILED',
                      failed_at = coalesce(failed_at, now()),
                      failure_reason = 'Reconciliación checkout REUSED: la NFC permaneció en estado devuelto 0/0.',
                      updated_at = now()
                  where id = $1
                  returning *
                `,
                [
                  checkout.id,
                ]
              );

            await client.query(
              "COMMIT"
            );

            return {
              reconciled:
                true,
              action:
                "FAILED_REUSED_CHECKOUT_BEFORE_WRITE",
              registrationId:
                registration.id,
              cardId:
                expectedCardId,
              balance:
                0,
              transactionCounter:
                0,
              checkout:
                mapCheckoutRow(
                  failedCheckoutResult.rows[0]
                ),
            };
          }

          await client.query(
            `
              update cards
              set
                  financial_hold = true,
                  financial_hold_reason = 'MANUAL_REVIEW_REQUIRED',
                  financial_hold_at = coalesce(financial_hold_at, now()),
                  updated_at = now()
              where card_id = $1
            `,
            [
              checkout.card_id,
            ]
          );

          const manualCheckoutResult =
            await client.query(
              `
                update recharge_checkouts
                set
                    status = 'MANUAL_REVIEW_REQUIRED',
                    failure_reason = 'Reconciliación checkout REUSED: estado físico inesperado.',
                    updated_at = now()
                where id = $1
                returning *
              `,
              [
                checkout.id,
              ]
            );

          await client.query(
            "COMMIT"
          );

          return reply
            .status(409)
            .send({
              error:
                "MANUAL_REVIEW_REQUIRED",
              reason:
                "REUSED_CARD_STATE_MISMATCH",
              financialHold:
                true,
              expectedBefore: {
                cardId:
                  expectedCardId,
                balance:
                  0,
                transactionCounter:
                  0,
              },
              expectedAfter: {
                cardId:
                  expectedCardId,
                balance:
                  expectedAfterBalance,
                transactionCounter:
                  expectedAfterCounter,
              },
              observedCardState: {
                cardId:
                  Number(cardId),
                balance:
                  Number(cardBalance),
                transactionCounter:
                  Number(cardCounter),
              },
              checkout:
                mapCheckoutRow(
                  manualCheckoutResult.rows[0]
                ),
            });
        }


        /*
         * -------------------------------------------------
         * NEW CUSTOMER
         * -------------------------------------------------
         */

        if (
          checkout.card_path ===
          "NEW"
        ) {

          if (
            checkout.registration_id ===
              null ||
            checkout.card_id !==
              null
          ) {

            await client.query(
              "ROLLBACK"
            );


            return reply
              .status(409)
              .send({
                error:
                  "NEW_CHECKOUT_STATE_INVALID",
              });
          }


          const registrationResult =
            await client.query(
              `
                select *
                from card_registrations
                where id = $1
                for update
              `,
              [
                checkout.registration_id,
              ]
            );


          if (
            registrationResult.rowCount ===
            0
          ) {

            await client.query(
              "ROLLBACK"
            );


            return reply
              .status(409)
              .send({
                error:
                  "CHECKOUT_REGISTRATION_NOT_FOUND",
              });
          }


          const registration =
            registrationResult.rows[0];


          const reservedCardId =
            Number(
              registration.reserved_card_id
            );


          if (
            registration.status !==
              "PENDING" ||
            normalizeUid(
              String(
                registration.target_uid
              )
            ) !==
              normalizedTargetUid ||
            registration.target_card_type !==
              "CUSTOMER" ||
            !Number.isSafeInteger(
              reservedCardId
            ) ||
            reservedCardId <=
              0
          ) {

            await client.query(
              "ROLLBACK"
            );


            return reply
              .status(409)
              .send({
                error:
                  "CHECKOUT_REGISTRATION_STATE_MISMATCH",
              });
          }


          /*
           * NFC continúa virgen.
           *
           * Antes de liberar la reservación comprobamos que no exista
           * una CUSTOMER materializada con ese card_id o UID.
           */

          if (
            isVirgin ===
            true
          ) {

            const materializedCardResult =
              await client.query(
                `
                  select
                      card_id,
                      uid,
                      balance,
                      transaction_counter

                  from cards

                  where card_id = $1
                     or upper(uid) =
                        upper($2)

                  limit 1

                  for update
                `,
                [
                  reservedCardId,
                  normalizedTargetUid,
                ]
              );


            if (
              materializedCardResult.rowCount &&
              materializedCardResult.rowCount >
                0
            ) {

              const manualCheckoutResult =
                await client.query(
                  `
                    update recharge_checkouts
                    set
                        status =
                          'MANUAL_REVIEW_REQUIRED',
                        failure_reason =
                          'Reconciliación checkout NEW: Android reportó NFC virgen pero ya existe una tarjeta materializada.',
                        updated_at =
                          now()
                    where id = $1
                    returning *
                  `,
                  [
                    checkout.id,
                  ]
                );


              await client.query(
                "COMMIT"
              );


              return reply
                .status(409)
                .send({
                  error:
                    "MANUAL_REVIEW_REQUIRED",

                  reason:
                    "NEW_VIRGIN_BUT_CARD_ALREADY_MATERIALIZED",

                  checkout:
                    mapCheckoutRow(
                      manualCheckoutResult
                        .rows[0]
                    ),
                });
            }


            await client.query(
              `
                update card_registrations
                set
                    status = 'FAILED',
                    failed_at =
                      coalesce(
                        failed_at,
                        now()
                      ),
                    failure_reason =
                      'Reconciliación checkout: la NFC permaneció virgen.'
                where id = $1
              `,
              [
                registration.id,
              ]
            );


            const failedCheckoutResult =
              await client.query(
                `
                  update recharge_checkouts
                  set
                      status = 'FAILED',
                      failed_at =
                        coalesce(
                          failed_at,
                          now()
                        ),
                      failure_reason =
                        'Reconciliación checkout: la NFC permaneció virgen.',
                      updated_at =
                        now()
                  where id = $1
                  returning *
                `,
                [
                  checkout.id,
                ]
              );


            await client.query(
              "COMMIT"
            );


            return {
              reconciled:
                true,

              action:
                "FAILED_NEW_CHECKOUT_BEFORE_WRITE",

              registrationId:
                registration.id,

              reservedCardId,

              checkout:
                mapCheckoutRow(
                  failedCheckoutResult
                    .rows[0]
                ),
            };
          }


          /*
           * Si Android no reporta virgen debe entregar un estado físico
           * Meneses completo.
           */

          if (
            !Number.isSafeInteger(
              cardId
            ) ||
            Number(
              cardId
            ) <=
              0 ||
            !Number.isSafeInteger(
              cardBalance
            ) ||
            Number(
              cardBalance
            ) <
              0 ||
            !Number.isSafeInteger(
              cardCounter
            ) ||
            Number(
              cardCounter
            ) <
              0
          ) {

            await client.query(
              "ROLLBACK"
            );


            return reply
              .status(400)
              .send({
                error:
                  "NEW_OBSERVED_CARD_STATE_REQUIRED",
              });
          }


          const expectedBalance =
            Number(
              checkout.credited_amount
            );


          const expectedCounter =
            1;


          const observedIsAfter =
            Number(
              cardId
            ) ===
              reservedCardId &&
            Number(
              cardBalance
            ) ===
              expectedBalance &&
            Number(
              cardCounter
            ) ===
              expectedCounter;


          if (
            observedIsAfter
          ) {

            await client.query(
              "COMMIT"
            );


            return {
              reconciled:
                false,

              action:
                "CONFIRM_REQUIRED",

              cardPath:
                "NEW",

              checkoutId:
                checkout.id,

              registrationId:
                registration.id,

              expectedAfter: {
                cardId:
                  reservedCardId,

                balance:
                  expectedBalance,

                transactionCounter:
                  expectedCounter,
              },

              checkout:
                mapCheckoutRow(
                  checkout
                ),
            };
          }


          /*
           * NEW inesperado:
           *
           * No existe aún transaction ni cards row válida sobre la cual
           * aplicar financial_hold. Preservamos checkout + registration
           * y bloqueamos ese UID vía el índice de checkout abierto.
           */

          const manualCheckoutResult =
            await client.query(
              `
                update recharge_checkouts
                set
                    status =
                      'MANUAL_REVIEW_REQUIRED',
                    failure_reason =
                      'Reconciliación checkout NEW: estado físico inesperado.',
                    updated_at =
                      now()
                where id = $1
                returning *
              `,
              [
                checkout.id,
              ]
            );


          await client.query(
            "COMMIT"
          );


          return reply
            .status(409)
            .send({
              error:
                "MANUAL_REVIEW_REQUIRED",

              reason:
                "NEW_CARD_STATE_MISMATCH",

              financialHold:
                false,

              note:
                "No se creó una fila cards ni un incidente financiero artificial; checkout y registration quedan preservados.",

              expectedAfter: {
                cardId:
                  reservedCardId,

                balance:
                  expectedBalance,

                transactionCounter:
                  expectedCounter,
              },

              observedCardState: {
                cardId:
                  Number(
                    cardId
                  ),

                balance:
                  Number(
                    cardBalance
                  ),

                transactionCounter:
                  Number(
                    cardCounter
                  ),
              },

              checkout:
                mapCheckoutRow(
                  manualCheckoutResult
                    .rows[0]
                ),
            });
        }


        /*
         * -------------------------------------------------
         * EXISTING CUSTOMER
         * -------------------------------------------------
         */

        if (
          checkout.card_path ===
          "EXISTING"
        ) {

          if (
            checkout.card_id ===
              null ||
            checkout.recharge_transaction_id ===
              null ||
            checkout.registration_id !==
              null
          ) {

            await client.query(
              "ROLLBACK"
            );


            return reply
              .status(409)
              .send({
                error:
                  "EXISTING_CHECKOUT_STATE_INVALID",
              });
          }


          if (
            isVirgin ===
              true ||
            !Number.isSafeInteger(
              cardId
            ) ||
            Number(
              cardId
            ) <=
              0 ||
            !Number.isSafeInteger(
              cardBalance
            ) ||
            Number(
              cardBalance
            ) <
              0 ||
            !Number.isSafeInteger(
              cardCounter
            ) ||
            Number(
              cardCounter
            ) <
              0
          ) {

            await client.query(
              "ROLLBACK"
            );


            return reply
              .status(400)
              .send({
                error:
                  "EXISTING_OBSERVED_CARD_STATE_REQUIRED",
              });
          }


          const existingCardResult =
            await client.query(
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
                    financial_hold_at

                from cards

                where card_id = $1

                for update
              `,
              [
                checkout.card_id,
              ]
            );


          if (
            existingCardResult.rowCount ===
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


          const existingCard =
            existingCardResult.rows[0];


          if (
            normalizeUid(
              String(
                existingCard.uid
              )
            ) !==
              normalizedTargetUid ||
            existingCard.card_type !==
              "CUSTOMER" ||
            existingCard.status !==
              "ACTIVE" ||
            existingCard.current_activation_id ===
              null ||
            Number(
              existingCard.card_id
            ) !==
              Number(
                checkout.card_id
              )
          ) {

            await client.query(
              "ROLLBACK"
            );


            return reply
              .status(409)
              .send({
                error:
                  "EXISTING_CUSTOMER_STATE_INVALID",
              });
          }


          const transactionResult =
            await client.query(
              `
                select *
                from transactions
                where id = $1
                for update
              `,
              [
                checkout.recharge_transaction_id,
              ]
            );


          if (
            transactionResult.rowCount ===
            0
          ) {

            await client.query(
              "ROLLBACK"
            );


            return reply
              .status(409)
              .send({
                error:
                  "CHECKOUT_RECHARGE_TRANSACTION_NOT_FOUND",
              });
          }


          const transaction =
            transactionResult.rows[0];


          if (
            Number(
              transaction.card_id
            ) !==
              Number(
                checkout.card_id
              ) ||
            transaction.transaction_type !==
              "RECHARGE" ||
            String(
              transaction.activation_id
            ) !==
              String(
                existingCard.current_activation_id
              )
          ) {

            await client.query(
              "ROLLBACK"
            );


            return reply
              .status(409)
              .send({
                error:
                  "CHECKOUT_RECHARGE_TRANSACTION_STATE_MISMATCH",
              });
          }


          const serverBalance =
            Number(
              existingCard.balance
            );


          const serverCounter =
            Number(
              existingCard.transaction_counter
            );


          const balanceBefore =
            Number(
              transaction.balance_before
            );


          const counterBefore =
            Number(
              transaction.counter_before
            );


          const balanceAfter =
            Number(
              transaction.balance_after
            );


          const counterAfter =
            Number(
              transaction.counter_after
            );


          const observedCardId =
            Number(
              cardId
            );


          const observedBalance =
            Number(
              cardBalance
            );


          const observedCounter =
            Number(
              cardCounter
            );


          const observedIsBefore =
            observedCardId ===
              Number(
                checkout.card_id
              ) &&
            observedBalance ===
              balanceBefore &&
            observedCounter ===
              counterBefore;


          const observedIsAfter =
            observedCardId ===
              Number(
                checkout.card_id
              ) &&
            observedBalance ===
              balanceAfter &&
            observedCounter ===
              counterAfter;


          const serverIsBefore =
            serverBalance ===
              balanceBefore &&
            serverCounter ===
              counterBefore;


          const serverIsAfter =
            serverBalance ===
              balanceAfter &&
            serverCounter ===
              counterAfter;


          /*
           * Si una reconciliación genérica anterior ya confirmó la
           * transacción y cards, cerramos también el checkout.
           */

          if (
            transaction.card_write_status ===
              "CONFIRMED" &&
            serverIsAfter &&
            observedIsAfter
          ) {

            const confirmedCheckoutResult =
              await client.query(
                `
                  update recharge_checkouts
                  set
                      status = 'CONFIRMED',
                      confirmed_at =
                        coalesce(
                          confirmed_at,
                          now()
                        ),
                      failed_at = null,
                      failure_reason = null,
                      updated_at = now()
                  where id = $1
                  returning *
                `,
                [
                  checkout.id,
                ]
              );


            await client.query(
              "COMMIT"
            );


            return {
              reconciled:
                true,

              action:
                "CONFIRMED_CHECKOUT_FROM_CONFIRMED_TRANSACTION",

              transactionId:
                transaction.id,

              cardId:
                Number(
                  checkout.card_id
                ),

              balance:
                balanceAfter,

              transactionCounter:
                counterAfter,

              checkout:
                mapCheckoutRow(
                  confirmedCheckoutResult
                    .rows[0]
                ),
            };
          }


          /*
           * Si una reconciliación anterior ya declaró FAILED y tanto
           * PostgreSQL como NFC siguen en BEFORE, liberamos checkout.
           */

          if (
            transaction.card_write_status ===
              "FAILED" &&
            serverIsBefore &&
            observedIsBefore
          ) {

            const failedCheckoutResult =
              await client.query(
                `
                  update recharge_checkouts
                  set
                      status = 'FAILED',
                      failed_at =
                        coalesce(
                          failed_at,
                          now()
                        ),
                      failure_reason =
                        coalesce(
                          failure_reason,
                          'Reconciliación checkout: transacción ya estaba FAILED y la NFC permaneció BEFORE.'
                        ),
                      updated_at = now()
                  where id = $1
                  returning *
                `,
                [
                  checkout.id,
                ]
              );


            await client.query(
              "COMMIT"
            );


            return {
              reconciled:
                true,

              action:
                "FAILED_CHECKOUT_FROM_FAILED_TRANSACTION",

              transactionId:
                transaction.id,

              cardId:
                Number(
                  checkout.card_id
                ),

              balance:
                balanceBefore,

              transactionCounter:
                counterBefore,

              checkout:
                mapCheckoutRow(
                  failedCheckoutResult
                    .rows[0]
                ),
            };
          }


          if (
            transaction.card_write_status ===
              "REVERSAL_REQUIRED" ||
            existingCard.financial_hold ===
              true
          ) {

            const manualCheckoutResult =
              await client.query(
                `
                  update recharge_checkouts
                  set
                      status =
                        'MANUAL_REVIEW_REQUIRED',
                      failure_reason =
                        coalesce(
                          failure_reason,
                          'Reconciliación checkout: tarjeta o transacción ya requiere revisión manual.'
                        ),
                      updated_at =
                        now()
                  where id = $1
                  returning *
                `,
                [
                  checkout.id,
                ]
              );


            await client.query(
              "COMMIT"
            );


            return reply
              .status(409)
              .send({
                error:
                  "MANUAL_REVIEW_REQUIRED",

                transactionId:
                  transaction.id,

                financialHold:
                  Boolean(
                    existingCard.financial_hold
                  ),

                checkout:
                  mapCheckoutRow(
                    manualCheckoutResult
                      .rows[0]
                  ),
              });
          }


          /*
           * Flujo normal pendiente.
           */

          if (
            transaction.card_write_status ===
              "AUTHORIZED" &&
            serverIsBefore &&
            observedIsAfter
          ) {

            await client.query(
              "COMMIT"
            );


            return {
              reconciled:
                false,

              action:
                "CONFIRM_REQUIRED",

              cardPath:
                "EXISTING",

              transactionId:
                transaction.id,

              checkoutId:
                checkout.id,

              expectedAfter: {
                cardId:
                  Number(
                    checkout.card_id
                  ),

                balance:
                  balanceAfter,

                transactionCounter:
                  counterAfter,
              },

              checkout:
                mapCheckoutRow(
                  checkout
                ),
            };
          }


          if (
            transaction.card_write_status ===
              "AUTHORIZED" &&
            serverIsBefore &&
            observedIsBefore
          ) {

            await client.query(
              `
                update transactions
                set
                    card_write_status =
                      'FAILED',
                    failed_at =
                      coalesce(
                        failed_at,
                        now()
                      ),
                    failure_reason =
                      'Reconciliación checkout: la NFC permaneció en BEFORE.'
                where id = $1
              `,
              [
                transaction.id,
              ]
            );


            const failedCheckoutResult =
              await client.query(
                `
                  update recharge_checkouts
                  set
                      status =
                        'FAILED',
                      failed_at =
                        coalesce(
                          failed_at,
                          now()
                        ),
                      failure_reason =
                        'Reconciliación checkout: la NFC permaneció en BEFORE.',
                      updated_at =
                        now()
                  where id = $1
                  returning *
                `,
                [
                  checkout.id,
                ]
              );


            await client.query(
              "COMMIT"
            );


            return {
              reconciled:
                true,

              action:
                "FAILED_EXISTING_CHECKOUT_BEFORE_WRITE",

              transactionId:
                transaction.id,

              cardId:
                Number(
                  checkout.card_id
                ),

              balance:
                balanceBefore,

              transactionCounter:
                counterBefore,

              checkout:
                mapCheckoutRow(
                  failedCheckoutResult
                    .rows[0]
                ),
            };
          }


          /*
           * Estado inesperado.
           *
           * Igual que /transactions/reconcile:
           * - fotografía forense;
           * - transaction -> REVERSAL_REQUIRED;
           * - card -> financial_hold;
           * - checkout -> MANUAL_REVIEW_REQUIRED.
           */

          const ledgerResult =
            await client.query(
              `
                select
                    coalesce(
                      sum(
                        cfl.remaining_amount
                      ),
                      0
                    ) as ledger_balance

                from card_fund_lots cfl

                where cfl.card_id = $1
                  and cfl.activation_id = $2
              `,
              [
                checkout.card_id,
                existingCard.current_activation_id,
              ]
            );


          const ledgerBalance =
            Number(
              ledgerResult
                .rows[0]
                .ledger_balance
            );


          await client.query(
            `
              insert into card_financial_incidents (
                  card_id,
                  activation_id,
                  transaction_id,
                  incident_type,
                  device_code,
                  nfc_balance,
                  nfc_counter,
                  server_balance,
                  server_counter,
                  ledger_balance,
                  expected_before_balance,
                  expected_before_counter,
                  expected_after_balance,
                  expected_after_counter,
                  transaction_type,
                  transaction_amount,
                  promotion_id,
                  transaction_status_before,
                  failure_reason
              )

              values (
                  $1,
                  $2,
                  $3,
                  'MANUAL_REVIEW_REQUIRED',
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
                  $16,
                  $17,
                  'Reconciliación checkout: estado físico inesperado.'
              )

              on conflict (transaction_id)
              do nothing
            `,
            [
              checkout.card_id,
              existingCard.current_activation_id,
              transaction.id,
              normalizedDeviceCode,
              observedBalance,
              observedCounter,
              serverBalance,
              serverCounter,
              ledgerBalance,
              balanceBefore,
              counterBefore,
              balanceAfter,
              counterAfter,
              transaction.transaction_type,
              Number(
                transaction.amount
              ),
              transaction.promotion_id,
              transaction.card_write_status,
            ]
          );


          await client.query(
            `
              update transactions
              set
                  card_write_status =
                    'REVERSAL_REQUIRED',
                  failure_reason =
                    'Reconciliación checkout: estado físico inesperado.'
              where id = $1
            `,
            [
              transaction.id,
            ]
          );


          await client.query(
            `
              update cards
              set
                  financial_hold = true,
                  financial_hold_reason =
                    'MANUAL_REVIEW_REQUIRED',
                  financial_hold_at =
                    coalesce(
                      financial_hold_at,
                      now()
                    ),
                  updated_at = now()
              where card_id = $1
            `,
            [
              checkout.card_id,
            ]
          );


          const manualCheckoutResult =
            await client.query(
              `
                update recharge_checkouts
                set
                    status =
                      'MANUAL_REVIEW_REQUIRED',
                    failure_reason =
                      'Reconciliación checkout: estado físico inesperado.',
                    updated_at =
                      now()
                where id = $1
                returning *
              `,
              [
                checkout.id,
              ]
            );


          await client.query(
            "COMMIT"
          );


          return reply
            .status(409)
            .send({
              error:
                "MANUAL_REVIEW_REQUIRED",

              transactionId:
                transaction.id,

              financialHold:
                true,

              serverState: {
                balance:
                  serverBalance,

                transactionCounter:
                  serverCounter,
              },

              ledgerState: {
                balance:
                  ledgerBalance,
              },

              expectedBefore: {
                balance:
                  balanceBefore,

                transactionCounter:
                  counterBefore,
              },

              expectedAfter: {
                balance:
                  balanceAfter,

                transactionCounter:
                  counterAfter,
              },

              cardState: {
                cardId:
                  observedCardId,

                balance:
                  observedBalance,

                transactionCounter:
                  observedCounter,
              },

              checkout:
                mapCheckoutRow(
                  manualCheckoutResult
                    .rows[0]
                ),
            });
        }


        await client.query(
          "ROLLBACK"
        );


        return reply
          .status(409)
          .send({
            error:
              "RECONCILE_CARD_PATH_NOT_SUPPORTED",

            cardPath:
              checkout.card_path,
          });


      } catch (
        error: any
      ) {

        try {

          await client.query(
            "ROLLBACK"
          );

        } catch {
        }


        if (
          error?.code ===
          "22P02"
        ) {

          return reply
            .status(400)
            .send({
              error:
                "INVALID_CHECKOUT_ID",
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
   * CONFIRM CHECKOUT - NEW CUSTOMER
   * =====================================================
   *
   * Este endpoint se llama DESPUÉS de escribir y verificar
   * físicamente la NFC.
   *
   * Para NEW, todo el estado financiero se materializa en
   * UNA sola transacción PostgreSQL:
   *
   *   cards CUSTOMER
   *   customer_card_activations
   *   CARD_CREATED (solo RECHARGE)
   *   RECHARGE
   *   transaction_credit_components (si promoción)
   *   card_fund_lots mediante financial_commit_credit()
   *   card_registrations -> CONFIRMED
   *   recharge_checkouts -> CONFIRMED
   *
   * Si cualquier paso falla, PostgreSQL revierte TODO.
   * =====================================================
   */

  server.post<{
    Body: ConfirmCheckoutBody;
  }>(
    "/recharge-checkouts/confirm",

    async (request, reply) => {

      const {
        checkoutId,
        deviceCode,
        targetUid,
        cardId,
        writtenBalance,
        writtenCounter,
      } = request.body;


      if (
        !isNonEmptyString(
          checkoutId
        )
      ) {

        return reply
          .status(400)
          .send({
            error:
              "INVALID_CHECKOUT_ID",
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
        !Number.isSafeInteger(
          writtenBalance
        ) ||
        writtenBalance < 0
      ) {

        return reply
          .status(400)
          .send({
            error:
              "INVALID_WRITTEN_BALANCE",
          });
      }


      if (
        !Number.isSafeInteger(
          writtenCounter
        ) ||
        writtenCounter < 0
      ) {

        return reply
          .status(400)
          .send({
            error:
              "INVALID_WRITTEN_COUNTER",
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
         * -------------------------------------------------
         * CHECKOUT
         * -------------------------------------------------
         */

        const checkoutResult =
          await client.query(
            `
              select *

              from recharge_checkouts

              where id = $1

              for update
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


        /*
         * CONFIRM idempotente.
         */

        if (
          checkout.status ===
          "CONFIRMED"
        ) {

          if (
            checkout.card_id ===
              null ||
            Number(
              checkout.card_id
            ) !== cardId ||
            normalizeUid(
              checkout.target_uid
            ) !==
              normalizedTargetUid
          ) {

            await client.query(
              "ROLLBACK"
            );


            return reply
              .status(409)
              .send({
                error:
                  "CONFIRMED_CHECKOUT_STATE_MISMATCH",
              });
          }


          let expectedConfirmedBalance: number;
          let expectedConfirmedCounter: number;


          if (
            checkout.card_path ===
              "NEW" ||
            checkout.card_path ===
              "REUSED"
          ) {

            expectedConfirmedBalance =
              Number(
                checkout
                  .credited_amount
              );

            expectedConfirmedCounter =
              1;

          } else if (
            checkout.card_path ===
            "EXISTING"
          ) {

            if (
              checkout.recharge_transaction_id ===
              null
            ) {

              await client.query(
                "ROLLBACK"
              );

              return reply
                .status(409)
                .send({
                  error:
                    "CONFIRMED_CHECKOUT_TRANSACTION_REQUIRED",
                });
            }

            const confirmedTransactionResult =
              await client.query(
                `
                  select
                      card_id,
                      balance_after,
                      counter_after,
                      card_write_status
                  from transactions
                  where id = $1
                  limit 1
                `,
                [
                  checkout.recharge_transaction_id,
                ]
              );

            if (
              confirmedTransactionResult.rowCount ===
              0
            ) {

              await client.query(
                "ROLLBACK"
              );

              return reply
                .status(409)
                .send({
                  error:
                    "CONFIRMED_CHECKOUT_TRANSACTION_NOT_FOUND",
                });
            }

            const confirmedTransaction =
              confirmedTransactionResult.rows[0];

            if (
              Number(
                confirmedTransaction.card_id
              ) !== cardId ||
              confirmedTransaction.card_write_status !==
                "CONFIRMED"
            ) {

              await client.query(
                "ROLLBACK"
              );

              return reply
                .status(409)
                .send({
                  error:
                    "CONFIRMED_CHECKOUT_TRANSACTION_MISMATCH",
                });
            }

            expectedConfirmedBalance =
              Number(
                confirmedTransaction.balance_after
              );

            expectedConfirmedCounter =
              Number(
                confirmedTransaction.counter_after
              );

          } else {

            await client.query(
              "ROLLBACK"
            );

            return reply
              .status(409)
              .send({
                error:
                  "CONFIRMED_CHECKOUT_CARD_PATH_UNSUPPORTED",

                cardPath:
                  checkout.card_path,
              });
          }


          if (
            writtenBalance !==
              expectedConfirmedBalance ||
            writtenCounter !==
              expectedConfirmedCounter
          ) {

            await client.query(
              "ROLLBACK"
            );


            return reply
              .status(409)
              .send({
                error:
                  "CONFIRMED_CHECKOUT_REQUEST_MISMATCH",
              });
          }


          await client.query(
            "COMMIT"
          );


          return {
            confirmed:
              true,

            duplicated:
              true,

            checkout:
              mapCheckoutRow(
                checkout
              ),

            card: {
              cardId,

              uid:
                normalizedTargetUid,

              cardType:
                "CUSTOMER",

              status:
                "ACTIVE",

              balance:
                expectedConfirmedBalance,

              transactionCounter:
                expectedConfirmedCounter,
            },
          };
        }


        if (
          checkout.status !==
          "IN_PROGRESS"
        ) {

          await client.query(
            "ROLLBACK"
          );


          return reply
            .status(409)
            .send({
              error:
                "CHECKOUT_NOT_IN_PROGRESS",

              status:
                checkout.status,
            });
        }


        if (
          checkout.card_path !==
            "NEW" &&
          checkout.card_path !==
            "EXISTING" &&
          checkout.card_path !==
            "REUSED"
        ) {

          await client.query(
            "ROLLBACK"
          );


          return reply
            .status(409)
            .send({
              error:
                "CHECKOUT_CARD_PATH_NOT_SUPPORTED_YET",

              cardPath:
                checkout.card_path,
            });
        }


        if (
          (
            checkout.card_path ===
              "NEW" ||
            checkout.card_path ===
              "REUSED"
          ) &&
          checkout.registration_id ===
            null
        ) {

          await client.query(
            "ROLLBACK"
          );


          return reply
            .status(409)
            .send({
              error:
                "CHECKOUT_REGISTRATION_REQUIRED",
            });
        }


        if (
          normalizeUid(
            checkout.target_uid
          ) !==
          normalizedTargetUid
        ) {

          await client.query(
            "ROLLBACK"
          );


          return reply
            .status(409)
            .send({
              error:
                "CHECKOUT_UID_MISMATCH",
            });
        }


        const deviceResult =
          await client.query(
            `
              select
                  id,
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


        if (
          device.id !==
          checkout.device_id
        ) {

          await client.query(
            "ROLLBACK"
          );


          return reply
            .status(409)
            .send({
              error:
                "CHECKOUT_DEVICE_MISMATCH",
            });
        }


        /*
         * -------------------------------------------------
         * EXISTING CUSTOMER
         * -------------------------------------------------
         *
         * AUTHORIZE ya creó una transacción RECHARGE en
         * estado AUTHORIZED, pero todavía NO modificó cards
         * ni materializó el Ledger V2.
         *
         * Android solamente llega aquí después de escribir y
         * releer la NFC. CONFIRM exige exactamente el AFTER
         * autorizado antes de tocar PostgreSQL.
         */

        if (
          checkout.card_path ===
          "EXISTING"
        ) {

          if (
            checkout.card_id ===
              null ||
            checkout.recharge_transaction_id ===
              null ||
            checkout.registration_id !==
              null
          ) {

            await client.query(
              "ROLLBACK"
            );

            return reply
              .status(409)
              .send({
                error:
                  "EXISTING_CHECKOUT_STATE_INVALID",
              });
          }

          if (
            Number(
              checkout.card_id
            ) !== cardId
          ) {

            await client.query(
              "ROLLBACK"
            );

            return reply
              .status(409)
              .send({
                error:
                  "CHECKOUT_CARD_ID_MISMATCH",
              });
          }

          const existingCardResult =
            await client.query(
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
                    financial_hold_at
                from cards
                where card_id = $1
                for update
              `,
              [
                cardId,
              ]
            );

          if (
            existingCardResult.rowCount ===
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

          const existingCard =
            existingCardResult.rows[0];

          if (
            normalizeUid(
              existingCard.uid
            ) !==
              normalizedTargetUid ||
            existingCard.card_type !==
              "CUSTOMER" ||
            existingCard.status !==
              "ACTIVE" ||
            existingCard.current_activation_id ===
              null
          ) {

            await client.query(
              "ROLLBACK"
            );

            return reply
              .status(409)
              .send({
                error:
                  "EXISTING_CUSTOMER_STATE_INVALID",
              });
          }

          if (
            existingCard.financial_hold ===
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

                reason:
                  existingCard.financial_hold_reason ??
                  "MANUAL_REVIEW_REQUIRED",

                heldAt:
                  existingCard.financial_hold_at,
              });
          }

          const existingTransactionResult =
            await client.query(
              `
                select *
                from transactions
                where id = $1
                for update
              `,
              [
                checkout.recharge_transaction_id,
              ]
            );

          if (
            existingTransactionResult.rowCount ===
            0
          ) {

            await client.query(
              "ROLLBACK"
            );

            return reply
              .status(409)
              .send({
                error:
                  "RECHARGE_TRANSACTION_NOT_FOUND",
              });
          }

          const existingTransaction =
            existingTransactionResult.rows[0];

          if (
            Number(
              existingTransaction.card_id
            ) !== cardId ||
            existingTransaction.device_id !==
              checkout.device_id ||
            existingTransaction.transaction_type !==
              "RECHARGE" ||
            existingTransaction.card_write_status !==
              "AUTHORIZED" ||
            existingTransaction.actor_role !==
              checkout.actor_role ||
            Number(
              existingTransaction.actor_card_id
            ) !==
              Number(
                checkout.actor_card_id
              ) ||
            existingTransaction.activation_id !==
              existingCard.current_activation_id
          ) {

            await client.query(
              "ROLLBACK"
            );

            return reply
              .status(409)
              .send({
                error:
                  "RECHARGE_TRANSACTION_STATE_MISMATCH",
              });
          }

          if (
            checkout.actor_role ===
              "RECHARGE" &&
            existingTransaction.recharge_point_id !==
              checkout.recharge_point_id
          ) {

            await client.query(
              "ROLLBACK"
            );

            return reply
              .status(409)
              .send({
                error:
                  "RECHARGE_POINT_MISMATCH",
              });
          }

          const expectedBeforeBalance =
            Number(
              existingTransaction.balance_before
            );

          const expectedBeforeCounter =
            Number(
              existingTransaction.counter_before
            );

          const expectedAfterBalance =
            Number(
              existingTransaction.balance_after
            );

          const expectedAfterCounter =
            Number(
              existingTransaction.counter_after
            );

          if (
            writtenBalance !==
              expectedAfterBalance ||
            writtenCounter !==
              expectedAfterCounter
          ) {

            await client.query(
              "ROLLBACK"
            );

            return reply
              .status(409)
              .send({
                error:
                  "CONFIRMATION_STATE_MISMATCH",

                expected: {
                  cardId,
                  uid:
                    normalizedTargetUid,
                  balance:
                    expectedAfterBalance,
                  transactionCounter:
                    expectedAfterCounter,
                },
              });
          }

          if (
            Number(
              existingCard.balance
            ) !==
              expectedBeforeBalance ||
            Number(
              existingCard.transaction_counter
            ) !==
              expectedBeforeCounter
          ) {

            await client.query(
              "ROLLBACK"
            );

            return reply
              .status(409)
              .send({
                error:
                  "SERVER_CARD_STATE_MISMATCH",

                serverState: {
                  balance:
                    Number(
                      existingCard.balance
                    ),
                  transactionCounter:
                    Number(
                      existingCard.transaction_counter
                    ),
                },

                expectedBefore: {
                  balance:
                    expectedBeforeBalance,
                  transactionCounter:
                    expectedBeforeCounter,
                },
              });
          }

          await client.query(
            `
              select financial_commit_credit(
                  $1
              )
            `,
            [
              existingTransaction.id,
            ]
          );

          await client.query(
            `
              update cards
              set
                  balance = $2,
                  transaction_counter = $3,
                  updated_at = now()
              where card_id = $1
            `,
            [
              cardId,
              expectedAfterBalance,
              expectedAfterCounter,
            ]
          );

          await client.query(
            `
              update transactions
              set
                  card_write_status = 'CONFIRMED',
                  confirmed_at = now(),
                  failed_at = null,
                  failure_reason = null
              where id = $1
            `,
            [
              existingTransaction.id,
            ]
          );

          const confirmedExistingCheckoutResult =
            await client.query(
              `
                update recharge_checkouts
                set
                    status = 'CONFIRMED',
                    failure_reason = null,
                    confirmed_at = now(),
                    failed_at = null,
                    updated_at = now()
                where id = $1
                returning *
              `,
              [
                checkout.id,
              ]
            );

          const confirmedExistingCheckout =
            confirmedExistingCheckoutResult.rows[0];

          await client.query(
            "COMMIT"
          );

          return {
            confirmed:
              true,

            duplicated:
              false,

            checkout:
              mapCheckoutRow(
                confirmedExistingCheckout
              ),

            transactions: {
              cardCreatedTransactionId:
                null,

              rechargeTransactionId:
                existingTransaction.id,
            },

            card: {
              cardId,

              uid:
                normalizedTargetUid,

              cardType:
                "CUSTOMER",

              status:
                "ACTIVE",

              balance:
                expectedAfterBalance,

              transactionCounter:
                expectedAfterCounter,
            },
          };
        }


        /*
         * -------------------------------------------------
         * REGISTRATION RESERVADA
         * -------------------------------------------------
         */

        const registrationResult =
          await client.query(
            `
              select *

              from card_registrations

              where id = $1

              for update
            `,
            [
              checkout.registration_id,
            ]
          );


        if (
          registrationResult.rowCount ===
          0
        ) {

          await client.query(
            "ROLLBACK"
          );


          return reply
            .status(409)
            .send({
              error:
                "CHECKOUT_REGISTRATION_NOT_FOUND",
            });
        }


        const registration =
          registrationResult.rows[0];


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
          registration.target_card_type !==
            "CUSTOMER" ||
          normalizeUid(
            registration.target_uid
          ) !==
            normalizedTargetUid ||
          registration.device_id !==
            checkout.device_id ||
          registration.actor_role !==
            checkout.actor_role ||
          Number(
            registration.actor_card_id
          ) !==
            Number(
              checkout.actor_card_id
            )
        ) {

          await client.query(
            "ROLLBACK"
          );


          return reply
            .status(409)
            .send({
              error:
                "REGISTRATION_CHECKOUT_MISMATCH",
            });
        }


        const reservedCardId =
          Number(
            registration
              .reserved_card_id
          );


        if (
          !Number.isSafeInteger(
            reservedCardId
          ) ||
          reservedCardId <= 0 ||
          reservedCardId !==
            cardId
        ) {

          await client.query(
            "ROLLBACK"
          );


          return reply
            .status(409)
            .send({
              error:
                "RESERVED_CARD_ID_MISMATCH",

              expectedCardId:
                reservedCardId,
            });
        }


        const expectedBalance =
          Number(
            checkout
              .credited_amount
          );

        const expectedCounter =
          1;


        if (
          writtenBalance !==
            expectedBalance ||
          writtenCounter !==
            expectedCounter
        ) {

          await client.query(
            "ROLLBACK"
          );


          return reply
            .status(409)
            .send({
              error:
                "CONFIRMATION_STATE_MISMATCH",

              expected: {
                cardId:
                  reservedCardId,

                uid:
                  normalizedTargetUid,

                balance:
                  expectedBalance,

                transactionCounter:
                  expectedCounter,
              },
            });
        }


        /*
         * -------------------------------------------------
         * MATERIALIZAR / REACTIVAR CUSTOMER BASE 0/0
         * -------------------------------------------------
         *
         * NEW crea cards por primera vez.
         * REUSED conserva el mismo card_id y exige que PostgreSQL
         * siga exactamente en el estado devuelto seguro antes de
         * iniciar una nueva activación.
         */

        if (
          checkout.card_path ===
          "NEW"
        ) {

          const existingCardResult =
            await client.query(
              `
                select card_id
                from cards
                where card_id = $1
                   or upper(uid) = upper($2)
                for update
              `,
              [
                reservedCardId,
                normalizedTargetUid,
              ]
            );

          if (
            existingCardResult.rowCount &&
            existingCardResult.rowCount >
              0
          ) {

            await client.query(
              "ROLLBACK"
            );

            return reply
              .status(409)
              .send({
                error:
                  "NEW_CARD_ALREADY_EXISTS",
              });
          }

          await client.query(
            `
              insert into cards (
                  card_id,
                  uid,
                  card_type,
                  status,
                  balance,
                  transaction_counter,
                  current_activation_id,
                  financial_hold,
                  financial_hold_reason,
                  financial_hold_at
              )
              values (
                  $1,
                  $2,
                  'CUSTOMER',
                  'ACTIVE',
                  0,
                  0,
                  null,
                  false,
                  null,
                  null
              )
            `,
            [
              reservedCardId,
              normalizedTargetUid,
            ]
          );

        } else {

          const reusableCardResult =
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
                    last_activation.id as last_activation_id,
                    last_activation.status as last_activation_status,
                    (r.id is not null) as has_return_audit
                from cards c
                left join lateral (
                  select id, status, activation_number
                  from customer_card_activations
                  where card_id = c.card_id
                  order by activation_number desc
                  limit 1
                ) last_activation on true
                left join customer_card_returns r
                  on r.activation_id = last_activation.id
                where c.card_id = $1
                for update of c
              `,
              [
                reservedCardId,
              ]
            );

          if (
            reusableCardResult.rowCount ===
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

          const reusableCard =
            reusableCardResult.rows[0];

          const reusable =
            normalizeUid(
              reusableCard.uid
            ) ===
              normalizedTargetUid &&
            reusableCard.card_type ===
              "CUSTOMER" &&
            reusableCard.status ===
              "INACTIVE" &&
            Number(
              reusableCard.balance
            ) ===
              0 &&
            Number(
              reusableCard.transaction_counter
            ) ===
              0 &&
            reusableCard.current_activation_id ===
              null &&
            reusableCard.last_activation_id !==
              null &&
            reusableCard.last_activation_status ===
              "RETURNED" &&
            Boolean(
              reusableCard.has_return_audit
            ) &&
            reusableCard.financial_hold !==
              true;

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
                  "CARD_NOT_REUSABLE",
              });
          }

          await client.query(
            `
              update cards
              set
                  status = 'ACTIVE',
                  balance = 0,
                  transaction_counter = 0,
                  updated_at = now()
              where card_id = $1
            `,
            [
              reservedCardId,
            ]
          );
        }


        /*
         * -------------------------------------------------
         * NUEVA ACTIVACIÓN
         * -------------------------------------------------
         */

        const activationFee =
          Number(
            checkout
              .activation_fee_amount
          );


        const activationNumberResult =
          await client.query(
            `
              select
                  coalesce(
                    max(activation_number),
                    0
                  ) + 1 as next_activation_number
              from customer_card_activations
              where card_id = $1
            `,
            [
              reservedCardId,
            ]
          );

        const activationNumber =
          Number(
            activationNumberResult.rows[0].next_activation_number
          );

        if (
          !Number.isSafeInteger(
            activationNumber
          ) ||
          activationNumber <=
            0
        ) {

          throw new Error(
            "INVALID_NEXT_ACTIVATION_NUMBER"
          );
        }


        const activationResult =
          await client.query(
            `
              insert into customer_card_activations (
                  card_id,
                  activation_number,
                  activation_fee,
                  activation_fee_known,
                  status,
                  activated_by_role,
                  activated_by_card_id,
                  recharge_point_id,
                  started_at
              )

              values (
                  $1,
                  $2,
                  $3,
                  $4,
                  'ACTIVE',
                  $5,
                  $6,
                  $7,
                  now()
              )

              returning *
            `,
            [
              reservedCardId,
              activationNumber,
              activationFee,
              checkout.actor_role ===
                "RECHARGE",
              checkout.actor_role,
              checkout.actor_card_id,
              checkout.actor_role ===
                "RECHARGE"
                ? checkout.recharge_point_id
                : null,
            ]
          );


        const activation =
          activationResult.rows[0];


        await client.query(
          `
            update cards

            set
                current_activation_id = $2,
                updated_at = now()

            where card_id = $1
          `,
          [
            reservedCardId,
            activation.id,
          ]
        );


        /*
         * -------------------------------------------------
         * CARD_CREATED - SOLO TAQUILLA / RECHARGE
         * -------------------------------------------------
         */

        let activationTransactionId:
          | string
          | null =
            null;


        if (
          checkout.actor_role ===
          "RECHARGE"
        ) {

          const activationTransactionResult =
            await client.query(
              `
                insert into transactions (
                    idempotency_key,
                    card_id,
                    activation_id,
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
                    $4,
                    'CARD_CREATED',
                    $5,
                    0,
                    0,
                    0,
                    0,
                    'CONFIRMED',
                    now(),
                    $6,
                    1,
                    $7,
                    'RECHARGE',
                    $8
                )

                returning id
              `,
              [
                `checkout:${checkout.id}:card-created`,
                reservedCardId,
                activation.id,
                checkout.device_id,
                activationFee,
                activationFee > 0
                  ? activationFee
                  : null,
                checkout.recharge_point_id,
                checkout.actor_card_id,
              ]
            );


          activationTransactionId =
            activationTransactionResult
              .rows[0]
              .id;
        }


        /*
         * -------------------------------------------------
         * RECHARGE CONFIRMED
         * -------------------------------------------------
         *
         * NFC ya fue escrita y verificada. Aquí solamente
         * materializamos en PostgreSQL el estado que ya se
         * confirmó físicamente.
         */

        const creditedAmount =
          Number(
            checkout
              .credited_amount
          );


        const rechargeCreditFundType =
          checkout.actor_role ===
            "RECHARGE"
            ? "CASH"
            : "ADMIN_CREDIT";


        const rechargeTransactionResult =
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
                  recharge_point_id,
                  actor_role,
                  actor_card_id,
                  activation_id,
                  ledger_action,
                  credit_fund_type,
                  promotion_id
              )

              values (
                  $1,
                  $2,
                  $3,
                  'RECHARGE',
                  $4,
                  0,
                  $4,
                  0,
                  1,
                  'CONFIRMED',
                  now(),
                  $5,
                  $6,
                  $7,
                  $8,
                  'CREDIT',
                  $9,
                  $10
              )

              returning *
            `,
            [
              `checkout:${checkout.id}:recharge`,
              reservedCardId,
              checkout.device_id,
              creditedAmount,
              checkout.actor_role ===
                "RECHARGE"
                ? checkout.recharge_point_id
                : null,
              checkout.actor_role,
              checkout.actor_card_id,
              activation.id,
              rechargeCreditFundType,
              checkout.promotion_id,
            ]
          );


        const rechargeTransaction =
          rechargeTransactionResult
            .rows[0];


        /*
         * -------------------------------------------------
         * PROMOTION COMPONENTS
         * -------------------------------------------------
         */

        if (
          checkout.promotion_id !==
          null
        ) {

          const paidRechargeAmount =
            Number(
              checkout
                .paid_recharge_amount
            );

          const promotionalCreditAmount =
            Number(
              checkout
                .promotional_credit_amount
            );


          if (
            !Number.isSafeInteger(
              paidRechargeAmount
            ) ||
            paidRechargeAmount <= 0 ||
            !Number.isSafeInteger(
              promotionalCreditAmount
            ) ||
            promotionalCreditAmount <= 0 ||
            paidRechargeAmount +
              promotionalCreditAmount !==
              creditedAmount
          ) {

            throw new Error(
              "INVALID_CHECKOUT_PROMOTION_AMOUNTS"
            );
          }


          await client.query(
            `
              insert into transaction_credit_components (
                  transaction_id,
                  fund_type,
                  amount,
                  promotion_id
              )

              values (
                  $1,
                  'CASH',
                  $2,
                  $4
              ),
              (
                  $1,
                  'PROMOTIONAL',
                  $3,
                  $4
              )
            `,
            [
              rechargeTransaction.id,
              paidRechargeAmount,
              promotionalCreditAmount,
              checkout.promotion_id,
            ]
          );
        }


        /*
         * -------------------------------------------------
         * LEDGER V2
         * -------------------------------------------------
         */

        await client.query(
          `
            select financial_commit_credit(
                $1
            )
          `,
          [
            rechargeTransaction.id,
          ]
        );


        /*
         * -------------------------------------------------
         * SERVER CARD = NFC FINAL
         * -------------------------------------------------
         */

        await client.query(
          `
            update cards

            set
                balance = $2,
                transaction_counter = $3,
                updated_at = now()

            where card_id = $1
          `,
          [
            reservedCardId,
            writtenBalance,
            writtenCounter,
          ]
        );


        /*
         * -------------------------------------------------
         * CONFIRMAR REGISTRATION
         * -------------------------------------------------
         */

        await client.query(
          `
            update card_registrations

            set
                status = 'CONFIRMED',
                confirmed_at = now(),
                failed_at = null,
                failure_reason = null

            where id = $1
          `,
          [
            registration.id,
          ]
        );


        /*
         * -------------------------------------------------
         * CONFIRMAR CHECKOUT
         * -------------------------------------------------
         */

        const confirmedCheckoutResult =
          await client.query(
            `
              update recharge_checkouts

              set
                  card_id = $2,
                  activation_transaction_id = $3,
                  recharge_transaction_id = $4,
                  status = 'CONFIRMED',
                  failure_reason = null,
                  confirmed_at = now(),
                  failed_at = null,
                  updated_at = now()

              where id = $1

              returning *
            `,
            [
              checkout.id,
              reservedCardId,
              activationTransactionId,
              rechargeTransaction.id,
            ]
          );


        const confirmedCheckout =
          confirmedCheckoutResult
            .rows[0];


        await client.query(
          "COMMIT"
        );


        return {
          confirmed:
            true,

          duplicated:
            false,

          checkout:
            mapCheckoutRow(
              confirmedCheckout
            ),

          activation: {
            activationId:
              activation.id,

            activationNumber:
              Number(
                activation
                  .activation_number
              ),

            activationFee:
              Number(
                activation
                  .activation_fee
              ),

            activationFeeKnown:
              Boolean(
                activation
                  .activation_fee_known
              ),
          },

          transactions: {
            cardCreatedTransactionId:
              activationTransactionId,

            rechargeTransactionId:
              rechargeTransaction.id,
          },

          card: {
            cardId:
              reservedCardId,

            uid:
              normalizedTargetUid,

            cardType:
              "CUSTOMER",

            status:
              "ACTIVE",

            balance:
              writtenBalance,

            transactionCounter:
              writtenCounter,
          },
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


        if (
          error?.code ===
          "22P02"
        ) {

          return reply
            .status(400)
            .send({
              error:
                "INVALID_CHECKOUT_ID",
            });
        }


        if (
          error?.code ===
          "23505"
        ) {

          return reply
            .status(409)
            .send({
              error:
                "CHECKOUT_CONFIRMATION_CONFLICT",

              constraint:
                error
                  ?.constraint ??
                null,
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
