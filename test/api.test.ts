import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

// These tests run against a real Postgres. CI provides one as a service
// container; locally, point DATABASE_URL_TEST at a scratch database. There is
// no in-memory substitute, because the reconciliation query relies on NUMERIC,
// FULL OUTER JOIN and date_trunc behaving as Postgres defines them.
//
// The tests truncate every table, so they must never see the database behind
// the deployed demo. DATABASE_URL_TEST is preferred when it exists, and the
// before hook refuses to run against a database whose name does not end in
// "_test".
const envPath = resolve(process.cwd(), ".env");
if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}
process.env["DATABASE_URL"] = process.env["DATABASE_URL_TEST"] ?? process.env["DATABASE_URL"];

const { app } = await import("../src/app.js");
const { pool } = await import("../src/db.js");

let server: Server;
let baseUrl = "";

async function reset(): Promise<void> {
  await pool.query("TRUNCATE flows, reported_totals, clients, funds RESTART IDENTITY CASCADE");
  await pool.query(
    `INSERT INTO clients (name, currency) VALUES
       ('Northgate Advisers', 'GBP'),
       ('Tarn Capital', 'EUR')`,
  );
  await pool.query(
    `INSERT INTO funds (name, isin, currency) VALUES
       ('Evenlode Income', 'GB00B88MP089', 'GBP'),
       ('Nordkap Absolute Return', 'SE0013358126', 'SEK')`,
  );
}

const post = (path: string, body: unknown) =>
  fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const put = (path: string, body: unknown) =>
  fetch(`${baseUrl}${path}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

before(async () => {
  const { rows } = await pool.query<{ name: string }>("SELECT current_database() AS name");
  const name = rows[0]?.name ?? "";
  if (!name.endsWith("_test")) {
    throw new Error(
      `refusing to run destructive tests against database "${name}". ` +
        "Set DATABASE_URL_TEST to a database whose name ends in _test.",
    );
  }

  const schema = readFileSync(new URL("../db/schema.sql", import.meta.url), "utf8");
  await pool.query(schema);

  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

beforeEach(reset);

describe("health", () => {
  it("answers ok", async () => {
    const response = await fetch(`${baseUrl}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ok" });
  });

  it("serves the landing page at the root", async () => {
    const response = await fetch(`${baseUrl}/`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/html/);
    assert.match(await response.text(), /fund-flows API/);
  });
});

describe("clients", () => {
  it("lists clients in name order", async () => {
    const response = await fetch(`${baseUrl}/clients`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as Array<{ name: string }>;
    assert.deepEqual(
      body.map((client) => client.name),
      ["Northgate Advisers", "Tarn Capital"],
    );
  });

  it("returns 404 for a client that does not exist", async () => {
    const response = await fetch(`${baseUrl}/clients/999`);
    assert.equal(response.status, 404);
  });

  it("returns 400 for a non-numeric id", async () => {
    const response = await fetch(`${baseUrl}/clients/abc`);
    assert.equal(response.status, 400);
  });
});

describe("flows", () => {
  it("creates a flow", async () => {
    const response = await post("/flows", {
      clientId: 1,
      fundId: 1,
      month: "2026-09",
      amount: 1250.5,
    });
    assert.equal(response.status, 201);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body["clientId"], 1);
    assert.equal(body["month"], "2026-09");
    assert.equal(body["amount"], 1250.5);
  });

  it("rejects a month that is not a month", async () => {
    const response = await post("/flows", {
      clientId: 1,
      fundId: 1,
      month: "2026-13",
      amount: 10,
    });
    assert.equal(response.status, 400);
  });

  it("rejects a client that does not exist", async () => {
    const response = await post("/flows", {
      clientId: 999,
      fundId: 1,
      month: "2026-09",
      amount: 10,
    });
    assert.equal(response.status, 400);
    const body = (await response.json()) as { error: string };
    assert.match(body.error, /client or fund does not exist/);
  });

  it("filters by client and month", async () => {
    await post("/flows", { clientId: 1, fundId: 1, month: "2026-09", amount: 100 });
    await post("/flows", { clientId: 1, fundId: 2, month: "2026-10", amount: 200 });
    await post("/flows", { clientId: 2, fundId: 1, month: "2026-09", amount: 300 });

    const response = await fetch(`${baseUrl}/flows?clientId=1&month=2026-09`);
    const body = (await response.json()) as Array<{ amount: number }>;
    assert.equal(body.length, 1);
    assert.equal(body[0]?.amount, 100);
  });
});

