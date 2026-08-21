import type { FastifyInstance } from "fastify";

import {
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";

import { db } from "../db/database.js";


const SESSION_COOKIE_NAME =
  "meneses_web_session";

const SESSION_DURATION_SECONDS =
  60 * 60 * 24 * 7;


type LoginBody = {
  email?: string;
  password?: string;
};


/*
 * =========================================================
 * PASSWORD
 * =========================================================
 */

function verifyPassword(
  password: string,
  storedHash: string
): boolean {

  const parts =
    storedHash.split("$");

  if (
    parts.length !== 3 ||
    parts[0] !== "scrypt"
  ) {
    return false;
  }

  const saltHex =
    parts[1];

  const expectedHex =
    parts[2];

  try {

    const salt =
      Buffer.from(
        saltHex,
        "hex"
      );

    const expected =
      Buffer.from(
        expectedHex,
        "hex"
      );

    const actual =
      scryptSync(
        password,
        salt,
        expected.length
      );

    if (
      actual.length !==
      expected.length
    ) {
      return false;
    }

    return timingSafeEqual(
      actual,
      expected
    );

  } catch {

    return false;
  }
}


/*
 * =========================================================
 * SESSION TOKEN
 * =========================================================
 */

function createSessionToken(): string {

  return randomBytes(32)
    .toString("hex");
}


function hashSessionToken(
  token: string
): string {

  return createHash("sha256")
    .update(token)
    .digest("hex");
}


/*
 * =========================================================
 * WEB AUTH ROUTES
 * =========================================================
 *
 * POST /web/auth/login
 * GET  /web/auth/me
 * POST /web/auth/logout
 *
 * Requiere que @fastify/cookie esté registrado
 * antes de estas rutas.
 * =========================================================
 */

export async function webAuthRoutes(
  server: FastifyInstance
) {

  /*
   * =====================================================
   * LOGIN
   * =====================================================
   */
  server.post<{
    Body: LoginBody;
  }>(
    "/web/auth/login",

    async (
      request,
      reply
    ) => {

      const email =
        request.body
          ?.email
          ?.trim()
          .toLowerCase();

      const password =
        request.body
          ?.password;

      if (
        !email ||
        !password
      ) {
        return reply
          .status(400)
          .send({
            error:
              "INVALID_REQUEST",

            message:
              "Correo y contraseña son obligatorios.",
          });
      }

      const client =
        await db.connect();

      try {

        const userResult =
          await client.query(
            `
            select
                id,
                email,
                full_name,
                password_hash,
                role,
                status

            from web_admin_users

            where lower(email) =
                  lower($1)

            limit 1
            `,
            [
              email,
            ]
          );

        if (
          userResult.rowCount === 0
        ) {
          return reply
            .status(401)
            .send({
              error:
                "INVALID_CREDENTIALS",

              message:
                "Correo o contraseña incorrectos.",
            });
        }

        const user =
          userResult.rows[0];

        if (
          user.status !==
          "ACTIVE"
        ) {
          return reply
            .status(403)
            .send({
              error:
                "USER_NOT_ACTIVE",

              message:
                "Este usuario no está activo.",
            });
        }

        const validPassword =
          verifyPassword(
            password,
            user.password_hash
          );

        if (
          !validPassword
        ) {
          return reply
            .status(401)
            .send({
              error:
                "INVALID_CREDENTIALS",

              message:
                "Correo o contraseña incorrectos.",
            });
        }

        const sessionToken =
          createSessionToken();

        const tokenHash =
          hashSessionToken(
            sessionToken
          );

        await client.query(
          "begin"
        );

        try {

          /*
           * Limpiamos sesiones expiradas del usuario.
           */
          await client.query(
            `
            delete from web_admin_sessions

            where user_id = $1

              and (
                expires_at <= now()
                or revoked_at is not null
              )
            `,
            [
              user.id,
            ]
          );

          const sessionResult =
            await client.query(
              `
              insert into web_admin_sessions (
                user_id,
                token_hash,
                expires_at,
                user_agent,
                ip_address
              )
              values (
                $1,
                $2,
                now() +
                  ($3 * interval '1 second'),
                $4,
                $5
              )

              returning
                id,
                expires_at
              `,
              [
                user.id,
                tokenHash,
                SESSION_DURATION_SECONDS,
                request.headers[
                  "user-agent"
                ] ?? null,
                request.ip,
              ]
            );

          await client.query(
            `
            update web_admin_users

            set
                last_login_at = now(),
                updated_at = now()

            where id = $1
            `,
            [
              user.id,
            ]
          );

          await client.query(
            "commit"
          );

          reply.setCookie(
            SESSION_COOKIE_NAME,
            sessionToken,
            {
              path: "/",
              httpOnly: true,
              sameSite: "lax",

              /*
               * Local development uses HTTP.
               * Production must use HTTPS.
               */
              secure:
                process.env.NODE_ENV ===
                "production",

              maxAge:
                SESSION_DURATION_SECONDS,
            }
          );

          return {
            authenticated:
              true,

            user: {
              id:
                user.id,

              email:
                user.email,

              fullName:
                user.full_name,

              role:
                user.role,
            },

            session: {
              expiresAt:
                sessionResult
                  .rows[0]
                  .expires_at,
            },
          };

        } catch (error) {

          await client.query(
            "rollback"
          );

          throw error;
        }

      } catch (error) {

        server.log.error(
          error
        );

        return reply
          .status(500)
          .send({
            error:
              "INTERNAL_ERROR",

            message:
              "No fue posible iniciar sesión.",
          });

      } finally {

        client.release();
      }
    }
  );


  /*
   * =====================================================
   * CURRENT USER
   * =====================================================
   */
  server.get(
    "/web/auth/me",

    async (
      request,
      reply
    ) => {

      const token =
        request.cookies[
          SESSION_COOKIE_NAME
        ];

      if (
        !token
      ) {
        return reply
          .status(401)
          .send({
            authenticated:
              false,

            error:
              "AUTH_REQUIRED",
          });
      }

      const tokenHash =
        hashSessionToken(
          token
        );

      const client =
        await db.connect();

      try {

        const result =
          await client.query(
            `
            select
                s.id as session_id,
                s.expires_at,

                u.id as user_id,
                u.email,
                u.full_name,
                u.role,
                u.status

            from web_admin_sessions s

            join web_admin_users u
                on u.id =
                   s.user_id

            where s.token_hash = $1

              and s.revoked_at
                  is null

              and s.expires_at >
                  now()

            limit 1
            `,
            [
              tokenHash,
            ]
          );

        if (
          result.rowCount === 0
        ) {
          reply.clearCookie(
            SESSION_COOKIE_NAME,
            {
              path: "/",
            }
          );

          return reply
            .status(401)
            .send({
              authenticated:
                false,

              error:
                "SESSION_INVALID",
            });
        }

        const session =
          result.rows[0];

        if (
          session.status !==
          "ACTIVE"
        ) {
          reply.clearCookie(
            SESSION_COOKIE_NAME,
            {
              path: "/",
            }
          );

          return reply
            .status(403)
            .send({
              authenticated:
                false,

              error:
                "USER_NOT_ACTIVE",
            });
        }

        await client.query(
          `
          update web_admin_sessions

          set last_seen_at = now()

          where id = $1
          `,
          [
            session.session_id,
          ]
        );

        return {
          authenticated:
            true,

          user: {
            id:
              session.user_id,

            email:
              session.email,

            fullName:
              session.full_name,

            role:
              session.role,
          },

          session: {
            expiresAt:
              session.expires_at,
          },
        };

      } catch (error) {

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
   * LOGOUT
   * =====================================================
   */
  server.post(
    "/web/auth/logout",

    async (
      request,
      reply
    ) => {

      const token =
        request.cookies[
          SESSION_COOKIE_NAME
        ];

      /*
       * Logout es idempotente.
       * Aunque ya no exista una sesión, respondemos éxito.
       */
      if (
        token
      ) {

        const tokenHash =
          hashSessionToken(
            token
          );

        const client =
          await db.connect();

        try {

          await client.query(
            `
            update web_admin_sessions

            set
                revoked_at = now(),
                last_seen_at = now()

            where token_hash = $1

              and revoked_at
                  is null
            `,
            [
              tokenHash,
            ]
          );

        } catch (error) {

          server.log.error(
            error
          );

        } finally {

          client.release();
        }
      }

      reply.clearCookie(
        SESSION_COOKIE_NAME,
        {
          path: "/",
        }
      );

      return {
        loggedOut:
          true,
      };
    }
  );
}
