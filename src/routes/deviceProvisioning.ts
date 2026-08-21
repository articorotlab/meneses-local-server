import type {
  FastifyInstance,
} from "fastify";

import {
  db,
} from "../db/database.js";

import {
  createDeviceToken,
  hashDeviceSecret,
  normalizeProvisioningCode,
  verifyDeviceSecret,
} from "../auth/deviceCredential.js";


/*
 * =========================================================
 * TYPES
 * =========================================================
 */

type ProvisionDeviceBody = {
  code: string;
};


type VerifyDeviceBody = {
  deviceCode: string;
  deviceToken: string;
};

type HeartbeatBody = {
  deviceCode: string;
  deviceToken: string;
};

/*
 * =========================================================
 * DEVICE PROVISIONING
 * =========================================================
 */

export async function deviceProvisioningRoutes(
  server: FastifyInstance
) {

  /*
   * =====================================================
   * PROVISIONAR
   * =====================================================
   *
   * POST /devices/provision
   *
   * {
   *   "code": "ABCD-EFGH-JKLM"
   * }
   *
   * Este endpoint NO requiere identidad previa porque el
   * teléfono todavía no tiene una.
   * =====================================================
   */

  server.post<{
    Body:
      ProvisionDeviceBody;
  }>(
    "/devices/provision",

    async (
      request,
      reply
    ) => {

      const code =
        request.body
          ?.code;


      if (
        typeof code !==
          "string" ||

        code.trim()
          .length === 0
      ) {

        return reply
          .status(400)
          .send({
            error:
              "INVALID_PROVISIONING_CODE",
          });
      }


      const normalizedCode =
        normalizeProvisioningCode(
          code
        );


      const codeHash =
        hashDeviceSecret(
          normalizedCode
        );


      const client =
        await db.connect();


      try {

        await client.query(
          "BEGIN"
        );


        const result =
          await client.query(
            `
            select
                p.id
                  as provisioning_id,

                p.status
                  as provisioning_status,

                p.expires_at,

                d.id
                  as device_id,

                d.device_code,
                d.name,
                d.status
                  as device_status,

                d.credential_hash,
                d.provisioned_at

            from device_provisioning_codes p

            join devices d
                on d.id =
                   p.device_id

            where p.code_hash = $1

            limit 1

            for update of p, d
            `,
            [
              codeHash,
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
            .status(404)
            .send({
              error:
                "PROVISIONING_CODE_NOT_FOUND",

              message:
                "El código de activación no es válido.",
            });
        }


        const row =
          result.rows[0];


        if (
          row.provisioning_status !==
          "PENDING"
        ) {

          await client.query(
            "ROLLBACK"
          );


          return reply
            .status(409)
            .send({
              error:
                "PROVISIONING_CODE_NOT_PENDING",

              status:
                row.provisioning_status,
            });
        }


        if (
          new Date(
            row.expires_at
          ).getTime() <=
          Date.now()
        ) {

          await client.query(
            `
            update device_provisioning_codes

            set
                status =
                    'EXPIRED'

            where id = $1
            `,
            [
              row.provisioning_id,
            ]
          );


          await client.query(
            "COMMIT"
          );


          return reply
            .status(410)
            .send({
              error:
                "PROVISIONING_CODE_EXPIRED",

              message:
                "El código de activación expiró.",
            });
        }


        if (
          row.device_status ===
          "BLOCKED"
        ) {

          await client.query(
            "ROLLBACK"
          );


          return reply
            .status(409)
            .send({
              error:
                "DEVICE_BLOCKED",
            });
        }


        if (
          row.credential_hash !==
            null ||

          row.provisioned_at !==
            null
        ) {

          await client.query(
            "ROLLBACK"
          );


          return reply
            .status(409)
            .send({
              error:
                "DEVICE_ALREADY_PROVISIONED",
            });
        }


        /*
         * Credencial permanente del dispositivo.
         */
        const deviceToken =
          createDeviceToken();


        const credentialHash =
          hashDeviceSecret(
            deviceToken
          );


        const deviceResult =
          await client.query(
            `
            update devices

            set
                credential_hash =
                    $2,

                provisioned_at =
                    now(),

                last_seen_at =
                    now(),

                status =
                    'ACTIVE',

                device_type =
                    'IDLE',

                updated_at =
                    now()

            where id = $1

            returning
                id,
                device_code,
                name,
                status,
                provisioned_at,
                last_seen_at
            `,
            [
              row.device_id,
              credentialHash,
            ]
          );


        const device =
          deviceResult.rows[0];


        await client.query(
          `
          update device_provisioning_codes

          set
              status =
                  'USED',

              used_at =
                  now()

          where id = $1
          `,
          [
            row.provisioning_id,
          ]
        );


        await client.query(
          `
          insert into device_audit_events (
              device_id,
              event_type,
              actor_type,
              metadata
          )

          values (
              $1,
              'PROVISIONED',
              'SYSTEM',
              $2::jsonb
          )
          `,
          [
            device.id,

            JSON.stringify({
              provisioningCodeId:
                row.provisioning_id,
            }),
          ]
        );


        await client.query(
          "COMMIT"
        );


        /*
         * MUY IMPORTANTE:
         *
         * deviceToken sólo se devuelve en esta respuesta.
         *
         * La BD solamente conserva el hash.
         */
        return {
          provisioned:
            true,

          device: {
            deviceId:
              device.id,

            code:
              device.device_code,

            name:
              device.name,

            status:
              device.status,

            provisionedAt:
              device.provisioned_at,
          },

          credential: {
            deviceToken,
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
   * VERIFICAR CREDENCIAL
   * =====================================================
   *
   * Este endpoint nos permite probar el sistema antes
   * de modificar todas las rutas GAME/RECHARGE/ADMIN.
   *
   * POST /devices/verify
   * =====================================================
   */

  server.post<{
    Body:
      VerifyDeviceBody;
  }>(
    "/devices/verify",

    async (
      request,
      reply
    ) => {

      const {
        deviceCode,
        deviceToken,
      } =
        request.body;


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


      const result =
        await db.query(
          `
          select
              id,
              device_code,
              name,
              status,
              credential_hash,
              provisioned_at,
              last_seen_at

          from devices

          where device_code = $1

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

        return reply
          .status(401)
          .send({
            error:
              "INVALID_DEVICE_CREDENTIALS",
          });
      }


      const device =
        result.rows[0];


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


      const seenResult =
        await db.query(
          `
          update devices

          set
              last_seen_at =
                  now(),

              updated_at =
                  now()

          where id = $1

          returning
              last_seen_at
          `,
          [
            device.id,
          ]
        );


      return {
        authenticated:
          true,

        device: {
          deviceId:
            device.id,

          code:
            device.device_code,

          name:
            device.name,

          status:
            device.status,

          provisionedAt:
            device.provisioned_at,

          lastSeenAt:
            seenResult
              .rows[0]
              .last_seen_at,
        },
      };
    }
  );

  /*
   * =====================================================
   * HEARTBEAT DEL DISPOSITIVO
   * =====================================================
   *
   * POST /devices/heartbeat
   *
   * El Ulefone envía esta llamada periódicamente mientras
   * la aplicación está activa.
   *
   * No crea auditoría histórica.
   * No modifica sesiones.
   * No modifica GAME / RECHARGE / ADMIN.
   *
   * Únicamente:
   *
   * - valida la identidad permanente;
   * - confirma que el dispositivo siga ACTIVE;
   * - actualiza last_seen_at.
   * =====================================================
   */

  server.post<{
    Body:
      HeartbeatBody;
  }>(
    "/devices/heartbeat",

    async (
      request,
      reply
    ) => {

      const {
        deviceCode,
        deviceToken,
      } =
        request.body;


      /*
       * =================================================
       * VALIDACIÓN BÁSICA
       * =================================================
       */

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


      /*
       * =================================================
       * BUSCAR DISPOSITIVO
       * =================================================
       */

      const result =
        await db.query(
          `
          select
              id,
              device_code,
              name,
              status,
              credential_hash,
              provisioned_at,
              last_seen_at

          from devices

          where device_code = $1

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

        return reply
          .status(401)
          .send({
            error:
              "INVALID_DEVICE_CREDENTIALS",
          });
      }


      const device =
        result.rows[0];


      /*
       * =================================================
       * DISPOSITIVO ACTIVO
       * =================================================
       */

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


      /*
       * =================================================
       * VALIDAR TOKEN
       * =================================================
       */

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


      /*
       * =================================================
       * ACTUALIZAR ÚLTIMA CONEXIÓN
       * =================================================
       */

      const seenResult =
        await db.query(
          `
          update devices

          set
              last_seen_at =
                  now(),

              updated_at =
                  now()

          where id = $1

          returning
              last_seen_at
          `,
          [
            device.id,
          ]
        );


      /*
       * =================================================
       * RESPUESTA
       * =================================================
       */

      return {
        alive:
          true,

        device: {
          deviceId:
            device.id,

          code:
            device.device_code,

          name:
            device.name,

          status:
            device.status,

          lastSeenAt:
            seenResult
              .rows[0]
              .last_seen_at,
        },
      };
    }
  );

}