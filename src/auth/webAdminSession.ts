import {
  createHash,
} from "node:crypto";

import type {
  FastifyReply,
  FastifyRequest,
} from "fastify";

import { db } from "../db/database.js";


const SESSION_COOKIE_NAME =
  "meneses_web_session";


function hashSessionToken(
  token: string
): string {

  return createHash("sha256")
    .update(token)
    .digest("hex");
}


export type AuthenticatedWebAdmin = {
  id: string;
  email: string;
  fullName: string;
  role: "OWNER" | "ADMIN";
};


/*
 * =========================================================
 * REQUIRE WEB ADMIN
 * =========================================================
 *
 * Valida la cookie web_admin contra PostgreSQL.
 *
 * Devuelve:
 * - usuario autenticado, si la sesión es válida;
 * - null, si ya respondió 401/403.
 * =========================================================
 */

export async function requireWebAdmin(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<AuthenticatedWebAdmin | null> {

  const token =
    request.cookies[
      SESSION_COOKIE_NAME
    ];

  if (!token) {

    reply
      .status(401)
      .send({
        authenticated:
          false,

        error:
          "AUTH_REQUIRED",
      });

    return null;
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

      reply
        .status(401)
        .send({
          authenticated:
            false,

          error:
            "SESSION_INVALID",
        });

      return null;
    }

    const row =
      result.rows[0];

    if (
      row.status !==
      "ACTIVE"
    ) {

      reply.clearCookie(
        SESSION_COOKIE_NAME,
        {
          path: "/",
        }
      );

      reply
        .status(403)
        .send({
          authenticated:
            false,

          error:
            "USER_NOT_ACTIVE",
        });

      return null;
    }

    await client.query(
      `
      update web_admin_sessions

      set last_seen_at = now()

      where id = $1
      `,
      [
        row.session_id,
      ]
    );

    return {
      id:
        row.user_id,

      email:
        row.email,

      fullName:
        row.full_name,

      role:
        row.role,
    };

  } finally {

    client.release();
  }
}