describe("client summary", () => {
  it("totals the flows and compares them with the reported figure", async () => {
    await post("/flows", { clientId: 1, fundId: 1, month: "2026-09", amount: 1000 });
    await post("/flows", { clientId: 1, fundId: 2, month: "2026-09", amount: 500 });
    const putResponse = await put("/clients/1/reported-totals", {
      month: "2026-09",
      amount: 1200,
    });
    assert.equal(putResponse.status, 204);

    const response = await fetch(`${baseUrl}/clients/1/summary`);
    const body = (await response.json()) as {
      months: Array<{ month: string; actual: number; reported: number; difference: number }>;
      totals: { actual: number; reported: number; difference: number };
    };

    assert.equal(body.months.length, 1);
    assert.deepEqual(body.months[0], {
      month: "2026-09",
      actual: 1500,
      reported: 1200,
      difference: 300,
    });
    assert.deepEqual(body.totals, { actual: 1500, reported: 1200, difference: 300 });
  });

  it("returns 404 for a client that does not exist", async () => {
    const response = await fetch(`${baseUrl}/clients/999/summary`);
    assert.equal(response.status, 404);
  });
});

describe("reconciliation", () => {
  it("reports a month where the flows and the reported total disagree", async () => {
    await post("/flows", { clientId: 1, fundId: 1, month: "2026-09", amount: 1500 });
    await put("/clients/1/reported-totals", { month: "2026-09", amount: 1200 });

    const response = await fetch(`${baseUrl}/reconciliation`);
    const body = (await response.json()) as {
      count: number;
      discrepancies: Array<{ clientId: number; difference: number }>;
    };

    assert.equal(body.count, 1);
    assert.equal(body.discrepancies[0]?.clientId, 1);
    assert.equal(body.discrepancies[0]?.difference, 300);
  });

  it("stays quiet when the numbers agree", async () => {
    await post("/flows", { clientId: 1, fundId: 1, month: "2026-09", amount: 1500 });
    await put("/clients/1/reported-totals", { month: "2026-09", amount: 1500 });

    const response = await fetch(`${baseUrl}/reconciliation`);
    const body = (await response.json()) as { count: number };
    assert.equal(body.count, 0);
  });

  it("catches a reported month with no flows behind it", async () => {
    await put("/clients/2/reported-totals", { month: "2026-11", amount: 4200 });

    const response = await fetch(`${baseUrl}/reconciliation`);
    const body = (await response.json()) as {
      discrepancies: Array<{ clientId: number; actual: number; reported: number }>;
    };

    assert.equal(body.discrepancies.length, 1);
    assert.equal(body.discrepancies[0]?.actual, 0);
    assert.equal(body.discrepancies[0]?.reported, 4200);
  });

  it("filters by month", async () => {
    await post("/flows", { clientId: 1, fundId: 1, month: "2026-09", amount: 100 });
    await put("/clients/1/reported-totals", { month: "2026-09", amount: 50 });
    await post("/flows", { clientId: 1, fundId: 1, month: "2026-10", amount: 100 });
    await put("/clients/1/reported-totals", { month: "2026-10", amount: 50 });

    const response = await fetch(`${baseUrl}/reconciliation?month=2026-10`);
    const body = (await response.json()) as {
      count: number;
      discrepancies: Array<{ month: string }>;
    };

    assert.equal(body.count, 1);
    assert.equal(body.discrepancies[0]?.month, "2026-10");
  });
});
