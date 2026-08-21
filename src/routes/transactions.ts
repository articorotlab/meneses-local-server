import type { FastifyInstance } from "fastify";
import { db } from "../db/database.js";

/*
 * =========================================================
 * TYPES
 * =========================================================
 */

type RechargeBody = {
  idempotencyKey: string;
  cardId: number;
  uid: string;
  amount: number;
  cardBalance: number;
  cardCounter: number;
  deviceCode: string;
};


type AdminBalanceChangeBody = {
  idempotencyKey: string;
  cardId: number;
  uid: string;
  amount: number;
  cardBalance: number;
  cardCounter: number;
  deviceCode: string;
};

type AdminCashTodayQuery = {
  deviceCode: string;
};

type ChargeBody = {
  idempotencyKey: string;
  cardId: number;
  uid: string;
  peopleCount: number;
  cardBalance: number;
  cardCounter: number;
  deviceCode: string;
};

type ConfirmBody = {
  transactionId: string;
  cardId: number;
  uid: string;
  writtenBalance: number;
  writtenCounter: number;
};

type FailBody = {
  transactionId: string;
  reason: string;
};

type ReconcileBody = {
  cardId: number;
  uid: string;
  cardBalance: number;
  cardCounter: number;
};

export async function transactionRoutes(
  server: FastifyInstance
) {

  /*
   * =====================================================
   * HELPER: ACTIVE ADMIN SESSION
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
            d.device_type,

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

    if (result.rowCount === 0) {
      return null;
    }

    return result.rows[0];
  }

  /*
   * =====================================================
   * ADMIN RECHARGE AUTHORIZE
   * =====================================================
   *
   * Recarga realizada directamente por ADMIN.
   * No pertenece a ninguna taquilla.
   */

  server.post<{
    Body: AdminBalanceChangeBody;
  }>(
    "/transactions/admin/recharge/authorize",

    async (request, reply) => {

      const {
        idempotencyKey,
        cardId,
        uid,
        amount,
        cardBalance,
        cardCounter,
        deviceCode,
      } = request.body;

      if (
        typeof idempotencyKey !== "string" ||
        idempotencyKey.trim().length === 0
      ) {
        return reply.status(400).send({
          error: "INVALID_IDEMPOTENCY_KEY",
        });
      }

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
        !Number.isSafeInteger(amount) ||
        amount <= 0
      ) {
        return reply.status(400).send({
          error: "INVALID_AMOUNT",
        });
      }

      if (
        !Number.isSafeInteger(cardBalance) ||
        cardBalance < 0 ||
        !Number.isSafeInteger(cardCounter) ||
        cardCounter < 0
      ) {
        return reply.status(400).send({
          error: "INVALID_CARD_STATE",
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

        const previousResult =
          await client.query(
            `
            select *
            from transactions
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

          const tx =
            previousResult.rows[0];

          await client.query("COMMIT");

          return {
            authorized:
              tx.card_write_status !== "FAILED" &&
              tx.card_write_status !== "REVERSAL_REQUIRED",
            duplicated: true,
            transactionId: tx.id,
            status: tx.card_write_status,
            cardId: Number(tx.card_id),
            amount: Number(tx.amount),
            balanceBefore: Number(tx.balance_before),
            balanceAfter: Number(tx.balance_after),
            counterBefore: Number(tx.counter_before),
            counterAfter: Number(tx.counter_after),
            actor: {
              role: tx.actor_role,
              cardId:
                tx.actor_card_id !== null
                  ? Number(tx.actor_card_id)
                  : null,
            },
          };
        }

        const admin =
          await getAdminActor(
            client,
            deviceCode
          );

        if (admin === null) {
          await client.query("ROLLBACK");
          return reply.status(403).send({
            error: "ADMIN_PERMISSION_REQUIRED",
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
                status,
                balance,
                transaction_counter,
                current_activation_id
            from cards
            where card_id = $1
            for update
            `,
            [
              cardId,
            ]
          );

        if (cardResult.rowCount === 0) {
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

        if (card.card_type !== "CUSTOMER") {
          await client.query("ROLLBACK");
          return reply.status(409).send({
            error: "INVALID_CARD_TYPE",
          });
        }

        if (card.status !== "ACTIVE") {
          await client.query("ROLLBACK");
          return reply.status(409).send({
            error: "CARD_NOT_ACTIVE",
          });
        }

        if (
          card.current_activation_id ===
          null
        ) {
          await client.query("ROLLBACK");

          return reply.status(409).send({
            error:
              "CUSTOMER_ACTIVATION_REQUIRED",
          });
        }

        const serverBalance =
          Number(card.balance);

        const serverCounter =
          Number(card.transaction_counter);

        if (
          serverBalance !== cardBalance ||
          serverCounter !== cardCounter
        ) {
          await client.query("ROLLBACK");
          return reply.status(409).send({
            error: "CARD_STATE_MISMATCH",
            serverState: {
              balance: serverBalance,
              transactionCounter: serverCounter,
            },
            cardState: {
              balance: cardBalance,
              transactionCounter: cardCounter,
            },
          });
        }

        const balanceAfter =
          serverBalance + amount;

        const counterAfter =
          serverCounter + 1;

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
                actor_role,
                actor_card_id,
                activation_id,
                ledger_action,
                credit_fund_type
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
                'ADMIN',
                $9,
                $10,
                'CREDIT',
                'ADMIN_CREDIT'
            )
            returning *
            `,
            [
              idempotencyKey,
              cardId,
              admin.device_id,
              amount,
              serverBalance,
              balanceAfter,
              serverCounter,
              counterAfter,
              admin.admin_card_id,
              card.current_activation_id,
            ]
          );

        await client.query("COMMIT");

        const transaction =
          transactionResult.rows[0];

        return {
          authorized: true,
          duplicated: false,
          transactionId: transaction.id,
          status: transaction.card_write_status,
          cardId,
          amount,
          balanceBefore: serverBalance,
          balanceAfter,
          counterBefore: serverCounter,
          counterAfter,
          actor: {
            role: "ADMIN",
            cardId:
              Number(admin.admin_card_id),
          },
        };

      } catch (error: any) {

        await client.query("ROLLBACK");

        if (error?.code === "23505") {
          return reply.status(409).send({
            error:
              "CARD_HAS_PENDING_TRANSACTION",
          });
        }

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
   * ADMIN ADJUSTMENT AUTHORIZE
   * =====================================================
   *
   * Quita saldo de una CUSTOMER sin registrarlo como
   * consumo de un juego.
   */

  server.post<{
    Body: AdminBalanceChangeBody;
  }>(
    "/transactions/admin/adjustment/authorize",

    async (request, reply) => {

      const {
        idempotencyKey,
        cardId,
        uid,
        amount,
        cardBalance,
        cardCounter,
        deviceCode,
      } = request.body;

      if (
        typeof idempotencyKey !== "string" ||
        idempotencyKey.trim().length === 0
      ) {
        return reply.status(400).send({
          error: "INVALID_IDEMPOTENCY_KEY",
        });
      }

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
        !Number.isSafeInteger(amount) ||
        amount <= 0
      ) {
        return reply.status(400).send({
          error: "INVALID_AMOUNT",
        });
      }

      if (
        !Number.isSafeInteger(cardBalance) ||
        cardBalance < 0 ||
        !Number.isSafeInteger(cardCounter) ||
        cardCounter < 0
      ) {
        return reply.status(400).send({
          error: "INVALID_CARD_STATE",
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

        const previousResult =
          await client.query(
            `
            select *
            from transactions
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

          const tx =
            previousResult.rows[0];

          await client.query("COMMIT");

          return {
            authorized:
              tx.card_write_status !== "FAILED" &&
              tx.card_write_status !== "REVERSAL_REQUIRED",
            duplicated: true,
            transactionId: tx.id,
            status: tx.card_write_status,
            cardId: Number(tx.card_id),
            amount: Number(tx.amount),
            balanceBefore: Number(tx.balance_before),
            balanceAfter: Number(tx.balance_after),
            counterBefore: Number(tx.counter_before),
            counterAfter: Number(tx.counter_after),
            actor: {
              role: tx.actor_role,
              cardId:
                tx.actor_card_id !== null
                  ? Number(tx.actor_card_id)
                  : null,
            },
          };
        }

        const admin =
          await getAdminActor(
            client,
            deviceCode
          );

        if (admin === null) {
          await client.query("ROLLBACK");
          return reply.status(403).send({
            error: "ADMIN_PERMISSION_REQUIRED",
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
                status,
                balance,
                transaction_counter
            from cards
            where card_id = $1
            for update
            `,
            [
              cardId,
            ]
          );

        if (cardResult.rowCount === 0) {
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

        if (card.card_type !== "CUSTOMER") {
          await client.query("ROLLBACK");
          return reply.status(409).send({
            error: "INVALID_CARD_TYPE",
          });
        }

        if (card.status !== "ACTIVE") {
          await client.query("ROLLBACK");
          return reply.status(409).send({
            error: "CARD_NOT_ACTIVE",
          });
        }

        const serverBalance =
          Number(card.balance);

        const serverCounter =
          Number(card.transaction_counter);

        if (
          serverBalance !== cardBalance ||
          serverCounter !== cardCounter
        ) {
          await client.query("ROLLBACK");
          return reply.status(409).send({
            error: "CARD_STATE_MISMATCH",
            serverState: {
              balance: serverBalance,
              transactionCounter: serverCounter,
            },
            cardState: {
              balance: cardBalance,
              transactionCounter: cardCounter,
            },
          });
        }

        if (serverBalance < amount) {
          await client.query("ROLLBACK");
          return reply.status(409).send({
            error: "INSUFFICIENT_BALANCE",
            availableBalance: serverBalance,
            requiredAmount: amount,
            missingAmount:
              amount - serverBalance,
          });
        }

        const balanceAfter =
          serverBalance - amount;

        const counterAfter =
          serverCounter + 1;

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
                actor_role,
                actor_card_id
            )
            values (
                $1,
                $2,
                $3,
                'ADJUSTMENT',
                $4,
                $5,
                $6,
                $7,
                $8,
                'AUTHORIZED',
                'ADMIN',
                $9
            )
            returning *
            `,
            [
              idempotencyKey,
              cardId,
              admin.device_id,
              amount,
              serverBalance,
              balanceAfter,
              serverCounter,
              counterAfter,
              admin.admin_card_id,
            ]
          );

        await client.query("COMMIT");

        const transaction =
          transactionResult.rows[0];

        return {
          authorized: true,
          duplicated: false,
          transactionId: transaction.id,
          status: transaction.card_write_status,
          cardId,
          amount,
          balanceBefore: serverBalance,
          balanceAfter,
          counterBefore: serverCounter,
          counterAfter,
          actor: {
            role: "ADMIN",
            cardId:
              Number(admin.admin_card_id),
          },
        };

      } catch (error: any) {

        await client.query("ROLLBACK");

        if (error?.code === "23505") {
          return reply.status(409).send({
            error:
              "CARD_HAS_PENDING_TRANSACTION",
          });
        }

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
   * ADMIN CASH TODAY
   * =====================================================
   *
   * Caja = recargas CONFIRMED del día local de Córdoba.
   * CHARGE y ADJUSTMENT no modifican este total.
   */

  server.get<{
    Querystring: AdminCashTodayQuery;
  }>(
    "/transactions/admin/cash-today",

    async (request, reply) => {

      const {
        deviceCode,
      } = request.query;

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

        const admin =
          await getAdminActor(
            client,
            deviceCode
          );

        if (admin === null) {
          await client.query("ROLLBACK");
          return reply.status(403).send({
            error: "ADMIN_PERMISSION_REQUIRED",
            message:
              "Se necesita una sesión ADMIN activa.",
          });
        }

        const result =
          await client.query(
            `
            select
                coalesce(sum(amount), 0) as total,
                count(*) as operations,

                coalesce(
                  sum(amount) filter (
                    where actor_role = 'ADMIN'
                  ),
                  0
                ) as admin_total,

                coalesce(
                  sum(amount) filter (
                    where recharge_point_id is not null
                  ),
                  0
                ) as recharge_points_total

            from transactions

            where transaction_type = 'RECHARGE'
              and card_write_status = 'CONFIRMED'
              and confirmed_at is not null
              and (
                confirmed_at at time zone
                  'America/Mexico_City'
              )::date = (
                now() at time zone
                  'America/Mexico_City'
              )::date
            `
          );

        const row =
          result.rows[0];

        const localDateResult =
          await client.query(
            `
            select
              (
                now() at time zone
                  'America/Mexico_City'
              )::date::text as local_date
            `
          );

        await client.query("COMMIT");

        return {
          date:
            localDateResult.rows[0]
              .local_date,
          timezone:
            "America/Mexico_City",
          total:
            Number(row.total),
          operations:
            Number(row.operations),
          breakdown: {
            admin:
              Number(row.admin_total),
            rechargePoints:
              Number(
                row.recharge_points_total
              ),
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
   * RECONCILE
   * =====================================================
   */

  server.post<{
    Body: ReconcileBody;
  }>(
    "/transactions/reconcile",

    async (request, reply) => {

      const {
        cardId,
        uid,
        cardBalance,
        cardCounter,
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
        !Number.isSafeInteger(cardBalance) ||
        cardBalance < 0 ||
        !Number.isSafeInteger(cardCounter) ||
        cardCounter < 0
      ) {
        return reply.status(400).send({
          error: "INVALID_CARD_STATE",
        });
      }

      const client =
        await db.connect();

      try {

        await client.query("BEGIN");

        const cardResult =
          await client.query(
            `
            select
                card_id,
                uid,
                balance,
                transaction_counter
            from cards
            where card_id = $1
            for update
            `,
            [
              cardId,
            ]
          );

        if (cardResult.rowCount === 0) {

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

        const serverBalance =
          Number(card.balance);

        const serverCounter =
          Number(
            card.transaction_counter
          );

        const openResult =
          await client.query(
            `
            select *
            from transactions
            where card_id = $1
              and card_write_status in (
                'PENDING',
                'AUTHORIZED',
                'CARD_WRITTEN'
              )
            order by created_at desc
            limit 1
            for update
            `,
            [
              cardId,
            ]
          );

        if (
          openResult.rowCount === 0
        ) {

          if (
            serverBalance === cardBalance &&
            serverCounter === cardCounter
          ) {

            await client.query("COMMIT");

            return {
              reconciled: true,

              action: "NONE",

              cardId,

              balance:
                serverBalance,

              transactionCounter:
                serverCounter,
            };
          }

          await client.query("COMMIT");

          return reply.status(409).send({
            error:
              "UNEXPLAINED_CARD_STATE",

            serverState: {
              balance:
                serverBalance,

              transactionCounter:
                serverCounter,
            },

            cardState: {
              balance:
                cardBalance,

              transactionCounter:
                cardCounter,
            },
          });
        }

        const transaction =
          openResult.rows[0];

        const balanceBefore =
          Number(
            transaction.balance_before
          );

        const balanceAfter =
          Number(
            transaction.balance_after
          );

        const counterBefore =
          Number(
            transaction.counter_before
          );

        const counterAfter =
          Number(
            transaction.counter_after
          );

        /*
         * NFC escribió AFTER.
         */

        if (
          cardBalance === balanceAfter &&
          cardCounter === counterAfter &&
          serverBalance === balanceBefore &&
          serverCounter === counterBefore
        ) {

          await client.query(
            `
            update cards
            set
                balance = $1,
                transaction_counter = $2,
                updated_at = now()
            where card_id = $3
            `,
            [
              balanceAfter,
              counterAfter,
              cardId,
            ]
          );

          await client.query(
            `
            select financial_commit_credit(
                $1
            )
            `,
            [
              transaction.id,
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
              transaction.id,
            ]
          );

          await client.query("COMMIT");

          return {
            reconciled: true,

            action:
              "CONFIRMED_PENDING_TRANSACTION",

            transactionId:
              transaction.id,

            cardId,

            balance:
              balanceAfter,

            transactionCounter:
              counterAfter,
          };
        }

        /*
         * NFC permaneció BEFORE.
         */

        if (
          cardBalance === balanceBefore &&
          cardCounter === counterBefore &&
          serverBalance === balanceBefore &&
          serverCounter === counterBefore
        ) {

          await client.query(
            `
            update transactions
            set
                card_write_status = 'FAILED',
                failed_at = now(),
                failure_reason =
                  'Reconciliación: la tarjeta permaneció en el estado anterior.'
            where id = $1
            `,
            [
              transaction.id,
            ]
          );

          await client.query("COMMIT");

          return {
            reconciled: true,

            action:
              "FAILED_PENDING_TRANSACTION",

            transactionId:
              transaction.id,

            cardId,

            balance:
              balanceBefore,

            transactionCounter:
              counterBefore,
          };
        }

        /*
         * Estado desconocido.
         */

        await client.query(
          `
          update transactions
          set
              card_write_status =
                'REVERSAL_REQUIRED',

              failure_reason =
                'Reconciliación: estado físico inesperado.'
          where id = $1
          `,
          [
            transaction.id,
          ]
        );

        await client.query("COMMIT");

        return reply.status(409).send({
          error:
            "MANUAL_REVIEW_REQUIRED",

          transactionId:
            transaction.id,

          serverState: {
            balance:
              serverBalance,

            transactionCounter:
              serverCounter,
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
            balance:
              cardBalance,

            transactionCounter:
              cardCounter,
          },
        });

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
   * RECHARGE AUTHORIZE
   * =====================================================
   */

  server.post<{
    Body: RechargeBody;
  }>(
    "/transactions/recharge/authorize",

    async (request, reply) => {

      const {
        idempotencyKey,
        cardId,
        uid,
        amount,
        cardBalance,
        cardCounter,
        deviceCode,
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
        !Number.isSafeInteger(cardId) ||
        cardId <= 0
      ) {

        return reply.status(400).send({
          error:
            "INVALID_CARD_ID",
        });
      }

      if (
        !Number.isSafeInteger(amount) ||
        amount <= 0
      ) {

        return reply.status(400).send({
          error:
            "INVALID_AMOUNT",
        });
      }

      if (
        !Number.isSafeInteger(cardBalance) ||
        cardBalance < 0 ||
        !Number.isSafeInteger(cardCounter) ||
        cardCounter < 0
      ) {

        return reply.status(400).send({
          error:
            "INVALID_CARD_STATE",
        });
      }

      const client =
        await db.connect();

      try {

        await client.query("BEGIN");

        /*
         * Idempotencia.
         */

        const previousResult =
          await client.query(
            `
            select *
            from transactions
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

          const tx =
            previousResult.rows[0];

          await client.query("COMMIT");

          return {
            authorized:
              tx.card_write_status !==
                "FAILED" &&
              tx.card_write_status !==
                "REVERSAL_REQUIRED",

            duplicated:
              true,

            transactionId:
              tx.id,

            status:
              tx.card_write_status,

            cardId:
              Number(tx.card_id),

            amount:
              Number(tx.amount),

            balanceBefore:
              Number(
                tx.balance_before
              ),

            balanceAfter:
              Number(
                tx.balance_after
              ),

            counterBefore:
              Number(
                tx.counter_before
              ),

            counterAfter:
              Number(
                tx.counter_after
              ),
          };
        }

        /*
         * Tarjeta CUSTOMER.
         */

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
                current_activation_id
            from cards
            where card_id = $1
            for update
            `,
            [
              cardId,
            ]
          );

        if (cardResult.rowCount === 0) {

          await client.query("ROLLBACK");

          return reply.status(404).send({
            error:
              "CARD_NOT_FOUND",
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
            error:
              "UID_MISMATCH",
          });
        }

        if (
          card.card_type !==
          "CUSTOMER"
        ) {

          await client.query("ROLLBACK");

          return reply.status(409).send({
            error:
              "INVALID_CARD_TYPE",
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

        if (
          card.current_activation_id ===
          null
        ) {

          await client.query("ROLLBACK");

          return reply.status(409).send({
            error:
              "CUSTOMER_ACTIVATION_REQUIRED",
          });
        }

        const serverBalance =
          Number(card.balance);

        const serverCounter =
          Number(
            card.transaction_counter
          );

        if (
          serverBalance !== cardBalance ||
          serverCounter !== cardCounter
        ) {

          await client.query("ROLLBACK");

          return reply.status(409).send({
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
                cardBalance,

              transactionCounter:
                cardCounter,
            },
          });
        }

        /*
         * Dispositivo.
         */

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
              deviceCode,
            ]
          );

        if (deviceResult.rowCount === 0) {

          await client.query("ROLLBACK");

          return reply.status(404).send({
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

          await client.query("ROLLBACK");

          return reply.status(409).send({
            error:
              "DEVICE_NOT_ACTIVE",
          });
        }

        if (
          device.device_type !==
          "RECHARGE"
        ) {

          await client.query("ROLLBACK");

          return reply.status(409).send({
            error:
              "DEVICE_NOT_RECHARGE",
          });
        }

        /*
         * Sesión RECHARGE activa.
         */

        const sessionResult =
          await client.query(
            `
            select
                s.id as session_id,
                s.recharge_point_id,
                s.opened_by_card_id,

                rp.recharge_code,
                rp.name,
                rp.status as recharge_point_status

            from device_recharge_sessions s

            join recharge_points rp
                on rp.id = s.recharge_point_id

            where s.device_id = $1
              and s.status = 'ACTIVE'
              and s.ended_at is null

            limit 1

            for update of s
            `,
            [
              device.id,
            ]
          );

        if (
          sessionResult.rowCount === 0
        ) {

          await client.query("ROLLBACK");

          return reply.status(409).send({
            error:
              "NO_ACTIVE_RECHARGE_SESSION",
          });
        }

        const rechargeSession =
          sessionResult.rows[0];

        if (
          rechargeSession
            .recharge_point_status !==
          "ACTIVE"
        ) {

          await client.query("ROLLBACK");

          return reply.status(409).send({
            error:
              "RECHARGE_POINT_NOT_ACTIVE",
          });
        }

        const balanceAfter =
          serverBalance +
          amount;

        const counterAfter =
          serverCounter +
          1;

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
                credit_fund_type
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
                'RECHARGE',
                $10,
                $11,
                'CREDIT',
                'CASH'
            )
            returning *
            `,
            [
              idempotencyKey,
              cardId,
              device.id,
              amount,
              serverBalance,
              balanceAfter,
              serverCounter,
              counterAfter,
              rechargeSession
                .recharge_point_id,
              rechargeSession
                .opened_by_card_id,
              card
                .current_activation_id,
            ]
          );

        await client.query("COMMIT");

        const transaction =
          transactionResult.rows[0];

        return {
          authorized:
            true,

          duplicated:
            false,

          transactionId:
            transaction.id,

          status:
            transaction.card_write_status,

          cardId,

          rechargePoint: {
            code:
              rechargeSession
                .recharge_code,

            name:
              rechargeSession.name,
          },

          amount,

          balanceBefore:
            serverBalance,

          balanceAfter,

          counterBefore:
            serverCounter,

          counterAfter,
        };

      } catch (error: any) {

        await client.query("ROLLBACK");

        if (
          error?.code ===
          "23505"
        ) {

          return reply.status(409).send({
            error:
              "CARD_HAS_PENDING_TRANSACTION",
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
   * CHARGE AUTHORIZE
   * =====================================================
   */

  server.post<{
    Body: ChargeBody;
  }>(
    "/transactions/charge/authorize",

    async (request, reply) => {

      const {
        idempotencyKey,
        cardId,
        uid,
        peopleCount,
        cardBalance,
        cardCounter,
        deviceCode,
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
        !Number.isSafeInteger(cardId) ||
        cardId <= 0
      ) {

        return reply.status(400).send({
          error:
            "INVALID_CARD_ID",
        });
      }

      if (
        !Number.isSafeInteger(
          peopleCount
        ) ||
        peopleCount <= 0 ||
        peopleCount > 100
      ) {

        return reply.status(400).send({
          error:
            "INVALID_PEOPLE_COUNT",
        });
      }

      const client =
        await db.connect();

      try {

        await client.query("BEGIN");

        const previousResult =
          await client.query(
            `
            select
                t.*,
                g.game_code,
                g.name as game_name
            from transactions t

            left join games g
                on g.id = t.game_id

            where t.idempotency_key = $1

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

          const tx =
            previousResult.rows[0];

          await client.query("COMMIT");

          return {
            authorized:
              tx.card_write_status !==
                "FAILED" &&
              tx.card_write_status !==
                "REVERSAL_REQUIRED",

            duplicated:
              true,

            transactionId:
              tx.id,

            status:
              tx.card_write_status,

            cardId:
              Number(tx.card_id),

            game: {
              code:
                tx.game_code,

              name:
                tx.game_name,

              unitPrice:
                Number(
                  tx.unit_price
                ),
            },

            peopleCount:
              Number(
                tx.quantity
              ),

            total:
              Number(
                tx.amount
              ),

            balanceBefore:
              Number(
                tx.balance_before
              ),

            balanceAfter:
              Number(
                tx.balance_after
              ),

            counterBefore:
              Number(
                tx.counter_before
              ),

            counterAfter:
              Number(
                tx.counter_after
              ),
          };
        }

        /*
         * CUSTOMER.
         */

        const cardResult =
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
            for update
            `,
            [
              cardId,
            ]
          );

        if (cardResult.rowCount === 0) {

          await client.query("ROLLBACK");

          return reply.status(404).send({
            error:
              "CARD_NOT_FOUND",
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
            error:
              "UID_MISMATCH",
          });
        }

        if (
          card.card_type !==
          "CUSTOMER"
        ) {

          await client.query("ROLLBACK");

          return reply.status(409).send({
            error:
              "INVALID_CARD_TYPE",
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

        const serverBalance =
          Number(card.balance);

        const serverCounter =
          Number(
            card.transaction_counter
          );

        if (
          serverBalance !==
            cardBalance ||
          serverCounter !==
            cardCounter
        ) {

          await client.query("ROLLBACK");

          return reply.status(409).send({
            error:
              "CARD_STATE_MISMATCH",
          });
        }

        /*
         * Dispositivo.
         */

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
              deviceCode,
            ]
          );

        if (deviceResult.rowCount === 0) {

          await client.query("ROLLBACK");

          return reply.status(404).send({
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

          await client.query("ROLLBACK");

          return reply.status(409).send({
            error:
              "DEVICE_NOT_ACTIVE",
          });
        }

        if (
          device.device_type !==
          "GAME"
        ) {

          await client.query("ROLLBACK");

          return reply.status(409).send({
            error:
              "DEVICE_NOT_GAME",
          });
        }

        /*
         * GAME session.
         */

        const sessionResult =
          await client.query(
            `
            select
                s.opened_by_card_id,
                g.id as game_id,
                g.game_code,
                g.name as game_name,
                g.price,
                g.status as game_status

            from device_game_sessions s

            join games g
                on g.id = s.game_id

            where s.device_id = $1
              and s.status = 'ACTIVE'
              and s.ended_at is null

            limit 1

            for update of s
            `,
            [
              device.id,
            ]
          );

        if (
          sessionResult.rowCount === 0
        ) {

          await client.query("ROLLBACK");

          return reply.status(409).send({
            error:
              "NO_ACTIVE_GAME_SESSION",
          });
        }

        const game =
          sessionResult.rows[0];

        if (
          game.game_status !==
          "ACTIVE"
        ) {

          await client.query("ROLLBACK");

          return reply.status(409).send({
            error:
              "GAME_NOT_ACTIVE",
          });
        }

        const unitPrice =
          Number(game.price);

        const total =
          unitPrice *
          peopleCount;

        if (
          serverBalance <
          total
        ) {

          await client.query("ROLLBACK");

          return reply.status(409).send({
            error:
              "INSUFFICIENT_BALANCE",

            availableBalance:
              serverBalance,

            requiredAmount:
              total,

            missingAmount:
              total -
              serverBalance,
          });
        }

        const balanceAfter =
          serverBalance -
          total;

        const counterAfter =
          serverCounter +
          1;

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
                game_id,
                unit_price,
                quantity,
                actor_role,
                actor_card_id
            )
            values (
                $1,
                $2,
                $3,
                'CHARGE',
                $4,
                $5,
                $6,
                $7,
                $8,
                'AUTHORIZED',
                $9,
                $10,
                $11,
                'GAME',
                $12
            )
            returning *
            `,
            [
              idempotencyKey,
              cardId,
              device.id,
              total,
              serverBalance,
              balanceAfter,
              serverCounter,
              counterAfter,
              game.game_id,
              unitPrice,
              peopleCount,
              game.opened_by_card_id,
            ]
          );

        await client.query("COMMIT");

        const transaction =
          transactionResult.rows[0];

        return {
          authorized:
            true,

          duplicated:
            false,

          transactionId:
            transaction.id,

          status:
            transaction
              .card_write_status,

          cardId,

          game: {
            code:
              game.game_code,

            name:
              game.game_name,

            unitPrice,
          },

          peopleCount,

          total,

          balanceBefore:
            serverBalance,

          balanceAfter,

          counterBefore:
            serverCounter,

          counterAfter,
        };

      } catch (error: any) {

        await client.query("ROLLBACK");

        if (
          error?.code ===
          "23505"
        ) {

          return reply.status(409).send({
            error:
              "CARD_HAS_PENDING_TRANSACTION",
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
   * CONFIRM
   * =====================================================
   */

  server.post<{
    Body: ConfirmBody;
  }>(
    "/transactions/confirm",

    async (request, reply) => {

      const {
        transactionId,
        cardId,
        uid,
        writtenBalance,
        writtenCounter,
      } = request.body;

      const client =
        await db.connect();

      try {

        await client.query("BEGIN");

        const txResult =
          await client.query(
            `
            select *
            from transactions
            where id = $1
            for update
            `,
            [
              transactionId,
            ]
          );

        if (txResult.rowCount === 0) {

          await client.query("ROLLBACK");

          return reply.status(404).send({
            error:
              "TRANSACTION_NOT_FOUND",
          });
        }

        const tx =
          txResult.rows[0];

        if (
          tx.card_write_status ===
          "CONFIRMED"
        ) {

          await client.query("COMMIT");

          return {
            confirmed:
              true,

            duplicated:
              true,

            transactionId,
          };
        }

        if (
          tx.card_write_status !==
          "AUTHORIZED"
        ) {

          await client.query("ROLLBACK");

          return reply.status(409).send({
            error:
              "TRANSACTION_NOT_AUTHORIZED",

            status:
              tx.card_write_status,
          });
        }

        if (
          Number(tx.card_id) !==
            cardId ||
          Number(tx.balance_after) !==
            writtenBalance ||
          Number(tx.counter_after) !==
            writtenCounter
        ) {

          await client.query("ROLLBACK");

          return reply.status(409).send({
            error:
              "CONFIRMATION_STATE_MISMATCH",
          });
        }

        const cardResult =
          await client.query(
            `
            select *
            from cards
            where card_id = $1
            for update
            `,
            [
              cardId,
            ]
          );

        if (cardResult.rowCount === 0) {

          await client.query("ROLLBACK");

          return reply.status(404).send({
            error:
              "CARD_NOT_FOUND",
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
            error:
              "UID_MISMATCH",
          });
        }

        if (
          Number(card.balance) !==
            Number(
              tx.balance_before
            ) ||
          Number(
            card.transaction_counter
          ) !==
            Number(
              tx.counter_before
            )
        ) {

          await client.query("ROLLBACK");

          return reply.status(409).send({
            error:
              "SERVER_STATE_CHANGED",
          });
        }

        await client.query(
          `
          update cards
          set
              balance = $1,
              transaction_counter = $2,
              updated_at = now()
          where card_id = $3
          `,
          [
            writtenBalance,
            writtenCounter,
            cardId,
          ]
        );

        await client.query(
          `
          select financial_commit_credit(
              $1
          )
          `,
          [
            transactionId,
          ]
        );

        await client.query(
          `
          update transactions
          set
              card_write_status =
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
            transactionId,
          ]
        );

        await client.query("COMMIT");

        return {
          confirmed:
            true,

          duplicated:
            false,

          transactionId,

          cardId,

          balance:
            writtenBalance,

          transactionCounter:
            writtenCounter,
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
   * FAIL
   * =====================================================
   */

  server.post<{
    Body: FailBody;
  }>(
    "/transactions/fail",

    async (request, reply) => {

      const {
        transactionId,
        reason,
      } = request.body;

      const result =
        await db.query(
          `
          update transactions
          set
              card_write_status =
                'FAILED',

              failed_at =
                now(),

              failure_reason =
                $2

          where id = $1
            and card_write_status =
              'AUTHORIZED'

          returning id
          `,
          [
            transactionId,
            reason,
          ]
        );

      if (result.rowCount === 0) {

        return reply.status(409).send({
          error:
            "TRANSACTION_CANNOT_BE_FAILED",
        });
      }

      return {
        failed:
          true,

        transactionId,
      };
    }
  );

  /*
   * =====================================================
   * GET TRANSACTION
   * =====================================================
   */

  server.get<{
    Params: {
      transactionId: string;
    };
  }>(
    "/transactions/:transactionId",

    async (request, reply) => {

      const result =
        await db.query(
          `
          select
              t.*,

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
              on rp.id =
                 t.recharge_point_id

          where t.id = $1

          limit 1
          `,
          [
            request.params
              .transactionId,
          ]
        );

      if (result.rowCount === 0) {

        return reply.status(404).send({
          error:
            "TRANSACTION_NOT_FOUND",
        });
      }

      const tx =
        result.rows[0];

      return {
        transactionId:
          tx.id,

        idempotencyKey:
          tx.idempotency_key,

        cardId:
          Number(tx.card_id),

        type:
          tx.transaction_type,

        amount:
          Number(tx.amount),

        balanceBefore:
          Number(
            tx.balance_before
          ),

        balanceAfter:
          Number(
            tx.balance_after
          ),

        counterBefore:
          Number(
            tx.counter_before
          ),

        counterAfter:
          Number(
            tx.counter_after
          ),

        status:
          tx.card_write_status,

        deviceCode:
          tx.device_code,

        game:
          tx.game_id !== null
            ? {
                code:
                  tx.game_code,

                name:
                  tx.game_name,

                unitPrice:
                  Number(
                    tx.unit_price
                  ),

                quantity:
                  Number(
                    tx.quantity
                  ),
              }
            : null,

        rechargePoint:
          tx.recharge_point_id !==
          null
            ? {
                code:
                  tx.recharge_code,

                name:
                  tx.recharge_point_name,
              }
            : null,

        createdAt:
          tx.created_at,

        confirmedAt:
          tx.confirmed_at,

        failedAt:
          tx.failed_at,

        failureReason:
          tx.failure_reason,
      };
    }
  );
}