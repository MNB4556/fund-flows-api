import { pool } from "../db.js";

// Fictional data. Amounts are in the client's currency, and every reported
// total is derived from the flows table rather than typed by hand, so the seed
// cannot drift away from the data it claims to describe. Two deliberate
// exceptions exist so /reconciliation has something to report, and both are
// marked below.

const clients = [
  ["Northgate Advisers", "GBP"],
  ["Brockwell Private Office", "GBP"],
  ["Halden Wealth", "GBP"],
  ["Tarn Capital", "EUR"],
] as const;

const funds = [
  ["Evenlode Income", "GB00B88MP089", "GBP"],
  ["Finserve Global Defence & Security", "SE0013358118", "SEK"],
  ["Ardtara Global Smaller Companies", "IE0005G1E9C9", "EUR"],
  ["Meridian UK Equity", "GB00B7T85249", "GBP"],
  ["Nordkap Absolute Return", "SE0013358126", "SEK"],
] as const;

const flows: Array<[string, string, string, number]> = [
  ["Northgate Advisers", "Evenlode Income", "2026-09", 250000],
  ["Northgate Advisers", "Meridian UK Equity", "2026-09", 120000],
  ["Northgate Advisers", "Evenlode Income", "2026-10", 180000],
  ["Northgate Advisers", "Meridian UK Equity", "2026-10", -45000],
  ["Brockwell Private Office", "Ardtara Global Smaller Companies", "2026-09", 90000],
  ["Brockwell Private Office", "Ardtara Global Smaller Companies", "2026-10", 110000],
  ["Brockwell Private Office", "Nordkap Absolute Return", "2026-10", 35000],
  ["Halden Wealth", "Finserve Global Defence & Security", "2026-09", 400000],
  ["Halden Wealth", "Finserve Global Defence & Security", "2026-10", 260000],
  ["Halden Wealth", "Nordkap Absolute Return", "2026-10", 40000],
  ["Tarn Capital", "Ardtara Global Smaller Companies", "2026-09", 75000],
];

const client = await pool.connect();
try {
  await client.query("BEGIN");
  await client.query("TRUNCATE flows, reported_totals, clients, funds RESTART IDENTITY CASCADE");

  for (const [name, currency] of clients) {
    await client.query("INSERT INTO clients (name, currency) VALUES ($1, $2)", [name, currency]);
  }
  for (const [name, isin, currency] of funds) {
    await client.query("INSERT INTO funds (name, isin, currency) VALUES ($1, $2, $3)", [
      name,
      isin,
      currency,
    ]);
  }
  for (const [clientName, fundName, month, amount] of flows) {
    await client.query(
      `INSERT INTO flows (client_id, fund_id, month, amount)
       SELECT c.id, f.id, $3::date, $4
         FROM clients c, funds f
        WHERE c.name = $1 AND f.name = $2`,
      [clientName, fundName, `${month}-01`, amount],
    );
  }

  // Every reported total starts as the sum of that client's flows for the month.
  await client.query(
    `INSERT INTO reported_totals (client_id, month, amount)
     SELECT client_id, month, SUM(amount)
       FROM flows
      GROUP BY client_id, month`,
  );

  // Deliberate mismatch one: sales recorded 1,250 more than the flows say.
  await client.query(
    `UPDATE reported_totals
        SET amount = amount + 1250.00
      WHERE month = '2026-10-01'
        AND client_id = (SELECT id FROM clients WHERE name = 'Halden Wealth')`,
  );

  // Deliberate mismatch two: a month the business reported with no flows behind it.
  await client.query(
    `INSERT INTO reported_totals (client_id, month, amount)
     VALUES ((SELECT id FROM clients WHERE name = 'Tarn Capital'), '2026-11-01', 4200.00)`,
  );

  await client.query("COMMIT");
  console.log("seeded 4 clients, 5 funds, 11 flows, 2 deliberate discrepancies");
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
  await pool.end();
}
