import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { db } from "../db/database.js";


/*
 * =========================================================
 * TYPES
 * =========================================================
 */

type CreateRechargePointBody = {
  deviceCode: string;
  name: string;
};

type UpdateRechargePointBody = {
  deviceCode: string;
  name: string;
};


type PrepareRechargeCardBody = {
  idempotencyKey: string;
  deviceCode: string;
  rechargePointId: string;
  targetUid: string;
};


type ConfirmRechargeCardBody = {
  registrationId: string;
  deviceCode: string;
  targetUid: string;
  writtenCardId: number;
};


type FailRechargeCardBody = {
  registrationId: string;
  deviceCode: string;
  reason: string;
};


/*
 * =========================================================
 * ADMIN RECHARGE MANAGEMENT
 * =========================================================
 *
 * Solamente ADMIN.
 *
 * Flujo:
 *
 * 1. Crear recharge_point PENDING_SETUP
 * 2. Preparar tarjeta RECHARGE
 * 3. Android escribe NFC
 * 4. Android verifica NFC
 * 5. Servidor confirma
 * 6. Crear cards
 * 7. Crear recharge_cards
 * 8. Activar recharge_point
 * =========================================================
 */

export async function rechargeManagementRoutes(
  server: FastifyInstance
) {

  /*
   * =====================================================
   * HELPER: SESIÓN ADMIN
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

    if (
      result.rowCount === 0
    ) {

      return null;
    }

    return result.rows[0];
  }


  /*
   * =====================================================
   * CREAR TAQUILLA
   * =====================================================
   *
   * POST /admin/recharge-points
   *
   * Android solamente manda:
   *
   * {
   *   deviceCode,
   *   name
   * }
   *
   * recharge_code se genera internamente.
   * =====================================================
   */

  server.post<{
    Body: CreateRechargePointBody;
  }>(
    "/admin/recharge-points",

    async (request, reply) => {

      const {
        deviceCode,
        name,
      } = request.body;

      /*
       * -----------------------------------------------
       * VALIDACIONES
       * -----------------------------------------------
       */

      if (
        typeof deviceCode !== "string" ||
        deviceCode.trim().length === 0
      ) {

        return reply.status(400).send({
          error:
            "INVALID_DEVICE_CODE",
        });
      }


      if (
        typeof name !== "string" ||
        name.trim().length < 2
      ) {

        return reply.status(400).send({
          error:
            "INVALID_RECHARGE_POINT_NAME",

          message:
            "El nombre de la taquilla debe contener al menos 2 caracteres.",
        });
      }


      const normalizedName =
        name.trim();


      /*
       * Código técnico.
       *
       * El administrador nunca necesita verlo ni escribirlo.
       */
      const rechargeCode =
        "RECHARGE-" +
        randomUUID()
          .replaceAll("-", "")
          .toUpperCase();


      const client =
        await db.connect();


      try {

        await client.query("BEGIN");


        /*
         * -----------------------------------------------
         * ADMIN ACTIVO
         * -----------------------------------------------
         */

        const admin =
          await getAdminActor(
            client,
            deviceCode
          );


        if (
          admin === null
        ) {

          await client.query("ROLLBACK");

          return reply.status(403).send({
            error:
              "ADMIN_PERMISSION_REQUIRED",

            message:
              "Se necesita una sesión ADMIN activa.",
          });
        }


        /*
         * -----------------------------------------------
         * EVITAR NOMBRE EXACTO DUPLICADO
         * -----------------------------------------------
         *
         * No usamos esto como ID.
         * Es solamente protección UX.
         */

        const existingNameResult =
          await client.query(
            `
            select
                id,
                recharge_code,
                name,
                status

            from recharge_points

            where lower(name) =
                  lower($1)

            limit 1
            `,
            [
              normalizedName,
            ]
          );


        if (
          existingNameResult.rowCount &&
          existingNameResult.rowCount > 0
        ) {

          await client.query("ROLLBACK");

          return reply.status(409).send({
            error:
              "RECHARGE_POINT_NAME_ALREADY_EXISTS",

            message:
              "Ya existe una taquilla con ese nombre.",
          });
        }


        /*
         * -----------------------------------------------
         * CREAR TAQUILLA
         * -----------------------------------------------
         */

        const result =
          await client.query(
            `
            insert into recharge_points (
                recharge_code,
                name,
                status
            )
            values (
                $1,
                $2,
                'PENDING_SETUP'
            )

            returning
                id,
                recharge_code,
                name,
                status,
                created_at
            `,
            [
              rechargeCode,
              normalizedName,
            ]
          );


        const rechargePoint =
          result.rows[0];


        await client.query("COMMIT");


        return {

          created:
            true,

          rechargePoint: {

            id:
              rechargePoint.id,

            code:
              rechargePoint.recharge_code,

            name:
              rechargePoint.name,

            status:
              rechargePoint.status,

            createdAt:
              rechargePoint.created_at,
          },

          nextStep:
            "CREATE_RECHARGE_CARD",
        };


      } catch (error) {

        await client.query("ROLLBACK");

        server.log.error(
          error
        );

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
   * LISTAR TAQUILLAS
   * =====================================================
   *
   * GET /admin/recharge-points?deviceCode=...
   * =====================================================
   */

  server.get<{
    Querystring: {
      deviceCode?: string;
    };
  }>(
    "/admin/recharge-points",

    async (request, reply) => {

      const deviceCode =
        request.query.deviceCode;


      if (
        typeof deviceCode !== "string" ||
        deviceCode.trim().length === 0
      ) {

        return reply.status(400).send({
          error:
            "INVALID_DEVICE_CODE",
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


        if (
          admin === null
        ) {

          await client.query("ROLLBACK");

          return reply.status(403).send({
            error:
              "ADMIN_PERMISSION_REQUIRED",
          });
        }


        const result =
          await client.query(
            `
            select
                rp.id,
                rp.recharge_code,
                rp.name,
                rp.status,

                c.card_id,
                c.uid as recharge_card_uid,

                rc.status as recharge_card_status,

                rp.created_at

            from recharge_points rp

            /*
             * Tomamos una sola asignación por taquilla.
             *
             * Prioridad:
             * 1. tarjeta ACTIVE, si existe;
             * 2. si no existe una ACTIVE, la asignación
             *    más recientemente actualizada.
             *
             * Esto permite que ADMIN siga viendo una tarjeta
             * INACTIVE y pueda reactivarla.
             *
             * También deja preparado el listado para conservar
             * asignaciones históricas cuando más adelante una
             * tarjeta sea reemplazada.
             */
            left join lateral (
              select
                  rc_inner.card_id,
                  rc_inner.status,
                  rc_inner.created_at

              from recharge_cards rc_inner

              where rc_inner.recharge_point_id = rp.id

                and rc_inner.status in (
                    'ACTIVE',
                    'INACTIVE',
                    'BLOCKED'
                )

              order by
                  case
                      when rc_inner.status = 'ACTIVE' then 1
                      when rc_inner.status = 'INACTIVE' then 2
                      when rc_inner.status = 'BLOCKED' then 3
                      else 4
                  end,
                  rc_inner.created_at desc

              limit 1
          ) rc
              on true

            left join cards c
                on c.card_id = rc.card_id

            order by rp.created_at desc
            `
          );


        await client.query("COMMIT");


        return {

          rechargePoints:
            result.rows.map(
              (row: any) => ({

                id:
                  row.id,

                code:
                  row.recharge_code,

                name:
                  row.name,

                status:
                  row.status,

                card:
                  row.card_id !== null
                    ? {

                        cardId:
                          Number(
                            row.card_id
                          ),

                        uid:
                          row.recharge_card_uid,

                        status:
                          row.recharge_card_status,
                      }
                    : null,

                createdAt:
                  row.created_at,
              })
            ),
        };


      } catch (error) {

        await client.query("ROLLBACK");

        server.log.error(
          error
        );

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
   * EDITAR TAQUILLA
   * =====================================================
   *
   * PUT /admin/recharge-points/:rechargePointId
   *
   * Solo ADMIN.
   * Permite modificar el nombre visible de la taquilla.
   * La tarjeta física RECHARGE NO necesita reescribirse.
   * =====================================================
   */

  server.put<{
    Params: {
      rechargePointId: string;
    };
    Body: UpdateRechargePointBody;
  }>(
    "/admin/recharge-points/:rechargePointId",

    async (request, reply) => {

      const {
        rechargePointId,
      } = request.params;

      const {
        deviceCode,
        name,
      } = request.body;

      if (
        typeof rechargePointId !== "string" ||
        rechargePointId.trim().length === 0
      ) {
        return reply.status(400).send({
          error: "INVALID_RECHARGE_POINT_ID",
          message: "La taquilla no tiene un ID válido.",
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

      if (
        typeof name !== "string" ||
        name.trim().length < 2
      ) {
        return reply.status(400).send({
          error: "INVALID_RECHARGE_POINT_NAME",
          message: "El nombre de la taquilla debe contener al menos 2 caracteres.",
        });
      }

      const normalizedName =
        name.trim();

      const client =
        await db.connect();

      try {

        await client.query("BEGIN");

        const admin =
          await getAdminActor(
            client,
            deviceCode
          );

        if (
          admin === null
        ) {
          await client.query("ROLLBACK");

          return reply.status(403).send({
            error: "ADMIN_PERMISSION_REQUIRED",
            message: "Se necesita una sesión ADMIN activa.",
          });
        }

        const currentResult =
          await client.query(
            `
            select
                id,
                recharge_code,
                name,
                status

            from recharge_points

            where id = $1

            limit 1

            for update
            `,
            [
              rechargePointId.trim(),
            ]
          );

        if (
          currentResult.rowCount === 0
        ) {
          await client.query("ROLLBACK");

          return reply.status(404).send({
            error: "RECHARGE_POINT_NOT_FOUND",
            message: "No se encontró la taquilla.",
          });
        }

        const duplicateResult =
          await client.query(
            `
            select
                id

            from recharge_points

            where lower(name) = lower($1)
              and id <> $2

            limit 1
            `,
            [
              normalizedName,
              rechargePointId.trim(),
            ]
          );

        if (
          duplicateResult.rowCount &&
          duplicateResult.rowCount > 0
        ) {
          await client.query("ROLLBACK");

          return reply.status(409).send({
            error: "RECHARGE_POINT_NAME_ALREADY_EXISTS",
            message: "Ya existe otra taquilla con ese nombre.",
          });
        }

        const result =
          await client.query(
            `
            update recharge_points

            set
                name = $2,
                updated_at = now()

            where id = $1

            returning
                id,
                recharge_code,
                name,
                status,
                created_at
            `,
            [
              rechargePointId.trim(),
              normalizedName,
            ]
          );

        const rechargePoint =
          result.rows[0];

        await client.query("COMMIT");

        return {
          updated: true,

          rechargePoint: {
            id:
              rechargePoint.id,

            code:
              rechargePoint.recharge_code,

            name:
              rechargePoint.name,

            status:
              rechargePoint.status,

            createdAt:
              rechargePoint.created_at,
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
   * AUTORIZAR TARJETA RECHARGE
   * =====================================================
   *
   * POST /admin/recharge-points/card/authorize
   * =====================================================
   */

  server.post<{
    Body: PrepareRechargeCardBody;
  }>(
    "/admin/recharge-points/card/authorize",

    async (request, reply) => {

      const {
        idempotencyKey,
        deviceCode,
        rechargePointId,
        targetUid,
      } = request.body;


      /*
       * -----------------------------------------------
       * VALIDACIONES
       * -----------------------------------------------
       */

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
        typeof deviceCode !== "string" ||
        deviceCode.trim().length === 0
      ) {

        return reply.status(400).send({
          error:
            "INVALID_DEVICE_CODE",
        });
      }


      if (
        typeof rechargePointId !== "string" ||
        rechargePointId.trim().length === 0
      ) {

        return reply.status(400).send({
          error:
            "INVALID_RECHARGE_POINT_ID",
        });
      }


      if (
        typeof targetUid !== "string" ||
        targetUid.trim().length === 0
      ) {

        return reply.status(400).send({
          error:
            "INVALID_TARGET_UID",
        });
      }


      const normalizedUid =
        targetUid
          .trim()
          .toUpperCase();


      const client =
        await db.connect();


      try {

        await client.query("BEGIN");


        /*
         * -----------------------------------------------
         * IDEMPOTENCIA
         * -----------------------------------------------
         */

        const previousResult =
          await client.query(
            `
            select *

            from card_registrations

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

          const previous =
            previousResult.rows[0];


          await client.query("COMMIT");


          return {

            authorized:
              previous.status ===
              "PENDING",

            duplicated:
              true,

            registrationId:
              previous.id,

            status:
              previous.status,

            cardId:
              Number(
                previous.reserved_card_id
              ),

            uid:
              previous.target_uid,

            cardType:
              previous.target_card_type,

            rechargePointId:
              previous.recharge_point_id,

            initialState: {

              balance:
                0,

              transactionCounter:
                0,

              status:
                "ACTIVE",
            },
          };
        }


        /*
         * -----------------------------------------------
         * ADMIN
         * -----------------------------------------------
         */

        const admin =
          await getAdminActor(
            client,
            deviceCode
          );


        if (
          admin === null
        ) {

          await client.query("ROLLBACK");

          return reply.status(403).send({
            error:
              "ADMIN_PERMISSION_REQUIRED",
          });
        }


        /*
         * -----------------------------------------------
         * TAQUILLA
         * -----------------------------------------------
         */

        const rechargePointResult =
          await client.query(
            `
            select
                id,
                recharge_code,
                name,
                status

            from recharge_points

            where id = $1

            limit 1

            for update
            `,
            [
              rechargePointId,
            ]
          );


        if (
          rechargePointResult.rowCount ===
          0
        ) {

          await client.query("ROLLBACK");

          return reply.status(404).send({
            error:
              "RECHARGE_POINT_NOT_FOUND",
          });
        }


        const rechargePoint =
          rechargePointResult.rows[0];


        if (
          rechargePoint.status !==
          "PENDING_SETUP"
        ) {

          await client.query("ROLLBACK");

          return reply.status(409).send({

            error:
              "RECHARGE_POINT_NOT_PENDING_SETUP",

            status:
              rechargePoint.status,
          });
        }


        /*
         * -----------------------------------------------
         * YA TIENE TARJETA ACTIVA
         * -----------------------------------------------
         */

        const assignmentResult =
          await client.query(
            `
            select
                card_id

            from recharge_cards

            where recharge_point_id = $1

              and status = 'ACTIVE'

            limit 1
            `,
            [
              rechargePointId,
            ]
          );


        if (
          assignmentResult.rowCount &&
          assignmentResult.rowCount > 0
        ) {

          await client.query("ROLLBACK");

          return reply.status(409).send({
            error:
              "RECHARGE_POINT_ALREADY_HAS_CARD",
          });
        }


        /*
         * -----------------------------------------------
         * UID YA REGISTRADO
         * -----------------------------------------------
         */

        const existingCardResult =
          await client.query(
            `
            select
                card_id,
                card_type

            from cards

            where upper(uid) =
                  upper($1)

            limit 1
            `,
            [
              normalizedUid,
            ]
          );


        if (
          existingCardResult.rowCount &&
          existingCardResult.rowCount > 0
        ) {

          await client.query("ROLLBACK");

          return reply.status(409).send({
            error:
              "UID_ALREADY_REGISTERED",
          });
        }


        /*
         * -----------------------------------------------
         * UID YA TIENE REGISTRO PENDIENTE
         * -----------------------------------------------
         */

        const pendingUidResult =
          await client.query(
            `
            select
                id,
                reserved_card_id

            from card_registrations

            where upper(target_uid) =
                  upper($1)

              and status = 'PENDING'

            limit 1
            `,
            [
              normalizedUid,
            ]
          );


        if (
          pendingUidResult.rowCount &&
          pendingUidResult.rowCount > 0
        ) {

          await client.query("ROLLBACK");

          return reply.status(409).send({

            error:
              "UID_HAS_PENDING_REGISTRATION",

            registrationId:
              pendingUidResult.rows[0].id,
          });
        }


        /*
         * -----------------------------------------------
         * ¿TAQUILLA YA TIENE REGISTRO PENDING?
         * -----------------------------------------------
         */

        const pendingRechargeResult =
          await client.query(
            `
            select
                id,
                reserved_card_id

            from card_registrations

            where recharge_point_id = $1

              and target_card_type =
                  'RECHARGE'

              and status =
                  'PENDING'

            limit 1
            `,
            [
              rechargePointId,
            ]
          );


        if (
          pendingRechargeResult.rowCount &&
          pendingRechargeResult.rowCount > 0
        ) {

          await client.query("ROLLBACK");

          return reply.status(409).send({

            error:
              "RECHARGE_POINT_HAS_PENDING_REGISTRATION",

            registrationId:
              pendingRechargeResult.rows[0].id,
          });
        }


        /*
         * -----------------------------------------------
         * RESERVAR CARD ID
         * -----------------------------------------------
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


        /*
         * -----------------------------------------------
         * CREAR REGISTRO
         * -----------------------------------------------
         */

        const registrationResult =
          await client.query(
            `
            insert into card_registrations (
                idempotency_key,
                device_id,

                admin_card_id,

                actor_role,
                actor_card_id,

                target_uid,
                target_card_type,

                reserved_card_id,

                recharge_point_id,

                status
            )
            values (
                $1,
                $2,

                $3,

                'ADMIN',
                $3,

                $4,
                'RECHARGE',

                $5,

                $6,

                'PENDING'
            )

            returning *
            `,
            [
              idempotencyKey,
              admin.device_id,
              admin.admin_card_id,
              normalizedUid,
              reservedCardId,
              rechargePointId,
            ]
          );


        const registration =
          registrationResult.rows[0];


        await client.query("COMMIT");


        return {

          authorized:
            true,

          duplicated:
            false,

          registrationId:
            registration.id,

          status:
            registration.status,

          cardId:
            reservedCardId,

          uid:
            normalizedUid,

          cardType:
            "RECHARGE",

          rechargePoint: {

            id:
              rechargePoint.id,

            code:
              rechargePoint.recharge_code,

            name:
              rechargePoint.name,
          },

          initialState: {

            balance:
              0,

            transactionCounter:
              0,

            status:
              "ACTIVE",
          },
        };


      } catch (error: any) {

        await client.query("ROLLBACK");


        /*
         * Unique indexes / constraints.
         */
        if (
          error?.code ===
          "23505"
        ) {

          return reply.status(409).send({
            error:
              "RECHARGE_CARD_REGISTRATION_CONFLICT",
          });
        }


        server.log.error(
          error
        );


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
   * CONFIRMAR TARJETA RECHARGE
   * =====================================================
   *
   * POST /admin/recharge-points/card/confirm
   * =====================================================
   */

  server.post<{
    Body: ConfirmRechargeCardBody;
  }>(
    "/admin/recharge-points/card/confirm",

    async (request, reply) => {

      const {
        registrationId,
        deviceCode,
        targetUid,
        writtenCardId,
      } = request.body;


      if (
        typeof registrationId !== "string" ||
        registrationId.trim().length === 0
      ) {

        return reply.status(400).send({
          error:
            "INVALID_REGISTRATION_ID",
        });
      }


      if (
        typeof deviceCode !== "string" ||
        deviceCode.trim().length === 0
      ) {

        return reply.status(400).send({
          error:
            "INVALID_DEVICE_CODE",
        });
      }


      if (
        typeof targetUid !== "string" ||
        targetUid.trim().length === 0
      ) {

        return reply.status(400).send({
          error:
            "INVALID_TARGET_UID",
        });
      }


      if (
        !Number.isSafeInteger(
          writtenCardId
        ) ||
        writtenCardId <= 0
      ) {

        return reply.status(400).send({
          error:
            "INVALID_WRITTEN_CARD_ID",
        });
      }


      const client =
        await db.connect();


      try {

        await client.query("BEGIN");


        /*
         * -----------------------------------------------
         * REGISTRATION + RECHARGE POINT
         * -----------------------------------------------
         */

        const registrationResult =
          await client.query(
            `
            select
                r.*,

                d.device_code,

                rp.recharge_code,
                rp.name as recharge_point_name,
                rp.status as recharge_point_status

            from card_registrations r

            join devices d
                on d.id =
                   r.device_id

            join recharge_points rp
                on rp.id =
                   r.recharge_point_id

            where r.id = $1

            for update of r, rp
            `,
            [
              registrationId,
            ]
          );


        if (
          registrationResult.rowCount ===
          0
        ) {

          await client.query("ROLLBACK");

          return reply.status(404).send({
            error:
              "REGISTRATION_NOT_FOUND",
          });
        }


        const registration =
          registrationResult.rows[0];


        /*
         * -----------------------------------------------
         * DEVICE
         * -----------------------------------------------
         */

        if (
          registration.device_code !==
          deviceCode.trim()
        ) {

          await client.query("ROLLBACK");

          return reply.status(409).send({
            error:
              "REGISTRATION_DEVICE_MISMATCH",
          });
        }


        /*
         * -----------------------------------------------
         * CONFIRMACIÓN REPETIDA
         * -----------------------------------------------
         */

        if (
          registration.status ===
          "CONFIRMED"
        ) {

          await client.query("COMMIT");


          return {

            confirmed:
              true,

            duplicated:
              true,

            registrationId,

            cardId:
              Number(
                registration
                  .reserved_card_id
              ),

            rechargePoint: {

              id:
                registration.recharge_point_id,

              code:
                registration.recharge_code,

              name:
                registration.recharge_point_name,
            },
          };
        }


        if (
          registration.status !==
          "PENDING"
        ) {

          await client.query("ROLLBACK");

          return reply.status(409).send({

            error:
              "REGISTRATION_NOT_PENDING",

            status:
              registration.status,
          });
        }


        /*
         * -----------------------------------------------
         * TIPO
         * -----------------------------------------------
         */

        if (
          registration.target_card_type !==
          "RECHARGE"
        ) {

          await client.query("ROLLBACK");

          return reply.status(409).send({
            error:
              "REGISTRATION_NOT_RECHARGE",
          });
        }


        /*
         * -----------------------------------------------
         * ADMIN SIGUE ACTIVO
         * -----------------------------------------------
         */

        const admin =
          await getAdminActor(
            client,
            deviceCode
          );


        if (
          admin === null ||

          Number(
            admin.admin_card_id
          ) !==

          Number(
            registration.actor_card_id
          )
        ) {

          await client.query("ROLLBACK");

          return reply.status(403).send({
            error:
              "ADMIN_SESSION_NO_LONGER_ACTIVE",
          });
        }


        /*
         * -----------------------------------------------
         * VALIDAR NFC REPORTADO
         * -----------------------------------------------
         */

        if (
          Number(
            registration.reserved_card_id
          ) !==
          writtenCardId ||

          registration
            .target_uid
            .toUpperCase() !==

          targetUid
            .trim()
            .toUpperCase()
        ) {

          await client.query("ROLLBACK");

          return reply.status(409).send({
            error:
              "REGISTRATION_STATE_MISMATCH",
          });
        }


        /*
         * -----------------------------------------------
         * TAQUILLA TODAVÍA DEBE ESTAR PENDING
         * -----------------------------------------------
         */

        if (
          registration.recharge_point_status !==
          "PENDING_SETUP"
        ) {

          await client.query("ROLLBACK");

          return reply.status(409).send({

            error:
              "RECHARGE_POINT_NOT_PENDING_SETUP",

            status:
              registration.recharge_point_status,
          });
        }


        /*
         * -----------------------------------------------
         * CREAR CARD RECHARGE
         * -----------------------------------------------
         */

        await client.query(
          `
          insert into cards (
              card_id,
              uid,
              card_type,
              status,
              balance,
              transaction_counter
          )
          values (
              $1,
              $2,
              'RECHARGE',
              'ACTIVE',
              0,
              0
          )
          `,
          [
            writtenCardId,

            targetUid
              .trim()
              .toUpperCase(),
          ]
        );


        /*
         * -----------------------------------------------
         * ASIGNAR TARJETA A TAQUILLA
         * -----------------------------------------------
         */

        await client.query(
          `
          insert into recharge_cards (
              card_id,
              recharge_point_id,
              status
          )
          values (
              $1,
              $2,
              'ACTIVE'
          )
          `,
          [
            writtenCardId,
            registration.recharge_point_id,
          ]
        );


        /*
         * -----------------------------------------------
         * ACTIVAR TAQUILLA
         * -----------------------------------------------
         */

        await client.query(
          `
          update recharge_points

          set
              status =
                'ACTIVE',

              updated_at =
                now()

          where id = $1
          `,
          [
            registration.recharge_point_id,
          ]
        );


        /*
         * -----------------------------------------------
         * CONFIRMAR REGISTRO
         * -----------------------------------------------
         */

        await client.query(
          `
          update card_registrations

          set
              status =
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
            registrationId,
          ]
        );


        await client.query("COMMIT");


        return {

          confirmed:
            true,

          duplicated:
            false,

          registrationId,

          card: {

            cardId:
              writtenCardId,

            uid:
              targetUid
                .trim()
                .toUpperCase(),

            type:
              "RECHARGE",

            status:
              "ACTIVE",
          },

          rechargePoint: {

            id:
              registration.recharge_point_id,

            code:
              registration.recharge_code,

            name:
              registration.recharge_point_name,

            status:
              "ACTIVE",
          },
        };


      } catch (error: any) {

        await client.query("ROLLBACK");


        if (
          error?.code ===
          "23505"
        ) {

          return reply.status(409).send({
            error:
              "RECHARGE_CARD_ALREADY_EXISTS",
          });
        }


        server.log.error(
          error
        );


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
   *
   * POST /admin/recharge-points/card/fail
   * =====================================================
   */

  server.post<{
    Body: FailRechargeCardBody;
  }>(
    "/admin/recharge-points/card/fail",

    async (request, reply) => {

      const {
        registrationId,
        deviceCode,
        reason,
      } = request.body;


      const result =
        await db.query(
          `
          update card_registrations r

          set
              status =
                'FAILED',

              failed_at =
                now(),

              failure_reason =
                $3

          from devices d

          where r.device_id =
                d.id

            and r.id =
                $1

            and d.device_code =
                $2

            and r.target_card_type =
                'RECHARGE'

            and r.status =
                'PENDING'

          returning
              r.id,
              r.reserved_card_id,
              r.recharge_point_id
          `,
          [
            registrationId,

            deviceCode.trim(),

            reason ||
              "Fallo creando tarjeta RECHARGE.",
          ]
        );


      if (
        result.rowCount ===
        0
      ) {

        return reply.status(409).send({
          error:
            "REGISTRATION_CANNOT_BE_FAILED",
        });
      }


      return {

        failed:
          true,

        registrationId,

        cardId:
          Number(
            result.rows[0]
              .reserved_card_id
          ),

        rechargePointId:
          result.rows[0]
            .recharge_point_id,
      };
    }
  );
}