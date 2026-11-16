# fund-flows-api

A small TypeScript service for fund flows, client summaries and monthly
reconciliation. Node, Express 5, PostgreSQL, Zod validation, and tests that run
against a real database.

Live at <https://fund-flows-api-4q3k.onrender.com>. The free tier sleeps after
fifteen minutes of inactivity, so the first request can take about a minute to
wake up.

It exists because of a specific problem: a sales team records what a client's
month came to, and a system records the individual movements. When those two
numbers disagree, somebody has to find out where. Most of the interesting work
in a business like that is this kind of checking.

## The data

Three tables, and a fourth for the thing the business says separately.

- `clients` and `funds` are the reference data.
- `flows` holds individual movements against a client and a fund for a month.
  A flow belongs to a month, not a day, and a check constraint enforces that the
  stored date is the first of the month, so `GROUP BY month` cannot drift.
- `reported_totals` is what the sales team recorded for a client and month.

Keeping the reported figure in its own table is deliberate. If the flows table
held it too, a disagreement between the two would be impossible to represent,
which is exactly the case worth catching.

## Endpoints

| Method | Path | What it does |
| --- | --- | --- |
| GET | `/` | Landing page, with the reconciliation table fetched live |
| GET | `/health` | Liveness check |
| GET | `/clients` | All clients, by name |
| GET | `/clients/:id` | One client |
| GET | `/clients/:id/summary` | Month by month flows, reported totals and the difference |
| PUT | `/clients/:id/reported-totals` | Record what the business says a month came to |
| GET | `/funds` | All funds |
| GET | `/flows` | Flows, filtered by `clientId`, `fundId`, `month`, `limit` |
| POST | `/flows` | Record a movement |
| GET | `/reconciliation` | Every client and month where the two numbers disagree |

### What reconciliation actually compares

Sum the flows per client and month. Compare that with `reported_totals`. Return
the rows where they differ.

The join is a full outer join on purpose. An inner join would miss the two cases
that matter most: a month the business reported with no flows behind it, and a
month of flows nobody ever reported. Both appear in the seeded data.

Month filtering applies to both halves of the join. Filtering only the flows
side silently pulls in reported totals from months that should have been
excluded, which was a real bug here and is the reason one of the tests exists.

## Running it

```sh
npm install
cp .env.example .env        # then put a Postgres URL in DATABASE_URL
npm run db:setup            # creates the tables, safe to re-run
npm run seed                # fictional data, including two deliberate gaps
npm run dev                 # http://127.0.0.1:3000
```

The seed derives every reported total from the flows it just inserted, so the
data cannot drift from what it claims to describe. Two exceptions are planted
on purpose so `/reconciliation` has something to return.

## Tests

```sh
npm test
```

15 tests against a real Postgres, not a mock. The reconciliation query depends
on `NUMERIC` arithmetic, `date_trunc` and `FULL OUTER JOIN` behaving as Postgres
defines them, and a fake database would test the fake. Each test truncates and
re-seeds first, so they are order independent.

CI runs the suite on Node 22 and 24, each with a Postgres 16 service container,
after typechecking and building.

## Notes

- The month filter bug was found by the test suite, not by reading the query
  back. It is included here because the fix is the interesting part: filter both
  sides of the join, or the outer join reassembles what you excluded.
- No authentication. This is a portfolio service over fictional data, not
  something to point at the internet with real client records in it.
- Amounts are stored per client currency with no conversion. A real fund
  distribution platform would need an FX rate and a reporting currency.
- Schema is applied from `db/schema.sql`. Fine at this size, and honest about
  what it is: there is no migration runner yet.
