import { readFileSync } from "node:fs";

import { pool } from "../db.js";

// Idempotent: every statement in schema.sql uses IF NOT EXISTS, so this is safe
// to run on a fresh database or an existing one.
const schema = readFileSync(new URL("../../db/schema.sql", import.meta.url), "utf8");

await pool.query(schema);
console.log("schema applied");
await pool.end();
