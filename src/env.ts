import { existsSync } from "node:fs";
import { resolve } from "node:path";

// Node 22 and later can read a .env file without a dependency. Variables that
// are already set win, so CI can point DATABASE_URL at its own Postgres.
const path = resolve(process.cwd(), ".env");
if (existsSync(path)) {
  process.loadEnvFile(path);
}
