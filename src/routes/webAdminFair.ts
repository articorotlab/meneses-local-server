import type {
  FastifyInstance,
} from "fastify";

import {
  db,
} from "../db/database.js";

import {
  requireWebAdmin,
} from "../auth/webAdminSession.js";


type UpdateFairBody = {
  fairName?: string;
  locationName?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  country?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  mapsUrl?: string | null;
  phone?: string | null;
};


type FairHourInput = {
  dayOfWeek: number;
  opensAt: string | null;
  closesAt: string | null;
  isClosed: boolean;
};


type UpdateHoursBody = {
  hours?: FairHourInput[];
};


const FAIR_TIMEZONE =
  "America/Mexico_City";


function cleanNullableText(
  value:
    | string
    | null
    | undefined
): string | null {

  if (
    value === undefined ||
    value === null
  ) {
    return null;
  }


  const cleaned =
    value.trim();


  return cleaned.length > 0
    ? cleaned
    : null;
}


function isValidTime(
  value:
    | string
    | null
): boolean {

  if (
    value === null
  ) {
    return false;
  }


  return /^([01]\d|2[0-3]):[0-5]\d$/.test(
    value
  );
}


/*
 * =========================================================
 * WEB ADMIN FAIR ROUTES
 * =========================================================
 *
 * GET /web/admin/fair
 * PUT /web/admin/fair
 * PUT /web/admin/fair/hours
 *
 * Todas requieren sesión web ADMIN/OWNER.
 *
 * IMPORTANTE:
 * El estado abierto/cerrado ya no se administra
 * manualmente desde fair_settings.is_open.
 *
 * La fuente de verdad para operación es fair_hours.
 * =========================================================
 */

