import {
  createHash,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from "node:crypto";


/*
 * =========================================================
 * DEVICE CREDENTIALS
 * =========================================================
 */


/*
 * Excluimos caracteres visualmente ambiguos:
 *
 * 0 / O
 * 1 / I
 *
 * para facilitar introducir el código manualmente.
 */
const PROVISIONING_ALPHABET =
  "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";


/*
 * =========================================================
 * SHA-256
 * =========================================================
 */

export function hashDeviceSecret(
  value: string
): string {

  return createHash(
    "sha256"
  )
    .update(
      value
    )
    .digest(
      "hex"
    );
}


/*
 * =========================================================
 * TOKEN PERMANENTE DEL ULEFONE
 * =========================================================
 *
 * El token real solamente será entregado una vez al
 * dispositivo.
 *
 * PostgreSQL guardará únicamente SHA-256(token).
 * =========================================================
 */

export function createDeviceToken():
  string {

  return randomBytes(
    32
  ).toString(
    "hex"
  );
}


/*
 * =========================================================
 * PROVISIONING CODE
 * =========================================================
 *
 * Formato:
 *
 * ABCD-EFGH-JKLM
 *
 * 12 caracteres aleatorios.
 * =========================================================
 */

function randomProvisioningBlock(
  length: number
): string {

  let result =
    "";


  for (
    let index = 0;
    index < length;
    index += 1
  ) {

    result +=
      PROVISIONING_ALPHABET[
        randomInt(
          PROVISIONING_ALPHABET
            .length
        )
      ];
  }


  return result;
}


export function createProvisioningCode():
  string {

  return [
    randomProvisioningBlock(
      4
    ),

    randomProvisioningBlock(
      4
    ),

    randomProvisioningBlock(
      4
    ),
  ].join(
    "-"
  );
}


/*
 * Permite que el usuario escriba:
 *
 * abcd-efgh-jklm
 *
 * o con espacios accidentales.
 */
export function normalizeProvisioningCode(
  value: string
): string {

  return value
    .trim()
    .toUpperCase()
    .replace(
      /\s+/g,
      ""
    );
}


/*
 * =========================================================
 * COMPARACIÓN SEGURA
 * =========================================================
 */

export function verifyDeviceSecret(
  secret: string,
  expectedHash: string
): boolean {

  try {

    const actualHash =
      hashDeviceSecret(
        secret
      );


    const actual =
      Buffer.from(
        actualHash,
        "hex"
      );


    const expected =
      Buffer.from(
        expectedHash,
        "hex"
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