import type {
  FastifyInstance,
} from "fastify";

import {
  randomUUID,
} from "node:crypto";

import {
  mkdir,
  rm,
  unlink,
} from "node:fs/promises";

import {
  join,
  normalize,
} from "node:path";

import sharp from "sharp";

import {
  db,
} from "../db/database.js";

import {
  requireWebAdmin,
} from "../auth/webAdminSession.js";


const UPLOADS_ROOT =
  join(
    process.cwd(),
    "uploads"
  );


const FAIR_UPLOADS_ROOT =
  join(
    UPLOADS_ROOT,
    "fair"
  );


const COVER_DIRECTORY =
  join(
    FAIR_UPLOADS_ROOT,
    "cover"
  );


const ATTRACTIONS_DIRECTORY =
  join(
    FAIR_UPLOADS_ROOT,
    "attractions"
  );


const MAX_IMAGE_SIZE =
  20 * 1024 * 1024;


type CreateAttractionBody = {
  name?: string;
};


type UpdateAttractionBody = {
  name?: string;
};


function cleanName(
  value:
    | string
    | undefined
): string | null {

  if (
    typeof value !==
      "string"
  ) {
    return null;
  }


  const cleaned =
    value.trim();


  if (
    cleaned.length <
      2
  ) {
    return null;
  }


  return cleaned;
}


function isFileTooLargeError(
  server:
    FastifyInstance,
  error:
    unknown
): boolean {

  const multipartErrors =
    (
      server as FastifyInstance & {
        multipartErrors?: {
          RequestFileTooLargeError?: new (
            ...args: any[]
          ) => Error;
        };
      }
    )
      .multipartErrors;


  const RequestFileTooLargeError =
    multipartErrors
      ?.RequestFileTooLargeError;


  if (
    RequestFileTooLargeError &&
    error instanceof
      RequestFileTooLargeError
  ) {
    return true;
  }


  if (
    typeof error ===
      "object" &&
    error !==
      null &&
    "code" in error
  ) {

    return (
      (
        error as {
          code?: string;
        }
      ).code ===
        "FST_REQ_FILE_TOO_LARGE"
    );
  }


  return false;
}


function publicUrlToLocalPath(
  imageUrl:
    string
): string | null {

  const prefix =
    "/uploads/";


  if (
    !imageUrl.startsWith(
      prefix
    )
  ) {
    return null;
  }


  const relative =
    imageUrl.slice(
      prefix.length
    );


  const normalizedRelative =
    normalize(
      relative
    );


  if (
    normalizedRelative.startsWith(
      ".."
    )
  ) {
    return null;
  }


  return join(
    UPLOADS_ROOT,
    normalizedRelative
  );
}


async function deleteImageFile(
  imageUrl:
    string | null
) {

  if (
    !imageUrl
  ) {
    return;
  }


  const localPath =
    publicUrlToLocalPath(
      imageUrl
    );


  if (
    !localPath
  ) {
    return;
  }


  try {

    await unlink(
      localPath
    );

  } catch (
    _error
  ) {

    /*
     * El archivo puede no existir físicamente.
     *
     * La eliminación del registro de BD no debe fallar
     * únicamente por un archivo faltante.
     */
  }
}


async function readUploadedImage(
  request:
    Parameters<
      FastifyInstance["post"]
    >[1] extends never
      ? never
      : any
) {

  const file =
    await request.file({
      limits: {
        fileSize:
          MAX_IMAGE_SIZE,
        files:
          1,
      },
    });


  if (
    !file
  ) {

    throw new Error(
      "IMAGE_REQUIRED"
    );
  }


  if (
    !file.mimetype
      .startsWith(
        "image/"
      )
  ) {

    throw new Error(
      "INVALID_IMAGE_TYPE"
    );
  }


  const buffer =
    await file.toBuffer();


  if (
    buffer.length ===
      0
  ) {

    throw new Error(
      "EMPTY_IMAGE"
    );
  }


  return buffer;
}


async function optimizeCover(
  input:
    Buffer
) {

  return sharp(
    input
  )
    .rotate()
    .resize({
      width:
        1600,

      height:
        900,

      fit:
        "cover",

      position:
        "centre",
    })
    .webp({
      quality:
        82,
    })
    .toBuffer();
}


