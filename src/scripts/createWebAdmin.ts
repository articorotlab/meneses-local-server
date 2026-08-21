import "dotenv/config";
import {
  randomBytes,
  scryptSync,
} from "node:crypto";

import { db } from "../db/database.js";

/*
 * =========================================================
 * CREATE WEB ADMIN
 * =========================================================
 *
 * Uso:
 *
 * npm run create:web-admin -- \
 *   admin@meneses.mx \
 *   "Nombre del dueño" \
 *   "ContraseñaSegura"
 *
 * La contraseña NO se guarda en texto plano.
 * =========================================================
 */

function hashPassword(
  password: string
): string {

  const salt =
    randomBytes(16);

  const derivedKey =
    scryptSync(
      password,
      salt,
      64
    );

  return [
    "scrypt",
    salt.toString("hex"),
    derivedKey.toString("hex"),
  ].join("$");
}


async function main() {

  const [
    emailRaw,
    fullNameRaw,
    password,
  ] =
    process.argv.slice(2);

  const email =
    emailRaw
      ?.trim()
      .toLowerCase();

  const fullName =
    fullNameRaw
      ?.trim();

  if (
    !email ||
    !email.includes("@")
  ) {
    throw new Error(
      "Debes indicar un correo válido."
    );
  }

  if (
    !fullName
  ) {
    throw new Error(
      "Debes indicar el nombre del usuario."
    );
  }

  if (
    !password ||
    password.length < 12
  ) {
    throw new Error(
      "La contraseña debe tener al menos 12 caracteres."
    );
  }

  const passwordHash =
    hashPassword(
      password
    );

  const client =
    await db.connect();

  try {

    const result =
      await client.query(
        `
        insert into web_admin_users (
          email,
          full_name,
          password_hash,
          role,
          status
        )
        values (
          $1,
          $2,
          $3,
          'OWNER',
          'ACTIVE'
        )

        on conflict (
          lower(email)
        )
        do nothing

        returning
          id,
          email,
          full_name,
          role,
          status
        `,
        [
          email,
          fullName,
          passwordHash,
        ]
      );

    if (
      result.rowCount === 0
    ) {
      throw new Error(
        "Ya existe un usuario con ese correo."
      );
    }

    console.log(
      "Usuario OWNER creado correctamente:"
    );

    console.log(
      result.rows[0]
    );

  } finally {

    client.release();

    await db.end();
  }
}


main()
  .catch(
    (error) => {

      console.error(
        error
      );

      process.exit(1);
    }
  );