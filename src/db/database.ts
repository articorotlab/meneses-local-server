import pg from "pg";

const { Pool } = pg;

export const db = new Pool({
  host: process.env.DATABASE_HOST,
  port: Number(process.env.DATABASE_PORT),
  database: process.env.DATABASE_NAME,
  user: process.env.DATABASE_USER,
  password: process.env.DATABASE_PASSWORD,
  max: 10,
});

db.on("error", (error) => {
  console.error("Unexpected PostgreSQL error:", error);
});
