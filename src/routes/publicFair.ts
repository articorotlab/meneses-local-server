import type {
  FastifyInstance,
} from "fastify";

import {
  db,
} from "../db/database.js";


/*
 * =========================================================
 * PUBLIC FAIR
 * =========================================================
 *
 * Endpoints públicos para el sitio web:
 *
 * GET /public/fair
 * GET /public/events
 *
 * No requieren sesión ADMIN.
 *
 * El estado abierto/cerrado se calcula automáticamente
 * usando fair_hours y la zona America/Mexico_City.
 * =========================================================
 */

const FAIR_TIMEZONE =
  "America/Mexico_City";


type PublicHour = {
  dayOfWeek: number;
  opensAt: string | null;
  closesAt: string | null;
  isClosed: boolean;
};


function timeToMinutes(
  value: string | null
): number | null {

  if (
    value === null
  ) {
    return null;
  }


  const [
    hours,
    minutes,
  ] =
    value
      .split(":")
      .map(
        Number
      );


  if (
    !Number.isFinite(
      hours
    ) ||
    !Number.isFinite(
      minutes
    )
  ) {
    return null;
  }


  return (
    hours * 60 +
    minutes
  );
}


function calculateIsOpen(
  hours: PublicHour[],
  currentDay: number,
  currentTime: string
): boolean {

  const currentMinutes =
    timeToMinutes(
      currentTime
    );


  if (
    currentMinutes ===
      null
  ) {
    return false;
  }


  const todayHours =
    hours.find(
      (
        item
      ) =>
        item.dayOfWeek ===
        currentDay
    ) ??
    null;


  if (
    todayHours &&
    !todayHours.isClosed
  ) {

    const opensAt =
      timeToMinutes(
        todayHours.opensAt
      );

    const closesAt =
      timeToMinutes(
        todayHours.closesAt
      );


    if (
      opensAt !==
        null &&
      closesAt !==
        null
    ) {

      /*
       * Horario normal:
       * 18:00 -> 23:00
       */
      if (
        opensAt <=
          closesAt &&
        currentMinutes >=
          opensAt &&
        currentMinutes <
          closesAt
      ) {
        return true;
      }


      /*
       * Horario que cruza medianoche:
       * 18:00 -> 01:00
       *
       * La parte anterior a medianoche pertenece
       * al día actual.
       */
      if (
        opensAt >
          closesAt &&
        currentMinutes >=
          opensAt
      ) {
        return true;
      }
    }
  }


  /*
   * Si el día anterior cruza medianoche,
   * la madrugada actual puede seguir perteneciendo
   * al horario operativo anterior.
   */
  const previousDay =
    currentDay ===
      1
      ? 7
      : currentDay -
        1;


  const previousHours =
    hours.find(
      (
        item
      ) =>
        item.dayOfWeek ===
        previousDay
    ) ??
    null;


  if (
    previousHours &&
    !previousHours.isClosed
  ) {

    const previousOpensAt =
      timeToMinutes(
        previousHours.opensAt
      );

    const previousClosesAt =
      timeToMinutes(
        previousHours.closesAt
      );


    if (
      previousOpensAt !==
        null &&
      previousClosesAt !==
        null &&
      previousOpensAt >
        previousClosesAt &&
      currentMinutes <
        previousClosesAt
    ) {
      return true;
    }
  }


  return false;
}


export async function publicFairRoutes(
  server: FastifyInstance
) {

  /*
   * =====================================================
   * INFORMACIÓN PÚBLICA DE LA FERIA
   * =====================================================
   *
   * GET /public/fair
   * =====================================================
   */

  server.get(
    "/public/fair",

    async (
      _request,
      reply
    ) => {

      const client =
        await db.connect();


      try {

        const settingsResult =
          await client.query(
            `
            select
                id,
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

              message:
                "No existe configuración pública de la feria.",
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


        const todayResult =
          await client.query(
            `
            select
                extract(
                  isodow from (
                    now()
                    at time zone $1
                  )
                )::integer as day_of_week,

                to_char(
                  (
                    now()
                    at time zone $1
                  )::date,
                  'YYYY-MM-DD'
                ) as local_date,

                to_char(
                  (
                    now()
                    at time zone $1
                  ),
                  'HH24:MI'
                ) as local_time
            `,
            [
              FAIR_TIMEZONE,
            ]
          );


        const settings =
          settingsResult.rows[0];


        const today =
          todayResult.rows[0];


        const hours:
          PublicHour[] =
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
            );


        const todayHours =
          hours.find(
            (
              item
            ) =>
              item.dayOfWeek ===
              Number(
                today.day_of_week
              )
          ) ??
          null;


        const isOpen =
          calculateIsOpen(
            hours,
            Number(
              today.day_of_week
            ),
            String(
              today.local_time
            )
          );


        return {
          timezone:
            FAIR_TIMEZONE,

          localDate:
            today.local_date,

          fair: {
            name:
              settings.fair_name,

            isOpen,

            phone:
              settings.phone,

            location: {
              name:
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
            },

            hours,

            todayHours,

            updatedAt:
              settings.updated_at,
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
   * EVENTOS PÚBLICOS
   * =====================================================
   *
   * GET /public/events
   *
   * Solo devuelve eventos:
   * - ACTIVE
   * - desde la fecha local actual en adelante
   * =====================================================
   */

  server.get(
    "/public/events",

    async (
      _request,
      reply
    ) => {

      const client =
        await db.connect();


      try {

        const result =
          await client.query(
            `
            select
                id,
                title,
                description,

                to_char(
                  event_date,
                  'YYYY-MM-DD'
                ) as event_date,

                start_time,
                end_time,
                image_url

            from fair_events

            where status =
                'ACTIVE'

              and event_date >=
                  (
                    now()
                    at time zone $1
                  )::date

            order by
                event_date asc,
                start_time asc nulls last
            `,
            [
              FAIR_TIMEZONE,
            ]
          );


        return {
          timezone:
            FAIR_TIMEZONE,

          events:
            result.rows.map(
              (
                row: any
              ) => ({

                id:
                  row.id,

                title:
                  row.title,

                description:
                  row.description,

                date:
                  row.event_date,

                startTime:
                  row.start_time ===
                    null
                    ? null
                    : String(
                        row.start_time
                      ).slice(
                        0,
                        5
                      ),

                endTime:
                  row.end_time ===
                    null
                    ? null
                    : String(
                        row.end_time
                      ).slice(
                        0,
                        5
                      ),

                imageUrl:
                  row.image_url,
              })
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
