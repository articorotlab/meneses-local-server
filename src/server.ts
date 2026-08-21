import "dotenv/config";

import Fastify from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";

import {
  join,
} from "node:path";

import {
  db,
} from "./db/database.js";

import {
  cardRoutes,
} from "./routes/cards.js";

import {
  transactionRoutes,
} from "./routes/transactions.js";

import {
  deviceSessionRoutes,
} from "./routes/deviceSessions.js";

import {
  adminRoutes,
} from "./routes/admin.js";

import {
  customerSupportRoutes,
} from "./routes/customerSupport.js";

import {
  cardRegistrationRoutes,
} from "./routes/cardRegistrations.js";

import {
  gameManagementRoutes,
} from "./routes/gameManagement.js";

import {
  rechargeManagementRoutes,
} from "./routes/rechargeManagement.js";

import {
  adminCardManagementRoutes,
} from "./routes/adminCardManagement.js";

import {
  deviceManagementRoutes,
} from "./routes/deviceManagement.js";

import {
  deviceProvisioningRoutes,
} from "./routes/deviceProvisioning.js";

import {
  operationalSettingsRoutes,
} from "./routes/operationalSettings.js";

import {
  reportRoutes,
} from "./routes/reports.js";

import {
  publicFairRoutes,
} from "./routes/publicFair.js";

import {
  publicContentRoutes,
} from "./routes/publicContent.js";

import {
  webAuthRoutes,
} from "./routes/webAuth.js";

import {
  webAdminFairRoutes,
} from "./routes/webAdminFair.js";

import {
  webAdminReportRoutes,
} from "./routes/webAdminReports.js";

import {
  webAdminDeviceRoutes,
} from "./routes/webAdminDevices.js";

import {
  webAdminContentRoutes,
} from "./routes/webAdminContent.js";


const server =
  Fastify({
    logger:
      true,
  });


/*
 * =========================================================
 * HEALTH
 * =========================================================
 */

server.get(
  "/health",

  async (
    _request,
    reply
  ) => {

    try {

      const result =
        await db.query(
          `
          select
              now() as server_time
          `
        );


      return {
        status:
          "ok",

        service:
          "meneses-local-server",

        database:
          "connected",

        serverTime:
          result.rows[0]
            .server_time,
      };


    } catch (
      error
    ) {

      server.log.error(
        error
      );


      return reply
        .status(503)
        .send({
          status:
            "error",

          service:
            "meneses-local-server",

          database:
            "disconnected",
        });
    }
  }
);


/*
 * =========================================================
 * START
 * =========================================================
 */

async function start() {

  try {

    /*
     * =====================================================
     * ARCHIVOS ESTÁTICOS
     * =====================================================
     */

    await server.register(
      fastifyStatic,
      {
        root:
          join(
            process.cwd(),
            "uploads"
          ),

        prefix:
          "/uploads/",
      }
    );


    /*
     * =====================================================
     * MULTIPART
     * =====================================================
     */

    await server.register(
      multipart,
      {
        limits: {
          files:
            10,

          fileSize:
            20 * 1024 * 1024,
        },
      }
    );


    /*
     * =====================================================
     * TARJETAS
     * =====================================================
     */

    await server.register(
      cardRoutes
    );


    /*
     * =====================================================
     * TRANSACCIONES
     * =====================================================
     */

    await server.register(
      transactionRoutes
    );


    /*
     * =====================================================
     * SESIONES GAME / RECHARGE
     * =====================================================
     */

    await server.register(
      deviceSessionRoutes
    );


    /*
     * =====================================================
     * ADMIN ANDROID
     * =====================================================
     */

    await server.register(
      adminRoutes
    );


    /*
     * =====================================================
     * ATENCIÓN AL CLIENTE
     * =====================================================
     */

    await server.register(
      customerSupportRoutes
    );


    /*
     * =====================================================
     * REGISTRO GENERAL DE TARJETAS
     * =====================================================
     */

    await server.register(
      cardRegistrationRoutes
    );


    /*
     * =====================================================
     * GESTIÓN DE JUEGOS
     * =====================================================
     */

    await server.register(
      gameManagementRoutes
    );


    /*
     * =====================================================
     * GESTIÓN DE TAQUILLAS
     * =====================================================
     */

    await server.register(
      rechargeManagementRoutes
    );


    /*
     * =====================================================
     * GESTIÓN DE TARJETAS
     * =====================================================
     */

    await server.register(
      adminCardManagementRoutes
    );


    /*
     * =====================================================
     * GESTIÓN DE DISPOSITIVOS DESDE ADMIN ANDROID
     * =====================================================
     */

    await server.register(
      deviceManagementRoutes
    );


    /*
     * =====================================================
     * PROVISIONAMIENTO DEL ULEFONE
     * =====================================================
     */

    await server.register(
      deviceProvisioningRoutes
    );


    /*
     * =====================================================
     * CONFIGURACIÓN OPERATIVA
     * =====================================================
     */

    await server.register(
      operationalSettingsRoutes
    );


    /*
     * =====================================================
     * REPORTES ANDROID
     * =====================================================
     */

    await server.register(
      reportRoutes
    );


    /*
     * =====================================================
     * INFORMACIÓN PÚBLICA
     * =====================================================
     */

    await server.register(
      publicFairRoutes
    );


    await server.register(
      publicContentRoutes
    );


    /*
     * =====================================================
     * COOKIES WEB
     * =====================================================
     */

    await server.register(
      cookie
    );


    /*
     * =====================================================
     * AUTENTICACIÓN WEB
     * =====================================================
     */

    await server.register(
      webAuthRoutes
    );


    /*
     * =====================================================
     * CONFIGURACIÓN WEB
     * =====================================================
     */

    await server.register(
      webAdminFairRoutes
    );


    /*
     * =====================================================
     * REPORTES WEB
     * =====================================================
     */

    await server.register(
      webAdminReportRoutes
    );


    /*
     * =====================================================
     * DISPOSITIVOS WEB ADMIN
     * =====================================================
     */

    await server.register(
      webAdminDeviceRoutes
    );


    /*
     * =====================================================
     * CONTENIDO DEL SITIO WEB ADMIN
     * =====================================================
     */

    await server.register(
      webAdminContentRoutes
    );


    /*
     * =====================================================
     * SERVER
     * =====================================================
     */

    const port =
      Number(
        process.env.PORT
      ) ||
      3001;


    await server.listen({
      port,

      host:
        "0.0.0.0",
    });


    console.log("");

    console.log(
      "================================="
    );

    console.log(
      " MENESES LOCAL SERVER"
    );

    console.log(
      "================================="
    );

    console.log(
      ` API: http://localhost:${port}`
    );

    console.log(
      " Red local habilitada"
    );

    console.log(
      "================================="
    );

    console.log("");


  } catch (
    error
  ) {

    server.log.error(
      error
    );


    process.exit(
      1
    );
  }
}


start();
