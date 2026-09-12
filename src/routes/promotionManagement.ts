import type { FastifyInstance } from "fastify";
import { db } from "../db/database.js";
import { verifyDeviceSecret } from "../auth/deviceCredential.js";

type CreatePromotionBody = {
  deviceCode: string;
  name: string;
  cashAmount: number;
  promotionalAmount: number;
};

type PromotionStatusBody = {
  deviceCode: string;
  active: boolean;
};

type ActivePromotionsHeaders = {
  "x-device-code"?: string;
  "x-device-token"?: string;
};

export async function promotionManagementRoutes(
  server: FastifyInstance
) {
  async function getAdminActor(
    client: any,
    deviceCode: string
  ) {
    const result = await client.query(
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
      [deviceCode.trim()]
    );

    if (result.rowCount === 0) {
      return null;
    }

    return result.rows[0];
  }

  server.post<{
    Body: CreatePromotionBody;
  }>(
    "/admin/promotions",
    async (request, reply) => {
      const {
        deviceCode,
        name,
        cashAmount,
        promotionalAmount,
      } = request.body;

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
          error: "INVALID_PROMOTION_NAME",
          message:
            "El nombre de la promoción debe tener al menos 2 caracteres.",
        });
      }

      if (
        !Number.isSafeInteger(cashAmount) ||
        cashAmount <= 0
      ) {
        return reply.status(400).send({
          error: "INVALID_CASH_AMOUNT",
          message:
            "cashAmount debe ser un entero positivo.",
        });
      }

      if (
        !Number.isSafeInteger(promotionalAmount) ||
        promotionalAmount < 0
      ) {
        return reply.status(400).send({
          error: "INVALID_PROMOTIONAL_AMOUNT",
          message:
            "promotionalAmount debe ser un entero igual o mayor a cero.",
        });
      }

      const client = await db.connect();

      try {
        await client.query("BEGIN");

        const admin = await getAdminActor(
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

        const result = await client.query(
          `
          insert into promotions (
              name,
              cash_amount,
              promotional_amount,
              active,
              created_by_admin_card_id
          )
          values (
              $1,
              $2,
              $3,
              true,
              $4
          )
          returning
              id,
              name,
              cash_amount,
              promotional_amount,
              total_credit_amount,
              active,
              created_by_admin_card_id,
              created_at,
              updated_at
          `,
          [
            name.trim(),
            cashAmount,
            promotionalAmount,
            admin.admin_card_id,
          ]
        );

        const promotion = result.rows[0];

        await client.query("COMMIT");

        return {
          created: true,
          promotion: {
            id: promotion.id,
            name: promotion.name,
            cashAmount: Number(
              promotion.cash_amount
            ),
            promotionalAmount: Number(
              promotion.promotional_amount
            ),
            totalCreditAmount: Number(
              promotion.total_credit_amount
            ),
            active: promotion.active,
            createdByAdminCardId: Number(
              promotion.created_by_admin_card_id
            ),
            createdAt: promotion.created_at,
            updatedAt: promotion.updated_at,
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

  server.get<{
    Querystring: {
      deviceCode?: string;
    };
  }>(
    "/admin/promotions",
    async (request, reply) => {
      const deviceCode = request.query.deviceCode;

      if (
        typeof deviceCode !== "string" ||
        deviceCode.trim().length === 0
      ) {
        return reply.status(400).send({
          error: "INVALID_DEVICE_CODE",
        });
      }

      const client = await db.connect();

      try {
        await client.query("BEGIN");

        const admin = await getAdminActor(
          client,
          deviceCode
        );

        if (admin === null) {
          await client.query("ROLLBACK");
          return reply.status(403).send({
            error: "ADMIN_PERMISSION_REQUIRED",
          });
        }

        const result = await client.query(
          `
          select
              id,
              name,
              cash_amount,
              promotional_amount,
              total_credit_amount,
              active,
              created_by_admin_card_id,
              created_at,
              updated_at
          from promotions
          order by
              active desc,
              cash_amount asc,
              created_at desc
          `
        );

        await client.query("COMMIT");

        return {
          promotions: result.rows.map(
            (row: any) => ({
              id: row.id,
              name: row.name,
              cashAmount: Number(
                row.cash_amount
              ),
              promotionalAmount: Number(
                row.promotional_amount
              ),
              totalCreditAmount: Number(
                row.total_credit_amount
              ),
              active: row.active,
              createdByAdminCardId:
                row.created_by_admin_card_id !== null
                  ? Number(
                      row.created_by_admin_card_id
                    )
                  : null,
              createdAt: row.created_at,
              updatedAt: row.updated_at,
            })
          ),
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

  server.patch<{
    Params: {
      promotionId: string;
    };
    Body: PromotionStatusBody;
  }>(
    "/admin/promotions/:promotionId/status",
    async (request, reply) => {
      const { promotionId } = request.params;
      const {
        deviceCode,
        active,
      } = request.body;

      if (
        typeof promotionId !== "string" ||
        promotionId.trim().length === 0
      ) {
        return reply.status(400).send({
          error: "INVALID_PROMOTION_ID",
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

      if (typeof active !== "boolean") {
        return reply.status(400).send({
          error: "INVALID_PROMOTION_STATUS",
        });
      }

      const client = await db.connect();

      try {
        await client.query("BEGIN");

        const admin = await getAdminActor(
          client,
          deviceCode
        );

        if (admin === null) {
          await client.query("ROLLBACK");
          return reply.status(403).send({
            error: "ADMIN_PERMISSION_REQUIRED",
          });
        }

        const result = await client.query(
          `
          update promotions
          set
              active = $2,
              updated_at = now()
          where id = $1
          returning
              id,
              name,
              cash_amount,
              promotional_amount,
              total_credit_amount,
              active,
              updated_at
          `,
          [
            promotionId.trim(),
            active,
          ]
        );

        if (result.rowCount === 0) {
          await client.query("ROLLBACK");
          return reply.status(404).send({
            error: "PROMOTION_NOT_FOUND",
          });
        }

        const promotion = result.rows[0];

        await client.query("COMMIT");

        return {
          updated: true,
          promotion: {
            id: promotion.id,
            name: promotion.name,
            cashAmount: Number(
              promotion.cash_amount
            ),
            promotionalAmount: Number(
              promotion.promotional_amount
            ),
            totalCreditAmount: Number(
              promotion.total_credit_amount
            ),
            active: promotion.active,
            updatedAt: promotion.updated_at,
          },
        };
      } catch (error: any) {
        await client.query("ROLLBACK");

        if (error?.code === "22P02") {
          return reply.status(400).send({
            error: "INVALID_PROMOTION_ID",
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
   * PROMOCIONES ACTIVAS PARA TAQUILLA
   *
   * GET /promotions/active
   *
   * Autenticación:
   *
   *   x-device-code
   *   x-device-token
   *
   * El token nunca viaja en la URL.
   * Solamente dispositivos RECHARGE activos pueden
   * consultar este catálogo operacional.
   * =====================================================
   */

  server.get<{
    Headers: ActivePromotionsHeaders;
  }>(
    "/promotions/active",

    async (request, reply) => {

      const deviceCode =
        request.headers[
          "x-device-code"
        ];

      const deviceToken =
        request.headers[
          "x-device-token"
        ];

      if (
        typeof deviceCode !==
          "string" ||
        deviceCode.trim()
          .length === 0 ||
        typeof deviceToken !==
          "string" ||
        deviceToken.trim()
          .length === 0
      ) {

        return reply
          .status(400)
          .send({
            error:
              "INVALID_DEVICE_CREDENTIALS",
          });
      }

      const client =
        await db.connect();

      try {

        const deviceResult =
          await client.query(
            `
            select
                id,
                device_code,
                name,
                device_type,
                status,
                credential_hash

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
            .status(401)
            .send({
              error:
                "INVALID_DEVICE_CREDENTIALS",
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

              status:
                device.status,
            });
        }

        if (
          typeof device
            .credential_hash !==
            "string" ||
          !verifyDeviceSecret(
            deviceToken,
            device.credential_hash
          )
        ) {

          return reply
            .status(401)
            .send({
              error:
                "INVALID_DEVICE_CREDENTIALS",
            });
        }

        if (
          device.device_type !==
          "RECHARGE"
        ) {

          return reply
            .status(409)
            .send({
              error:
                "DEVICE_NOT_RECHARGE",
            });
        }

        const promotionsResult =
          await client.query(
            `
            select
                id,
                name,
                cash_amount,
                promotional_amount,
                total_credit_amount

            from active_promotions

            order by
                cash_amount asc,
                total_credit_amount asc,
                created_at asc
            `
          );

        await client.query(
          `
          update devices

          set
              last_seen_at =
                  now(),

              updated_at =
                  now()

          where id = $1
          `,
          [
            device.id,
          ]
        );

        return {
          promotions:
            promotionsResult.rows.map(
              (row: any) => ({
                id:
                  row.id,

                name:
                  row.name,

                cashAmount:
                  Number(
                    row.cash_amount
                  ),

                promotionalAmount:
                  Number(
                    row
                      .promotional_amount
                  ),

                totalCreditAmount:
                  Number(
                    row
                      .total_credit_amount
                  ),
              })
            ),
        };

      } catch (error) {

        server.log.error(error);

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