async function optimizeAttractionImage(
  input:
    Buffer
) {

  return sharp(
    input
  )
    .rotate()
    .resize({
      width:
        1200,

      height:
        900,

      fit:
        "inside",

      withoutEnlargement:
        true,
    })
    .webp({
      quality:
        82,
    })
    .toBuffer();
}


/*
 * =========================================================
 * WEB ADMIN CONTENT
 * =========================================================
 *
 * GET    /web/admin/content
 * PUT    /web/admin/content/cover
 *
 * POST   /web/admin/attractions
 * PUT    /web/admin/attractions/:attractionId
 * DELETE /web/admin/attractions/:attractionId
 *
 * POST   /web/admin/attractions/:attractionId/images
 * DELETE /web/admin/attractions/:attractionId/images/:imageId
 *
 * Todas requieren sesión WEB ADMIN/OWNER.
 * =========================================================
 */

export async function webAdminContentRoutes(
  server:
    FastifyInstance
) {

  /*
   * =====================================================
   * GET CONTENT
   * =====================================================
   */

  server.get(
    "/web/admin/content",

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

        const coverResult =
          await client.query(
            `
            select
                cover_image_url

            from fair_settings

            where id = 1

            limit 1
            `
          );


        const attractionsResult =
          await client.query(
            `
            select
                a.id,
                a.name,
                a.sort_order,
                a.created_at,
                a.updated_at,

                coalesce(
                  json_agg(
                    json_build_object(
                      'id',
                      i.id,
                      'url',
                      i.image_url,
                      'sortOrder',
                      i.sort_order,
                      'createdAt',
                      i.created_at
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
                a.created_at,
                a.updated_at

            order by
                a.sort_order asc,
                a.created_at asc
            `
          );


        return {
          coverImageUrl:
            coverResult.rows[0]
              ?.cover_image_url ??
            null,

          attractions:
            attractionsResult.rows.map(
              (
                row:
                  any
              ) => ({
                id:
                  row.id,

                name:
                  row.name,

                sortOrder:
                  Number(
                    row.sort_order
                  ),

                images:
                  row.images,

                createdAt:
                  row.created_at,

                updatedAt:
                  row.updated_at,
              })
            ),

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
   * UPDATE COVER
   * =====================================================
   */

  server.put(
    "/web/admin/content/cover",

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


      try {

        const input =
          await readUploadedImage(
            request
          );


        const optimized =
          await optimizeCover(
            input
          );


        await mkdir(
          COVER_DIRECTORY,
          {
            recursive:
              true,
          }
        );


        const filename =
          `cover-${Date.now()}.webp`;


        const localPath =
          join(
            COVER_DIRECTORY,
            filename
          );


        await sharp(
          optimized
        )
          .toFile(
            localPath
          );


        const imageUrl =
          `/uploads/fair/cover/${filename}`;


        const client =
          await db.connect();


        try {

          await client.query(
            "begin"
          );


          const previousResult =
            await client.query(
              `
              select
                  cover_image_url

              from fair_settings

              where id = 1

              for update
              `
            );


          const previousUrl =
            previousResult.rows[0]
              ?.cover_image_url ??
            null;


          await client.query(
            `
            update fair_settings

            set
                cover_image_url = $1,
                updated_at = now()

            where id = 1
            `,
            [
              imageUrl,
            ]
          );


          await client.query(
            "commit"
          );


          await deleteImageFile(
            previousUrl
          );


          return {
            updated:
              true,

            coverImageUrl:
              imageUrl,
          };


        } catch (
          error
        ) {

          await client.query(
            "rollback"
          );


          await deleteImageFile(
            imageUrl
          );


          throw error;


        } finally {

          client.release();
        }


      } catch (
        error:
          any
      ) {

        server.log.error(
          error
        );


        if (
          isFileTooLargeError(
            server,
            error
          )
        ) {

          return reply
            .status(413)
            .send({
              error:
                "IMAGE_TOO_LARGE",

              message:
                "La imagen no puede superar 20 MB.",
            });
        }


        if (
          error?.message ===
            "IMAGE_REQUIRED"
        ) {

          return reply
            .status(400)
            .send({
              error:
                "IMAGE_REQUIRED",

              message:
                "Debes seleccionar una imagen.",
            });
        }


        if (
          error?.message ===
            "INVALID_IMAGE_TYPE"
        ) {

          return reply
            .status(400)
            .send({
              error:
                "INVALID_IMAGE_TYPE",

              message:
                "El archivo seleccionado debe ser una imagen.",
            });
        }


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
   * CREATE ATTRACTION
   * =====================================================
   */

  server.post<{
    Body:
      CreateAttractionBody;
  }>(
    "/web/admin/attractions",

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


      const name =
        cleanName(
          request.body
            ?.name
        );


      if (
        !name
      ) {

        return reply
          .status(400)
          .send({
            error:
              "INVALID_ATTRACTION_NAME",

            message:
              "El nombre de la atracción debe tener al menos 2 caracteres.",
          });
      }


      try {

        const result =
          await db.query(
            `
            insert into fair_attractions (
                name,
                sort_order
            )

            values (
                $1,
                (
                  select
                      coalesce(
                        max(sort_order),
                        -1
                      ) + 1
                  from fair_attractions
                )
            )

            returning
                id,
                name,
                sort_order,
                created_at,
                updated_at
            `,
            [
              name,
            ]
          );


        const row =
          result.rows[0];


        return reply
          .status(201)
          .send({
            created:
              true,

            attraction: {
              id:
                row.id,

              name:
                row.name,

              sortOrder:
                Number(
                  row.sort_order
                ),

              images: [],

              createdAt:
                row.created_at,

              updatedAt:
                row.updated_at,
            },
          });


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
   * UPDATE ATTRACTION
   * =====================================================
   */

  server.put<{
    Params: {
      attractionId:
        string;
    };

    Body:
      UpdateAttractionBody;
  }>(
    "/web/admin/attractions/:attractionId",

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


      const name =
        cleanName(
          request.body
            ?.name
        );


      if (
        !name
      ) {

        return reply
          .status(400)
          .send({
            error:
              "INVALID_ATTRACTION_NAME",
          });
      }


      const result =
        await db.query(
          `
          update fair_attractions

          set
              name = $2,
              updated_at = now()

          where id = $1

          returning
              id,
              name,
              sort_order,
              created_at,
              updated_at
          `,
          [
            request.params
              .attractionId,

            name,
          ]
        );


      if (
        result.rowCount ===
          0
      ) {

        return reply
          .status(404)
          .send({
            error:
              "ATTRACTION_NOT_FOUND",
          });
      }


      const row =
        result.rows[0];


      return {
        updated:
          true,

        attraction: {
          id:
            row.id,

          name:
            row.name,

          sortOrder:
            Number(
              row.sort_order
            ),

          createdAt:
            row.created_at,

          updatedAt:
            row.updated_at,
        },
      };
    }
  );


  /*
   * =====================================================
   * DELETE ATTRACTION
   * =====================================================
   */

  server.delete<{
    Params: {
      attractionId:
        string;
    };
  }>(
    "/web/admin/attractions/:attractionId",

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

        await client.query(
          "begin"
        );


        const attractionResult =
          await client.query(
            `
            select
                id

            from fair_attractions

            where id = $1

            for update
            `,
            [
              request.params
                .attractionId,
            ]
          );


        if (
          attractionResult.rowCount ===
            0
        ) {

          await client.query(
            "rollback"
          );


          return reply
            .status(404)
            .send({
              error:
                "ATTRACTION_NOT_FOUND",
            });
        }


        const imagesResult =
          await client.query(
            `
            select
                image_url

            from fair_attraction_images

            where attraction_id = $1

            order by
                sort_order asc,
                created_at asc
            `,
            [
              request.params
                .attractionId,
            ]
          );


        const imageUrls:
          string[] =
            imagesResult.rows.map(
              (
                row:
                  any
              ) =>
                row.image_url
            );


        await client.query(
          `
          delete from fair_attractions

          where id = $1
          `,
          [
            request.params
              .attractionId,
          ]
        );


        await client.query(
          "commit"
        );


        for (
          const imageUrl
          of imageUrls
        ) {

          await deleteImageFile(
            imageUrl
          );
        }


        try {

          await rm(
            join(
              ATTRACTIONS_DIRECTORY,
              request.params
                .attractionId
            ),
            {
              recursive:
                true,

              force:
                true,
            }
          );

        } catch (
          _error
        ) {
          // Nada que hacer.
        }


        return {
          deleted:
            true,

          attractionId:
            request.params
              .attractionId,
        };


      } catch (
        error
      ) {

        await client.query(
          "rollback"
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
   * ADD ATTRACTION IMAGE
   * =====================================================
   */

  server.post<{
    Params: {
      attractionId:
        string;
    };
  }>(
    "/web/admin/attractions/:attractionId/images",

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


      const attractionResult =
        await db.query(
          `
          select
              id

          from fair_attractions

          where id = $1

          limit 1
          `,
          [
            request.params
              .attractionId,
          ]
        );


      if (
        attractionResult.rowCount ===
          0
      ) {

        return reply
          .status(404)
          .send({
            error:
              "ATTRACTION_NOT_FOUND",
          });
      }


      try {

        const input =
          await readUploadedImage(
            request
          );


        const optimized =
          await optimizeAttractionImage(
            input
          );


        const attractionDirectory =
          join(
            ATTRACTIONS_DIRECTORY,
            request.params
              .attractionId
          );


        await mkdir(
          attractionDirectory,
          {
            recursive:
              true,
          }
        );


        const imageId =
          randomUUID();


        const filename =
          `${imageId}.webp`;


        const localPath =
          join(
            attractionDirectory,
            filename
          );


        await sharp(
          optimized
        )
          .toFile(
            localPath
          );


        const imageUrl =
          `/uploads/fair/attractions/${request.params.attractionId}/${filename}`;


        try {

          const result =
            await db.query(
              `
              insert into fair_attraction_images (
                  id,
                  attraction_id,
                  image_url,
                  sort_order
              )

              values (
                  $1,
                  $2,
                  $3,
                  (
                    select
                        coalesce(
                          max(sort_order),
                          -1
                        ) + 1

                    from fair_attraction_images

                    where attraction_id = $2
                  )
              )

              returning
                  id,
                  image_url,
                  sort_order,
                  created_at
              `,
              [
                imageId,

                request.params
                  .attractionId,

                imageUrl,
              ]
            );


          const row =
            result.rows[0];


          return reply
            .status(201)
            .send({
              created:
                true,

              image: {
                id:
                  row.id,

                url:
                  row.image_url,

                sortOrder:
                  Number(
                    row.sort_order
                  ),

                createdAt:
                  row.created_at,
              },
            });


        } catch (
          error
        ) {

          await deleteImageFile(
            imageUrl
          );


          throw error;
        }


      } catch (
        error:
          any
      ) {

        server.log.error(
          error
        );


        if (
          isFileTooLargeError(
            server,
            error
          )
        ) {

          return reply
            .status(413)
            .send({
              error:
                "IMAGE_TOO_LARGE",

              message:
                "La imagen no puede superar 20 MB.",
            });
        }


        if (
          error?.message ===
            "IMAGE_REQUIRED"
        ) {

          return reply
            .status(400)
            .send({
              error:
                "IMAGE_REQUIRED",

              message:
                "Debes seleccionar una imagen.",
            });
        }


        if (
          error?.message ===
            "INVALID_IMAGE_TYPE"
        ) {

          return reply
            .status(400)
            .send({
              error:
                "INVALID_IMAGE_TYPE",

              message:
                "El archivo seleccionado debe ser una imagen.",
            });
        }


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
   * DELETE ATTRACTION IMAGE
   * =====================================================
   */

  server.delete<{
    Params: {
      attractionId:
        string;

      imageId:
        string;
    };
  }>(
    "/web/admin/attractions/:attractionId/images/:imageId",

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


      const result =
        await db.query(
          `
          delete from fair_attraction_images

          where id = $1

            and attraction_id = $2

          returning
              image_url
          `,
          [
            request.params
              .imageId,

            request.params
              .attractionId,
          ]
        );


      if (
        result.rowCount ===
          0
      ) {

        return reply
          .status(404)
          .send({
            error:
              "ATTRACTION_IMAGE_NOT_FOUND",
          });
      }


      const imageUrl =
        result.rows[0]
          .image_url;


      await deleteImageFile(
        imageUrl
      );


      return {
        deleted:
          true,

        imageId:
          request.params
            .imageId,
      };
    }
  );
}
