import type { FastifyInstance } from "fastify";
import { db } from "../db/database.js";

type CardParams = {
  cardId: string;
};

export async function cardRoutes(
  server: FastifyInstance
) {

  /*
   * =====================================================
   * OBTENER TARJETA POR CARD ID
   * =====================================================
   *
   * GET /cards/1
   */

  server.get<{
    Params: CardParams;
  }>(
    "/cards/:cardId",

    async (request, reply) => {

      const cardId =
        Number(request.params.cardId);

      if (
        !Number.isSafeInteger(cardId) ||
        cardId <= 0
      ) {

        return reply.status(400).send({
          error: "INVALID_CARD_ID",
          message:
            "El Card ID proporcionado no es válido.",
        });
      }

      const result =
        await db.query(
          `
          select
              card_id,
              uid,
              card_type,
              status,
              balance,
              transaction_counter,
              created_at,
              updated_at
          from cards
          where card_id = $1
          limit 1
          `,
          [cardId]
        );

      if (result.rowCount === 0) {

        return reply.status(404).send({
          error: "CARD_NOT_FOUND",
          message:
            "La tarjeta no existe en el servidor local.",
        });
      }

      const row =
        result.rows[0];

      return {
        cardId:
          Number(row.card_id),

        uid:
          row.uid,

        type:
          row.card_type,

        status:
          row.status,

        balance:
          Number(row.balance),

        transactionCounter:
          Number(
            row.transaction_counter
          ),

        createdAt:
          row.created_at,

        updatedAt:
          row.updated_at,
      };
    }
  );
}