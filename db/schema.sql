-- The schema is small on purpose: three tables and a total that the business
-- records separately from the flows. Reconciliation is the comparison between
-- those two numbers.

CREATE TABLE IF NOT EXISTS clients (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  currency   CHAR(3) NOT NULL DEFAULT 'GBP',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS funds (
  id       SERIAL PRIMARY KEY,
  name     TEXT NOT NULL,
  isin     CHAR(12) NOT NULL UNIQUE,
  currency CHAR(3) NOT NULL
);

CREATE TABLE IF NOT EXISTS flows (
  id         SERIAL PRIMARY KEY,
  client_id  INTEGER NOT NULL REFERENCES clients (id) ON DELETE CASCADE,
  fund_id    INTEGER NOT NULL REFERENCES funds (id) ON DELETE RESTRICT,
  month      DATE NOT NULL,
  amount     NUMERIC(16, 2) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- A flow belongs to a month, not a day. Storing the first of the month keeps
  -- GROUP BY month honest and stops half-dated rows appearing later.
  CONSTRAINT flows_month_is_first_of_month CHECK (month = date_trunc('month', month)::date)
);

CREATE INDEX IF NOT EXISTS flows_client_month_idx ON flows (client_id, month);
CREATE INDEX IF NOT EXISTS flows_month_idx ON flows (month);

-- What the sales team's spreadsheet says the month came to. Kept apart from the
-- flows table because the two disagreeing is the point of the reconciliation
-- endpoint, and a single table could not represent a difference.
CREATE TABLE IF NOT EXISTS reported_totals (
  client_id INTEGER NOT NULL REFERENCES clients (id) ON DELETE CASCADE,
  month     DATE NOT NULL,
  amount    NUMERIC(16, 2) NOT NULL,

  PRIMARY KEY (client_id, month),
  CONSTRAINT reported_totals_month_is_first_of_month CHECK (month = date_trunc('month', month)::date)
);
