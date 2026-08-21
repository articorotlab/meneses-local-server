import type {
  FastifyInstance,
} from "fastify";

import {
  db,
} from "../db/database.js";

import {
  createProvisioningCode,
  hashDeviceSecret,
} from "../auth/deviceCredential.js";

import {
  requireWebAdmin,
} from "../auth/webAdminSession.js";


/*
 * =========================================================
 * TYPES
 * =========================================================
 */

type DeviceStatus =
  | "ACTIVE"
  | "INACTIVE"
  | "BLOCKED";


type CreateDeviceBody = {
  name: string;
};


type UpdateDeviceStatusBody = {
  status: DeviceStatus;
};


type DeviceParams = {
  deviceId: string;
};


/*
 * =========================================================
 * HELPERS
 * =========================================================
 */

function isDeviceStatus(
  value: string
): value is DeviceStatus {

  return (
    value === "ACTIVE" ||
    value === "INACTIVE" ||
    value === "BLOCKED"
  );
}


async function createNextDeviceCode(
  client: any
): Promise<string> {

  const result =
    await client.query(
      `
      select
          nextval(
            'device_code_seq'
          ) as next_number
      `
    );


  const number =
    Number(
      result.rows[0]
        .next_number
    );


  return (
    "ULEFONE-" +
    String(
      number
    ).padStart(
      3,
      "0"
    )
  );
}


/*
 * =========================================================
 * WEB ADMIN DEVICE ROUTES
 * =========================================================
 */

