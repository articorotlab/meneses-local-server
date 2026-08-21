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


/*
 * =========================================================
 * TYPES
 * =========================================================
 */

type DeviceStatus =
  | "ACTIVE"
  | "INACTIVE"
  | "BLOCKED";


type AdminDeviceQuery = {
  deviceCode?: string;
};


type CreateDeviceBody = {
  deviceCode: string;
  name: string;
};


type UpdateDeviceStatusBody = {
  deviceCode: string;
  status: DeviceStatus;
};


type CreateProvisioningCodeBody = {
  deviceCode: string;

  authorizingCardId: number;
  authorizingUid: string;
};


type RevokeProvisioningCodeBody = {
  deviceCode: string;
};


/*
 * =========================================================
 * HELPERS
 * =========================================================
 */

function normalizeUid(
  value: string
): string {

  return value
    .trim()
    .toUpperCase();
}


function isDeviceStatus(
  value: string
): value is DeviceStatus {

  return (
    value ===
      "ACTIVE" ||

    value ===
      "INACTIVE" ||

    value ===
      "BLOCKED"
  );
}


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

          s.id as session_id,
          s.admin_card_id,

          c.uid as admin_uid,
          c.status as admin_card_status

      from devices d

      join device_admin_sessions s
          on s.device_id =
             d.id

      join cards c
          on c.card_id =
             s.admin_card_id

      where d.device_code = $1

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

      for update of s, c
      `,
      [
        deviceCode.trim(),
      ]
    );


  if (
    result.rowCount === 0
  ) {

    return null;
  }


  return result.rows[0];
}


/*
 * Para generar un código de provisionamiento queremos
 * mayor seguridad.
 *
 * No basta con tener ADMIN abierto:
 *
 * Android deberá volver a presentar físicamente
 * la tarjeta ADMIN.
 */
async function validatePhysicalAdmin(
  client: any,
  deviceCode: string,
  cardId: number,
  uid: string
) {

  const admin =
    await getAdminActor(
      client,
      deviceCode
    );


  if (
    admin === null
  ) {

    return null;
  }


  if (
    Number(
      admin.admin_card_id
    ) !==
    cardId
  ) {

    return null;
  }


  if (
    normalizeUid(
      admin.admin_uid
    ) !==
    normalizeUid(
      uid
    )
  ) {

    return null;
  }


  return admin;
}


/*
 * =========================================================
 * NEXT DEVICE CODE
 * =========================================================
 */

async function createNextDeviceCode(
  client: any
): Promise<string> {

  /*
   * Una secuencia es segura incluso si dos administradores
   * crean dispositivos al mismo tiempo.
   */
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
 * DEVICE MANAGEMENT
 * =========================================================
 */

export async function deviceManagementRoutes(
  server: FastifyInstance
) {

  /*
   * =====================================================
   * LISTAR DISPOSITIVOS
   * =====================================================
   *
   * GET
   *
   * /admin/devices
   * ?deviceCode=ULEFONE-DEV-01
   * =====================================================
   */

  server.get<{
    Querystring:
      AdminDeviceQuery;
  }>(
    "/admin/devices",

    async (
      request,
      reply
    ) => {

      const deviceCode =
        request.query
          .deviceCode;


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

        await client.query(
          "BEGIN"
        );


        const admin =
          await getAdminActor(
            client,
            deviceCode
          );


        if (
          admin === null
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

              order by
                  p.created_at desc

              limit 1

            ) pc
              on true

            order by
                d.created_at asc
            `
          );


        await client.query(
          "COMMIT"
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
   * CREAR NUEVO ULEFONE
   * =====================================================
   *
   * POST /admin/devices
   *
   * {
   *   "deviceCode": "ULEFONE-DEV-01",
   *   "name": "Ulefone Taquilla Norte"
   * }
   *
   * El deviceCode del BODY es el Ulefone ADMIN que está
   * realizando la operación.
   *
   * El código del NUEVO dispositivo se genera solo.
   * =====================================================
   */

  server.post<{
    Body:
      CreateDeviceBody;
  }>(
    "/admin/devices",

    async (
      request,
      reply
    ) => {

      const {
        deviceCode,
        name,
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
        typeof name !==
          "string" ||

        name.trim()
          .length < 2 ||

        name.trim()
          .length > 100
      ) {

        return reply
          .status(400)
          .send({
            error:
              "INVALID_DEVICE_NAME",

            message:
              "El nombre debe tener entre 2 y 100 caracteres.",
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
          admin === null
        ) {

          await client.query(
            "ROLLBACK"
          );


          return reply
            .status(403)
            .send({
              error:
                "ADMIN_PERMISSION_REQUIRED",
            });
        }


        const newDeviceCode =
          await createNextDeviceCode(
            client
          );


        /*
         * El dispositivo nace INACTIVE.
         *
         * Solamente /devices/provision podrá convertirlo
         * a ACTIVE después de consumir correctamente
         * un código temporal.
         */
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
                created_at,
                updated_at
            `,
            [
              newDeviceCode,
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
              actor_admin_card_id,
              metadata
          )

          values (
              $1,
              'DEVICE_CREATED',
              'ADMIN_CARD',
              $2,
              $3::jsonb
          )
          `,
          [
            device.id,

            admin.admin_card_id,

            JSON.stringify({
              sourceDeviceCode:
                deviceCode.trim(),

              deviceCode:
                device.device_code,

              name:
                device.name,
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
        error: any
      ) {

        await client.query(
          "ROLLBACK"
        );


        server.log.error(
          error
        );


        if (
          error?.code ===
          "23505"
        ) {

          return reply
            .status(409)
            .send({
              error:
                "DEVICE_CODE_CONFLICT",
            });
        }


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
   * CAMBIAR STATUS
   * =====================================================
   *
   * PATCH /admin/devices/:deviceId/status
   * =====================================================
   */

  server.patch<{
    Params: {
      deviceId: string;
    };

    Body:
      UpdateDeviceStatusBody;
  }>(
    "/admin/devices/:deviceId/status",

    async (
      request,
      reply
    ) => {

      const {
        deviceId,
      } =
        request.params;


      const {
        deviceCode,
        status,
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


        const admin =
          await getAdminActor(
            client,
            deviceCode
          );


        if (
          admin === null
        ) {

          await client.query(
            "ROLLBACK"
          );


          return reply
            .status(403)
            .send({
              error:
                "ADMIN_PERMISSION_REQUIRED",
            });
        }


        const deviceResult =
          await client.query(
            `
            select
                id,
                device_code,
                name,
                device_type,
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


        const target =
          deviceResult.rows[0];


        /*
         * Evitamos que el administrador bloquee el mismo
         * Ulefone desde el que está trabajando.
         */
        if (
          target.id ===
            admin.device_id &&

          status !==
            "ACTIVE"
        ) {

          await client.query(
            "ROLLBACK"
          );


          return reply
            .status(409)
            .send({
              error:
                "CANNOT_DISABLE_CURRENT_ADMIN_DEVICE",

              message:
                "No puedes desactivar el dispositivo que mantiene la sesión ADMIN actual.",
            });
        }


        /*
         * Un Ulefone nuevo todavía no provisionado no
         * debe ser activado manualmente.
         *
         * La excepción es el dispositivo legacy.
         */
        if (
          status ===
            "ACTIVE" &&

          target
            .credential_hash ===
            null &&

          !String(
            target.device_code
          ).startsWith(
            "ULEFONE-DEV-"
          )
        ) {

          await client.query(
            "ROLLBACK"
          );


          return reply
            .status(409)
            .send({
              error:
                "DEVICE_NOT_PROVISIONED",

              message:
                "El dispositivo debe completar su provisionamiento antes de activarse.",
            });
        }


        const previousStatus =
          target.status;


        /*
         * Si se bloquea o desactiva cerramos cualquier
         * operación activa inmediatamente.
         */
        if (
          status ===
            "INACTIVE" ||

          status ===
            "BLOCKED"
        ) {

          await client.query(
            `
            update device_game_sessions

            set
                status = 'CLOSED',
                ended_at = now()

            where device_id = $1

              and status =
                  'ACTIVE'

              and ended_at
                  is null
            `,
            [
              target.id,
            ]
          );


          await client.query(
            `
            update device_recharge_sessions

            set
                status = 'CLOSED',
                ended_at = now()

            where device_id = $1

              and status =
                  'ACTIVE'

              and ended_at
                  is null
            `,
            [
              target.id,
            ]
          );


          await client.query(
            `
            update device_admin_sessions

            set
                status = 'CLOSED',
                ended_at = now()

            where device_id = $1

              and status =
                  'ACTIVE'

              and ended_at
                  is null
            `,
            [
              target.id,
            ]
          );
        }


        const updatedResult =
          await client.query(
            `
            update devices

            set
                status = $2,

                device_type =
                    case
                      when $2 = 'ACTIVE'
                      then device_type
                      else 'IDLE'
                    end,

                updated_at =
                    now()

            where id = $1

            returning
                id,
                device_code,
                name,
                device_type,
                status,
                provisioned_at,
                last_seen_at,
                updated_at
            `,
            [
              target.id,
              status,
            ]
          );


        const updated =
          updatedResult.rows[0];


        await client.query(
          `
          insert into device_audit_events (
              device_id,
              event_type,
              actor_type,
              actor_admin_card_id,
              metadata
          )

          values (
              $1,
              'STATUS_CHANGED',
              'ADMIN_CARD',
              $2,
              $3::jsonb
          )
          `,
          [
            target.id,

            admin.admin_card_id,

            JSON.stringify({
              sourceDeviceCode:
                deviceCode.trim(),

              previousStatus,

              newStatus:
                status,
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
              updated.id,

            code:
              updated.device_code,

            name:
              updated.name,

            currentMode:
              updated.device_type,

            status:
              updated.status,

            provisioned:
              updated.provisioned_at !==
              null,

            lastSeenAt:
              updated.last_seen_at,

            updatedAt:
              updated.updated_at,
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
   * Requiere:
   *
   * 1. sesión ADMIN activa;
   * 2. presentar nuevamente la tarjeta ADMIN.
   *
   * POST
   * /admin/devices/:deviceId/provisioning-code
   * =====================================================
   */

  server.post<{
    Params: {
      deviceId: string;
    };

    Body:
      CreateProvisioningCodeBody;
  }>(
    "/admin/devices/:deviceId/provisioning-code",

    async (
      request,
      reply
    ) => {

      const {
        deviceId,
      } =
        request.params;


      const {
        deviceCode,
        authorizingCardId,
        authorizingUid,
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
          authorizingCardId
        ) ||

        authorizingCardId <= 0
      ) {

        return reply
          .status(400)
          .send({
            error:
              "INVALID_ADMIN_CARD_ID",
          });
      }


      if (
        typeof authorizingUid !==
          "string" ||

        authorizingUid.trim()
          .length === 0
      ) {

        return reply
          .status(400)
          .send({
            error:
              "INVALID_ADMIN_UID",
          });
      }


      const client =
        await db.connect();


      try {

        await client.query(
          "BEGIN"
        );


        const admin =
          await validatePhysicalAdmin(
            client,
            deviceCode,
            authorizingCardId,
            authorizingUid
          );


        if (
          admin === null
        ) {

          await client.query(
            "ROLLBACK"
          );


          return reply
            .status(403)
            .send({
              error:
                "PHYSICAL_ADMIN_AUTHORIZATION_REQUIRED",

              message:
                "Debes volver a presentar la tarjeta ADMIN activa.",
            });
        }


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


        const target =
          deviceResult.rows[0];


        if (
          target.credential_hash !==
            null ||

          target.provisioned_at !==
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

              message:
                "Este Ulefone ya fue provisionado.",
            });
        }


        if (
          target.status ===
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


        /*
         * Los PENDING vencidos pasan a EXPIRED.
         */
        await client.query(
          `
          update device_provisioning_codes

          set
              status =
                  'EXPIRED'

          where device_id = $1

            and status =
                'PENDING'

            and expires_at <=
                now()
          `,
          [
            target.id,
          ]
        );


        /*
         * Revocamos cualquier otro código todavía
         * pendiente.
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
            target.id,
          ]
        );


        const rawCode =
          createProvisioningCode();


        const codeHash =
          hashDeviceSecret(
            rawCode
          );


        const codeResult =
          await client.query(
            `
            insert into device_provisioning_codes (
                device_id,
                code_hash,
                status,
                expires_at,
                created_by_admin_card_id
            )

            values (
                $1,
                $2,
                'PENDING',
                now() +
                    interval '15 minutes',
                $3
            )

            returning
                id,
                expires_at,
                created_at
            `,
            [
              target.id,

              codeHash,

              admin.admin_card_id,
            ]
          );


        const provisioning =
          codeResult.rows[0];


        await client.query(
          `
          insert into device_audit_events (
              device_id,
              event_type,
              actor_type,
              actor_admin_card_id,
              metadata
          )

          values (
              $1,
              'PROVISIONING_CODE_CREATED',
              'ADMIN_CARD',
              $2,
              $3::jsonb
          )
          `,
          [
            target.id,

            admin.admin_card_id,

            JSON.stringify({
              sourceDeviceCode:
                deviceCode.trim(),

              provisioningCodeId:
                provisioning.id,

              expiresAt:
                provisioning
                  .expires_at,
            }),
          ]
        );


        await client.query(
          "COMMIT"
        );


        /*
         * rawCode se devuelve UNA VEZ.
         *
         * PostgreSQL solamente conoce codeHash.
         */
        return {
          created:
            true,

          device: {
            deviceId:
              target.id,

            code:
              target.device_code,

            name:
              target.name,
          },

          provisioning: {
            id:
              provisioning.id,

            code:
              rawCode,

            expiresAt:
              provisioning
                .expires_at,
          },
        };


      } catch (
        error: any
      ) {

        await client.query(
          "ROLLBACK"
        );


        server.log.error(
          error
        );


        if (
          error?.code ===
          "23505"
        ) {

          return reply
            .status(409)
            .send({
              error:
                "PROVISIONING_CODE_CONFLICT",

              message:
                "Vuelve a intentar generar el código.",
            });
        }


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
   * REVOCAR CÓDIGO
   * =====================================================
   *
   * Aquí basta la sesión ADMIN activa.
   * =====================================================
   */

  server.post<{
    Params: {
      deviceId: string;
    };

    Body:
      RevokeProvisioningCodeBody;
  }>(
    "/admin/devices/:deviceId/revoke-provisioning-code",

    async (
      request,
      reply
    ) => {

      const {
        deviceId,
      } =
        request.params;


      const {
        deviceCode,
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
          admin === null
        ) {

          await client.query(
            "ROLLBACK"
          );


          return reply
            .status(403)
            .send({
              error:
                "ADMIN_PERMISSION_REQUIRED",
            });
        }


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
              deviceId,
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
                "NO_PENDING_PROVISIONING_CODE",
            });
        }


        const codeId =
          result.rows[0].id;


        await client.query(
          `
          insert into device_audit_events (
              device_id,
              event_type,
              actor_type,
              actor_admin_card_id,
              metadata
          )

          values (
              $1,
              'PROVISIONING_CODE_REVOKED',
              'ADMIN_CARD',
              $2,
              $3::jsonb
          )
          `,
          [
            deviceId,

            admin.admin_card_id,

            JSON.stringify({
              sourceDeviceCode:
                deviceCode.trim(),

              provisioningCodeId:
                codeId,
            }),
          ]
        );


        await client.query(
          "COMMIT"
        );


        return {
          revoked:
            true,

          provisioningCodeId:
            codeId,
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