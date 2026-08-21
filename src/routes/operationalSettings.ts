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

type OperationalSettingsQuery = {
  deviceCode?: string;
};


type UpdateCardActivationFeeBody = {
  deviceCode: string;
  amount: number;
};


/*
 * =========================================================
 * ROUTES
 * =========================================================
 */

export async function operationalSettingsRoutes(
  server: FastifyInstance
) {

  /*
   * =====================================================
   * VALIDAR ADMIN ACTIVO
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
            d.id
              as device_id,

            d.device_code,

            s.id
              as session_id,

            s.admin_card_id

        from devices d

        join device_admin_sessions s
            on s.device_id =
               d.id

        join cards c
            on c.card_id =
               s.admin_card_id

        where d.device_code =
              $1

          and d.status =
              'ACTIVE'

          and s.status =
              'ACTIVE'

          and s.ended_at
              is null

          and c.card_type =
              'ADMIN'

          and c.status =
              'ACTIVE'

        limit 1
        `,
        [
          deviceCode.trim(),
        ]
      );


    if (
      result.rowCount ===
      0
    ) {

      return null;
    }


    return result.rows[0];
  }


  /*
   * =====================================================
   * OBTENER CONFIGURACIÓN
   * =====================================================
   *
   * GET /admin/operational-settings?deviceCode=...
   * =====================================================
   */

  server.get<{
    Querystring:
      OperationalSettingsQuery;
  }>(
    "/admin/operational-settings",

    async (
      request,
      reply
    ) => {

      const deviceCode =
        request.query
          ?.deviceCode;


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

        const admin =
          await getAdminActor(
            client,
            deviceCode
          );


        if (
          admin ===
          null
        ) {

          return reply
            .status(403)
            .send({
              error:
                "ADMIN_PERMISSION_REQUIRED",

              message:
                "Se necesita una sesión ADMIN activa.",
            });
        }


        const result =
          await client.query(
            `
            select
                customer_card_activation_fee,
                updated_at

            from operational_settings

            where id = 1

            limit 1
            `
          );


        if (
          result.rowCount ===
          0
        ) {

          return reply
            .status(500)
            .send({
              error:
                "OPERATIONAL_SETTINGS_NOT_FOUND",
            });
        }


        const row =
          result.rows[0];


        return {
          settings: {
            customerCardActivationFee:
              Number(
                row.customer_card_activation_fee
              ),

            updatedAt:
              row.updated_at,
          },
        };


      } catch (
        error
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
   * ACTUALIZAR PRECIO DE ACTIVACIÓN
   * =====================================================
   *
   * PUT /admin/operational-settings/card-activation-fee
   *
   * {
   *   "deviceCode": "ULEFONE-DEV-01",
   *   "amount": 30
   * }
   * =====================================================
   */

  server.put<{
    Body:
      UpdateCardActivationFeeBody;
  }>(
    "/admin/operational-settings/card-activation-fee",

    async (
      request,
      reply
    ) => {

      const {
        deviceCode,
        amount,
      } =
        request.body;


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
          amount
        ) ||

        amount <
          0
      ) {

        return reply
          .status(400)
          .send({
            error:
              "INVALID_CARD_ACTIVATION_FEE",

            message:
              "El precio debe ser un número entero mayor o igual a cero.",
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
          admin ===
          null
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


        const result =
          await client.query(
            `
            update operational_settings

            set
                customer_card_activation_fee =
                    $1,

                updated_by_admin_card_id =
                    $2,

                updated_at =
                    now()

            where id = 1

            returning
                customer_card_activation_fee,
                updated_by_admin_card_id,
                updated_at
            `,
            [
              amount,

              admin
                .admin_card_id,
            ]
          );


        if (
          result.rowCount ===
          0
        ) {

          await client.query(
            "ROLLBACK"
          );


          return reply
            .status(500)
            .send({
              error:
                "OPERATIONAL_SETTINGS_NOT_FOUND",
            });
        }


        await client.query(
          "COMMIT"
        );


        const row =
          result.rows[0];


        return {
          updated:
            true,

          settings: {
            customerCardActivationFee:
              Number(
                row.customer_card_activation_fee
              ),

            updatedByAdminCardId:
              Number(
                row.updated_by_admin_card_id
              ),

            updatedAt:
              row.updated_at,
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
}