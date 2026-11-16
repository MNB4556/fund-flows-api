import express from "express";
import type { ErrorRequestHandler } from "express";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import {
  clientSummary,
  createFlow,
  getClient,
  listClients,
  listFlows,
  listFunds,
  reconciliation,
  upsertReportedTotal,
} from "./queries.js";

const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "expected YYYY-MM");
const id = z.coerce.number().int().positive();

const flowBody = z.object({
  clientId: z.number().int().positive(),
  fundId: z.number().int().positive(),
  month,
  amount: z.number().finite(),
});

const reportedBody = z.object({ month, amount: z.number().finite() });

const flowQuery = z.object({
  clientId: id.optional(),
  fundId: id.optional(),
  month: month.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

const issueList = (error: z.ZodError) =>
  error.issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
  }));

export const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "32kb" }));

// The build copies src/static into dist/static, so the same relative URL works
// whether this file is running from src (tsx) or dist (node).
const landingPage = fileURLToPath(new URL("./static/index.html", import.meta.url));

app.get("/", (_req, res) => {
  res.sendFile(landingPage);
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.get("/clients", async (_req, res) => {
  res.json(await listClients());
});

app.get("/clients/:id", async (req, res) => {
  const parsed = id.safeParse(req.params.id);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid client id" });
    return;
  }
  const client = await getClient(parsed.data);
  if (!client) {
    res.status(404).json({ error: "client not found" });
    return;
  }
  res.json(client);
});

app.get("/clients/:id/summary", async (req, res) => {
  const parsed = id.safeParse(req.params.id);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid client id" });
    return;
  }
  const client = await getClient(parsed.data);
  if (!client) {
    res.status(404).json({ error: "client not found" });
    return;
  }
  res.json({ client, ...(await clientSummary(parsed.data)) });
});

app.put("/clients/:id/reported-totals", async (req, res) => {
  const parsedId = id.safeParse(req.params.id);
  if (!parsedId.success) {
    res.status(400).json({ error: "invalid client id" });
    return;
  }
  const parsedBody = reportedBody.safeParse(req.body);
  if (!parsedBody.success) {
    res.status(400).json({ error: "invalid request", issues: issueList(parsedBody.error) });
    return;
  }
  const client = await getClient(parsedId.data);
  if (!client) {
    res.status(404).json({ error: "client not found" });
    return;
  }
  await upsertReportedTotal(parsedId.data, parsedBody.data.month, parsedBody.data.amount);
  res.status(204).end();
});

app.get("/funds", async (_req, res) => {
  res.json(await listFunds());
});

app.get("/flows", async (req, res) => {
  const parsed = flowQuery.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid query", issues: issueList(parsed.error) });
    return;
  }
  res.json(await listFlows(parsed.data));
});

app.post("/flows", async (req, res) => {
  const parsed = flowBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid request", issues: issueList(parsed.error) });
    return;
  }
  try {
    const flow = await createFlow(parsed.data);
    res.status(201).json(flow);
  } catch (error) {
    // The client or fund id is not in its table. A foreign key violation is a
    // bad request, not a server fault.
    if (isForeignKeyViolation(error)) {
      res.status(400).json({ error: "client or fund does not exist" });
      return;
    }
    throw error;
  }
});

app.get("/reconciliation", async (req, res) => {
  const parsed = z.object({ month: month.optional() }).safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid query", issues: issueList(parsed.error) });
    return;
  }
  const rows = await reconciliation(parsed.data.month);
  res.json({ discrepancies: rows, count: rows.length });
});

app.use((_req, res) => {
  res.status(404).json({ error: "not found" });
});

const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: "internal server error" });
};
app.use(errorHandler);

function isForeignKeyViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "23503"
  );
}