export async function webAdminFairRoutes(
  server: FastifyInstance
) {

  /*
   * =====================================================
   * GET CURRENT FAIR CONFIGURATION
   * =====================================================
   */

  server.get(
    "/web/admin/fair",

    async (
      request,
      reply
    ) => {

      const admin =
        await requireWebAdmin(
          request,
          reply
        );


      if (
        !admin
      ) {
        return;
      }


      const client =
        await db.connect();


      try {

        const settingsResult =
          await client.query(
            `
            select
                fair_name,
                location_name,
                address,
                city,
                state,
                country,
                latitude,
                longitude,
                maps_url,
                phone,
                updated_at

            from fair_settings

            where id = 1

            limit 1
            `
          );


        if (
          settingsResult.rowCount ===
          0
        ) {

          return reply
            .status(404)
            .send({
              error:
                "FAIR_SETTINGS_NOT_FOUND",
            });
        }


        const hoursResult =
          await client.query(
            `
            select
                day_of_week,
                opens_at,
                closes_at,
                is_closed

            from fair_hours

            order by day_of_week
            `
          );


        const settings =
          settingsResult.rows[0];


        return {
          timezone:
            FAIR_TIMEZONE,

          fair: {
            fairName:
              settings.fair_name,

            locationName:
              settings.location_name,

            address:
              settings.address,

            city:
              settings.city,

            state:
              settings.state,

            country:
              settings.country,

            latitude:
              settings.latitude ===
                null
                ? null
                : Number(
                    settings.latitude
                  ),

            longitude:
              settings.longitude ===
                null
                ? null
                : Number(
                    settings.longitude
                  ),

            mapsUrl:
              settings.maps_url,

            phone:
              settings.phone,

            updatedAt:
              settings.updated_at,

            hours:
              hoursResult.rows.map(
                (
                  row: any
                ) => ({

                  dayOfWeek:
                    Number(
                      row.day_of_week
                    ),

                  opensAt:
                    row.opens_at ===
                      null
                      ? null
                      : String(
                          row.opens_at
                        ).slice(
                          0,
                          5
                        ),

                  closesAt:
                    row.closes_at ===
                      null
                      ? null
                      : String(
                          row.closes_at
                        ).slice(
                          0,
                          5
                        ),

                  isClosed:
                    Boolean(
                      row.is_closed
                    ),
                })
              ),
          },

          admin: {
            id:
              admin.id,

            email:
              admin.email,

            role:
              admin.role,
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
   * UPDATE GENERAL FAIR SETTINGS
   * =====================================================
   */

  server.put<{
    Body:
      UpdateFairBody;
  }>(
    "/web/admin/fair",

    async (
      request,
      reply
    ) => {

      const admin =
        await requireWebAdmin(
          request,
          reply
        );


      if (
        !admin
      ) {
        return;
      }


      const body =
        request.body ??
        {};


      const fairName =
        body.fairName
          ?.trim();


      if (
        !fairName
      ) {

        return reply
          .status(400)
          .send({
            error:
              "INVALID_FAIR_NAME",

            message:
              "El nombre de la feria es obligatorio.",
          });
      }


      if (
        body.latitude !==
          undefined &&
        body.latitude !==
          null &&
        (
          body.latitude <
            -90 ||
          body.latitude >
            90
        )
      ) {

        return reply
          .status(400)
          .send({
            error:
              "INVALID_LATITUDE",
          });
      }


      if (
        body.longitude !==
          undefined &&
        body.longitude !==
          null &&
        (
          body.longitude <
            -180 ||
          body.longitude >
            180
        )
      ) {

        return reply
          .status(400)
          .send({
            error:
              "INVALID_LONGITUDE",
          });
      }


      const client =
        await db.connect();


      try {

        const result =
          await client.query(
            `
            update fair_settings

            set
                fair_name = $1,
                location_name = $2,
                address = $3,
                city = $4,
                state = $5,
                country = $6,
                latitude = $7,
                longitude = $8,
                maps_url = $9,
                phone = $10,
                updated_at = now()

            where id = 1

            returning
                fair_name,
                location_name,
                address,
                city,
                state,
                country,
                latitude,
                longitude,
                maps_url,
                phone,
                updated_at
            `,
            [
              fairName,

              cleanNullableText(
                body.locationName
              ),

              cleanNullableText(
                body.address
              ),

              cleanNullableText(
                body.city
              ),

              cleanNullableText(
                body.state
              ),

              cleanNullableText(
                body.country
              ) ??
                "México",

              body.latitude ??
                null,

              body.longitude ??
                null,

              cleanNullableText(
                body.mapsUrl
              ),

              cleanNullableText(
                body.phone
              ),
            ]
          );


        const row =
          result.rows[0];


        return {
          updated:
            true,

          fair: {
            fairName:
              row.fair_name,

            locationName:
              row.location_name,

            address:
              row.address,

            city:
              row.city,

            state:
              row.state,

            country:
              row.country,

            latitude:
              row.latitude ===
                null
                ? null
                : Number(
                    row.latitude
                  ),

            longitude:
              row.longitude ===
                null
                ? null
                : Number(
                    row.longitude
                  ),

            mapsUrl:
              row.maps_url,

            phone:
              row.phone,

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
   * UPDATE WEEKLY HOURS
   * =====================================================
   */

  server.put<{
    Body:
      UpdateHoursBody;
  }>(
    "/web/admin/fair/hours",

    async (
      request,
      reply
    ) => {

      const admin =
        await requireWebAdmin(
          request,
          reply
        );


      if (
        !admin
      ) {
        return;
      }


      const hours =
        request.body
          ?.hours;


      if (
        !Array.isArray(
          hours
        ) ||
        hours.length !==
          7
      ) {

        return reply
          .status(400)
          .send({
            error:
              "INVALID_HOURS",

            message:
              "Debes enviar exactamente los 7 días de la semana.",
          });
      }


      const days =
        hours.map(
          (
            hour
          ) =>
            hour.dayOfWeek
        );


      const uniqueDays =
        new Set(
          days
        );


      if (
        uniqueDays.size !==
          7 ||
        days.some(
          (
            day
          ) =>
            day <
              1 ||
            day >
              7
        )
      ) {

        return reply
          .status(400)
          .send({
            error:
              "INVALID_DAYS",
          });
      }


      for (
        const hour
        of hours
      ) {

        if (
          hour.isClosed
        ) {

          hour.opensAt =
            null;

          hour.closesAt =
            null;

          continue;
        }


        if (
          !isValidTime(
            hour.opensAt
          ) ||
          !isValidTime(
            hour.closesAt
          )
        ) {

          return reply
            .status(400)
            .send({
              error:
                "INVALID_TIME",

              dayOfWeek:
                hour.dayOfWeek,

              message:
                "El horario debe usar formato HH:MM.",
            });
        }
      }


      const client =
        await db.connect();


      try {

        await client.query(
          "begin"
        );


        try {

          for (
            const hour
            of hours
          ) {

            await client.query(
              `
              insert into fair_hours (
                  day_of_week,
                  opens_at,
                  closes_at,
                  is_closed,
                  updated_at
              )

              values (
                  $1,
                  $2,
                  $3,
                  $4,
                  now()
              )

              on conflict (
                  day_of_week
              )

              do update set
                  opens_at =
                    excluded.opens_at,

                  closes_at =
                    excluded.closes_at,

                  is_closed =
                    excluded.is_closed,

                  updated_at =
                    now()
              `,
              [
                hour.dayOfWeek,
                hour.opensAt,
                hour.closesAt,
                hour.isClosed,
              ]
            );
          }


          await client.query(
            `
            update fair_settings

            set
                updated_at =
                  now()

            where id = 1
            `
          );


          await client.query(
            "commit"
          );


        } catch (
          error
        ) {

          await client.query(
            "rollback"
          );


          throw error;
        }


        return {
          updated:
            true,

          hours:
            hours
              .sort(
                (
                  a,
                  b
                ) =>
                  a.dayOfWeek -
                  b.dayOfWeek
              ),
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
}