export async function webAdminDeviceRoutes(
  server: FastifyInstance
) {

  /*
   * =====================================================
   * LISTAR DISPOSITIVOS
   * =====================================================
   *
   * GET /web/admin/devices
   */

  server.get(
    "/web/admin/devices",

    async (
      request,
      reply
    ) => {

      const webAdmin =
        await requireWebAdmin(
          request,
          reply
        );


      if (!webAdmin) {
        return;
      }


      const result =
        await db.query(
          `
          select
              d.id,
              d.device_code,
              d.name,
              d.device_type,
              d.status,

              d.credential_hash
                is not null
                as provisioned,

              d.provisioned_at,
              d.last_seen_at,
              d.created_at,
              d.updated_at,

              pc.id
                as pending_code_id,

              pc.expires_at
                as pending_code_expires_at,

              case

                when exists (
                  select 1

                  from device_admin_sessions s

                  where s.device_id =
                        d.id

                    and s.status =
                        'ACTIVE'

                    and s.ended_at
                        is null
                )
                then 'ADMIN'

                when exists (
                  select 1

                  from device_recharge_sessions s

                  where s.device_id =
                        d.id

                    and s.status =
                        'ACTIVE'

                    and s.ended_at
                        is null
                )
                then 'RECHARGE'

                when exists (
                  select 1

                  from device_game_sessions s

                  where s.device_id =
                        d.id

                    and s.status =
                        'ACTIVE'

                    and s.ended_at
                        is null
                )
                then 'GAME'

                else 'IDLE'

              end as current_mode

          from devices d

          left join lateral (

            select
                p.id,
                p.expires_at

            from device_provisioning_codes p

            where p.device_id =
                  d.id

              and p.status =
                  'PENDING'

              and p.expires_at >
                  now()

            order by
                p.created_at desc

            limit 1

          ) pc
            on true

          order by
              d.created_at asc
          `
        );


      return {
        devices:
          result.rows.map(
            (
              row: any
            ) => ({

              deviceId:
                row.id,

              code:
                row.device_code,

              name:
                row.name,

              legacyMode:
                row.device_type,

              currentMode:
                row.current_mode,

              status:
                row.status,

              provisioned:
                Boolean(
                  row.provisioned
                ),

              provisionedAt:
                row.provisioned_at,

              lastSeenAt:
                row.last_seen_at,

              createdAt:
                row.created_at,

              updatedAt:
                row.updated_at,

              pendingProvisioning:
                row.pending_code_id
                  ? {
                      id:
                        row.pending_code_id,

                      expiresAt:
                        row
                          .pending_code_expires_at,
                    }
                  : null,
            })
          ),
      };
    }
  );


  /*
   * =====================================================
   * CREAR DISPOSITIVO
   * =====================================================
   *
   * POST /web/admin/devices
   *
   * {
   *   "name": "Ulefone Taquilla Principal"
   * }
   */

  server.post<{
    Body:
      CreateDeviceBody;
  }>(
    "/web/admin/devices",

    async (
      request,
      reply
    ) => {

      const webAdmin =
        await requireWebAdmin(
          request,
          reply
        );


      if (!webAdmin) {
        return;
      }


      const name =
        request.body
          ?.name;


      if (
        typeof name !==
          "string" ||

        name.trim()
          .length < 3
      ) {

        return reply
          .status(400)
          .send({
            error:
              "INVALID_DEVICE_NAME",

            message:
              "El nombre del dispositivo debe contener al menos 3 caracteres.",
          });
      }


      const client =
        await db.connect();


      try {

        await client.query(
          "BEGIN"
        );


        const deviceCode =
          await createNextDeviceCode(
            client
          );


        const result =
          await client.query(
            `
            insert into devices (
                device_code,
                name,
                device_type,
                status
            )

            values (
                $1,
                $2,
                'IDLE',
                'INACTIVE'
            )

            returning
                id,
                device_code,
                name,
                device_type,
                status,
                created_at
            `,
            [
              deviceCode,
              name.trim(),
            ]
          );


        const device =
          result.rows[0];


        await client.query(
          `
          insert into device_audit_events (
              device_id,
              event_type,
              actor_type,
              actor_web_admin_user_id,
              metadata
          )

          values (
              $1,
              'DEVICE_CREATED',
              'WEB_ADMIN',
              $2,
              $3::jsonb
          )
          `,
          [
            device.id,
            webAdmin.id,

            JSON.stringify({
              name:
                device.name,

              deviceCode:
                device.device_code,
            }),
          ]
        );


        await client.query(
          "COMMIT"
        );


        return reply
          .status(201)
          .send({
            created:
              true,

            device: {
              deviceId:
                device.id,

              code:
                device.device_code,

              name:
                device.name,

              currentMode:
                "IDLE",

              status:
                device.status,

              provisioned:
                false,

              createdAt:
                device.created_at,
            },
          });


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
   * CAMBIAR ESTADO
   * =====================================================
   *
   * PATCH /web/admin/devices/:deviceId/status
   */

  server.patch<{
    Params:
      DeviceParams;

    Body:
      UpdateDeviceStatusBody;
  }>(
    "/web/admin/devices/:deviceId/status",

    async (
      request,
      reply
    ) => {

      const webAdmin =
        await requireWebAdmin(
          request,
          reply
        );


      if (!webAdmin) {
        return;
      }


      const {
        deviceId,
      } =
        request.params;


      const status =
        request.body
          ?.status;


      if (
        typeof status !==
          "string" ||

        !isDeviceStatus(
          status
        )
      ) {

        return reply
          .status(400)
          .send({
            error:
              "INVALID_DEVICE_STATUS",
          });
      }


      const client =
        await db.connect();


      try {

        await client.query(
          "BEGIN"
        );


        const currentResult =
          await client.query(
            `
            select
                id,
                device_code,
                name,
                status

            from devices

            where id = $1

            limit 1

            for update
            `,
            [
              deviceId,
            ]
          );


        if (
          currentResult.rowCount ===
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


        const current =
          currentResult.rows[0];


        const result =
          await client.query(
            `
            update devices

            set
                status =
                    $2,

                updated_at =
                    now()

            where id = $1

            returning
                id,
                device_code,
                name,
                status,
                updated_at
            `,
            [
              deviceId,
              status,
            ]
          );


        const device =
          result.rows[0];


        await client.query(
          `
          insert into device_audit_events (
              device_id,
              event_type,
              actor_type,
              actor_web_admin_user_id,
              metadata
          )

          values (
              $1,
              'STATUS_CHANGED',
              'WEB_ADMIN',
              $2,
              $3::jsonb
          )
          `,
          [
            device.id,
            webAdmin.id,

            JSON.stringify({
              previousStatus:
                current.status,

              newStatus:
                device.status,
            }),
          ]
        );


        await client.query(
          "COMMIT"
        );


        return {
          updated:
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

            updatedAt:
              device.updated_at,
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
   * GENERAR CÓDIGO DE PROVISIONAMIENTO
   * =====================================================
   *
   * POST
   * /web/admin/devices/:deviceId/provisioning-code
   */

  server.post<{
    Params:
      DeviceParams;
  }>(
    "/web/admin/devices/:deviceId/provisioning-code",

    async (
      request,
      reply
    ) => {

      const webAdmin =
        await requireWebAdmin(
          request,
          reply
        );


      if (!webAdmin) {
        return;
      }


      const {
        deviceId,
      } =
        request.params;


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
                device_code,
                name,
                status,
                credential_hash,
                provisioned_at

            from devices

            where id = $1

            limit 1

            for update
            `,
            [
              deviceId,
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
          device.status ===
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
          device.credential_hash !==
            null ||

          device.provisioned_at !==
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
         * Revocamos cualquier código pendiente anterior.
         */

        await client.query(
          `
          update device_provisioning_codes

          set
              status =
                  'REVOKED',

              revoked_at =
                  now()

          where device_id = $1

            and status =
                'PENDING'
          `,
          [
            device.id,
          ]
        );


        /*
         * Código visible para el administrador.
         */

        const provisioningCode =
          createProvisioningCode();


        /*
         * En PostgreSQL solamente guardamos el hash.
         */

        const codeHash =
          hashDeviceSecret(
            provisioningCode
          );


        const provisioningResult =
          await client.query(
            `
            insert into device_provisioning_codes (
                device_id,
                code_hash,
                status,
                expires_at,
                created_by_web_admin_user_id
            )

            values (
                $1,
                $2,
                'PENDING',
                now() + interval '15 minutes',
                $3
            )

            returning
                id,
                expires_at,
                created_at
            `,
            [
              device.id,
              codeHash,
              webAdmin.id,
            ]
          );


        const provisioning =
          provisioningResult
            .rows[0];


        await client.query(
          `
          insert into device_audit_events (
              device_id,
              event_type,
              actor_type,
              actor_web_admin_user_id,
              metadata
          )

          values (
              $1,
              'PROVISIONING_CODE_CREATED',
              'WEB_ADMIN',
              $2,
              $3::jsonb
          )
          `,
          [
            device.id,
            webAdmin.id,

            JSON.stringify({
              provisioningCodeId:
                provisioning.id,

              expiresAt:
                provisioning.expires_at,
            }),
          ]
        );


        await client.query(
          "COMMIT"
        );


        return reply
          .status(201)
          .send({
            created:
              true,

            device: {
              deviceId:
                device.id,

              code:
                device.device_code,

              name:
                device.name,
            },

            provisioning: {
              id:
                provisioning.id,

              code:
                provisioningCode,

              expiresAt:
                provisioning.expires_at,
            },
          });


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
   * REVOCAR CÓDIGO PENDIENTE
   * =====================================================
   *
   * DELETE
   * /web/admin/devices/:deviceId/provisioning-code
   */

  server.delete<{
    Params:
      DeviceParams;
  }>(
    "/web/admin/devices/:deviceId/provisioning-code",

    async (
      request,
      reply
    ) => {

      const webAdmin =
        await requireWebAdmin(
          request,
          reply
        );


      if (!webAdmin) {
        return;
      }


      const {
        deviceId,
      } =
        request.params;


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
                device_code,
                name

            from devices

            where id = $1

            limit 1

            for update
            `,
            [
              deviceId,
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


        const result =
          await client.query(
            `
            update device_provisioning_codes

            set
                status =
                    'REVOKED',

                revoked_at =
                    now()

            where device_id = $1

              and status =
                  'PENDING'

            returning id
            `,
            [
              device.id,
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
                "PENDING_PROVISIONING_NOT_FOUND",
            });
        }


        await client.query(
          `
          insert into device_audit_events (
              device_id,
              event_type,
              actor_type,
              actor_web_admin_user_id,
              metadata
          )

          values (
              $1,
              'PROVISIONING_CODE_REVOKED',
              'WEB_ADMIN',
              $2,
              $3::jsonb
          )
          `,
          [
            device.id,
            webAdmin.id,

            JSON.stringify({
              provisioningCodeId:
                result.rows[0].id,
            }),
          ]
        );


        await client.query(
          "COMMIT"
        );


        return {
          revoked:
            true,

          device: {
            deviceId:
              device.id,

            code:
              device.device_code,

            name:
              device.name,
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