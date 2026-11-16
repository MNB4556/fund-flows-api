import { pool } from "./db.js";

export interface Client {
  id: number;
  name: string;
  currency: string;
}

export interface Fund {
  id: number;
  name: string;
  isin: string;
  currency: string;
}

export interface Flow {
  id: number;
  clientId: number;
  fundId: number;
  month: string;
  amount: number;
}

interface FlowRow {
  id: number;
  clientId: number;
  fundId: number;
  month: string;
  amount: string;
}

export interface MonthSummary {
  month: string;
  actual: number;
  reported: number;
  difference: number;
}

export interface ClientSummary {
  months: MonthSummary[];
  totals: { actual: number; reported: number; difference: number };
}

export interface Discrepancy {
  clientId: number;
  clientName: string;
  month: string;
  actual: number;
  reported: number;
  difference: number;
}

const toNumber = (value: string | number): number =>
  typeof value === "number" ? value : Number(value);

const rowToFlow = (row: FlowRow): Flow => ({ ...row, amount: toNumber(row.amount) });

export async function listClients(): Promise<Client[]> {
  const { rows } = await pool.query<Client>(
    "SELECT id, name, currency FROM clients ORDER BY name",
  );
  return rows;
}

export async function getClient(id: number): Promise<Client | undefined> {
  const { rows } = await pool.query<Client>(
    "SELECT id, name, currency FROM clients WHERE id = $1",
    [id],
  );
  return rows[0];
}

export async function listFunds(): Promise<Fund[]> {
  const { rows } = await pool.query<Fund>(
    "SELECT id, name, isin, currency FROM funds ORDER BY name",
  );
  return rows;
}

export interface FlowFilters {
  clientId?: number;
  fundId?: number;
  month?: string;
  limit: number;
}

export async function listFlows(filters: FlowFilters): Promise<Flow[]> {
  const where: string[] = [];
  const params: (number | string)[] = [];

  if (filters.clientId !== undefined) {
    params.push(filters.clientId);
    where.push(`client_id = $${params.length}`);
  }
  if (filters.fundId !== undefined) {
    params.push(filters.fundId);
    where.push(`fund_id = $${params.length}`);
  }
  if (filters.month !== undefined) {
    params.push(`${filters.month}-01`);
    where.push(`month = $${params.length}::date`);
  }

  params.push(filters.limit);

  const { rows } = await pool.query<FlowRow>(
    `SELECT id,
            client_id AS "clientId",
            fund_id   AS "fundId",
            to_char(month, 'YYYY-MM') AS month,
            amount
       FROM flows
       ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY month DESC, id DESC
       LIMIT $${params.length}`,
    params,
  );
  return rows.map(rowToFlow);
}

export interface NewFlow {
  clientId: number;
  fundId: number;
  month: string;
  amount: number;
}

export async function createFlow(flow: NewFlow): Promise<Flow> {
  const { rows } = await pool.query<FlowRow>(
    `INSERT INTO flows (client_id, fund_id, month, amount)
     VALUES ($1, $2, $3::date, $4)
     RETURNING id,
               client_id AS "clientId",
               fund_id   AS "fundId",
               to_char(month, 'YYYY-MM') AS month,
               amount`,
    [flow.clientId, flow.fundId, `${flow.month}-01`, flow.amount],
  );
  const row = rows[0];
  if (!row) {
    throw new Error("insert returned no row");
  }
  return rowToFlow(row);
}

export async function upsertReportedTotal(
  clientId: number,
  month: string,
  amount: number,
): Promise<void> {
  await pool.query(
    `INSERT INTO reported_totals (client_id, month, amount)
     VALUES ($1, $2::date, $3)
     ON CONFLICT (client_id, month) DO UPDATE SET amount = EXCLUDED.amount`,
    [clientId, `${month}-01`, amount],
  );
}

export async function clientSummary(clientId: number): Promise<ClientSummary> {
  // The left join means a month with flows but no reported total still appears,
  // with the reported side at zero. That is the case worth seeing.
  const { rows } = await pool.query<{ month: string; actual: string; reported: string }>(
    `SELECT to_char(f.month, 'YYYY-MM') AS month,
            SUM(f.amount)                AS actual,
            COALESCE(MAX(r.amount), 0)   AS reported
       FROM flows f
       LEFT JOIN reported_totals r
              ON r.client_id = f.client_id
             AND r.month = f.month
      WHERE f.client_id = $1
      GROUP BY f.month
      ORDER BY f.month`,
    [clientId],
  );

  const months: MonthSummary[] = rows.map((row) => {
    const actual = toNumber(row.actual);
    const reported = toNumber(row.reported);
    return { month: row.month, actual, reported, difference: actual - reported };
  });

  const totals = months.reduce(
    (acc, month) => ({
      actual: acc.actual + month.actual,
      reported: acc.reported + month.reported,
      difference: acc.difference + month.difference,
    }),
    { actual: 0, reported: 0, difference: 0 },
  );

  return { months, totals };
}

export async function reconciliation(month?: string): Promise<Discrepancy[]> {
  // SUM over flows versus what was reported. A full outer join is deliberate:
  // it catches reported months with no flows, and flow months with no report.
  // The month filter has to apply to both sides, or a full outer join pulls in
  // reported totals from months that were supposed to be excluded.
  const { rows } = await pool.query<{
    clientId: number;
    clientName: string;
    month: string;
    actual: string;
    reported: string;
    difference: string;
  }>(
    `WITH actual AS (
       SELECT client_id, month, SUM(amount) AS amount
         FROM flows
        WHERE ($1::date IS NULL OR month = $1::date)
        GROUP BY client_id, month
     ),
     reported AS (
       SELECT client_id, month, amount
         FROM reported_totals
        WHERE ($1::date IS NULL OR month = $1::date)
     ),
     combined AS (
       SELECT COALESCE(a.client_id, r.client_id) AS client_id,
              COALESCE(a.month, r.month)         AS month,
              COALESCE(a.amount, 0)              AS actual,
              COALESCE(r.amount, 0)              AS reported
         FROM actual a
         FULL OUTER JOIN reported r
           ON r.client_id = a.client_id
          AND r.month = a.month
     )
     SELECT c.client_id              AS "clientId",
            cl.name                  AS "clientName",
            to_char(c.month, 'YYYY-MM') AS month,
            c.actual,
            c.reported,
            c.actual - c.reported    AS difference
       FROM combined c
       JOIN clients cl ON cl.id = c.client_id
      WHERE c.actual <> c.reported
      ORDER BY c.month DESC, cl.name`,
    [month ? `${month}-01` : null],
  );

  return rows.map((row) => ({
    clientId: row.clientId,
    clientName: row.clientName,
    month: row.month,
    actual: toNumber(row.actual),
    reported: toNumber(row.reported),
    difference: toNumber(row.difference),
  }));
}
