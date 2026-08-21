import type {
  FastifyInstance,
} from "fastify";

import {
  db,
} from "../db/database.js";


async function getAttractions() {

  const result =
    await db.query(
      `
      select
          a.id,
          a.name,

          coalesce(
            json_agg(
              json_build_object(
                'id',
                i.id,
                'url',
                i.image_url,
                'sortOrder',
                i.sort_order
              )
              order by
                i.sort_order asc,
                i.created_at asc
            )
            filter (
              where i.id is not null
            ),
            '[]'::json
          ) as images

      from fair_attractions a

      left join fair_attraction_images i
        on i.attraction_id = a.id

      group by
          a.id,
          a.name,
          a.sort_order,
          a.created_at

      order by
          a.sort_order asc,
          a.created_at asc
      `
    );


  return result.rows.map(
    (
      row:
        any
    ) => ({
      id:
        row.id,

      name:
        row.name,

      images:
        row.images,
    })
  );
}


/*
 * =========================================================
 * PUBLIC FAIR CONTENT
 * =========================================================
 *
 * GET /public/content
 * GET /public/attractions
 *
 * No requieren autenticación.
 * =========================================================
 */

export async function publicContentRoutes(
  server:
    FastifyInstance
) {

  /*
   * =====================================================
   * COVER + ATTRACTIONS
   * =====================================================
   */

  server.get(
    "/public/content",

    async (
      _request,
      reply
    ) => {

      try {

        const coverResult =
          await db.query(
            `
            select
                cover_image_url

            from fair_settings

            where id = 1

            limit 1
            `
          );


        return {
          coverImageUrl:
            coverResult.rows[0]
              ?.cover_image_url ??
            null,

          attractions:
            await getAttractions(),
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
      }
    }
  );


  /*
   * =====================================================
   * ATTRACTIONS ONLY
   * =====================================================
   */

  server.get(
    "/public/attractions",

    async (
      _request,
      reply
    ) => {

      try {

        return {
          attractions:
            await getAttractions(),
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
      }
    }
  );
}
