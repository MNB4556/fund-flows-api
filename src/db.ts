import "./env.js";

import pg from "pg";

const { Pool } = pg;

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is not set. Copy .env.example to .env and fill it in.");
  }
  return url;
}

// One pool for the process. Neon's free tier allows a small number of
// connections, so the default is deliberately low rather than pg's ten.
export const pool = new Pool({
  connectionString: databaseUrl(),
  max: Number(process.env.PGPOOL_MAX ?? 5),
  idleTimeoutMillis: 10_000,
});

export async function closePool(): Promise<void> {
  await pool.end();
}
