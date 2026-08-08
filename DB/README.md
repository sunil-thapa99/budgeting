# Supabase setup

SQL to run on your Supabase project, in order.

## 1. Create the project
1. Go to https://supabase.com → **New project**. Pick a region near you; save the DB password.
2. **SQL Editor → New query** → paste [`01_schema.sql`](01_schema.sql) → **Run**.
3. New query → paste [`02_policies.sql`](02_policies.sql) → **Run**.

## 2. Auth settings
- **Authentication → Providers → Email**: keep enabled.
- For instant login on a personal app, **Authentication → Sign In / Providers → turn OFF "Confirm email"**.
  (Leave it ON if you want email verification — you'll then confirm via the link before first login.)

## 3. Keys (put these in your env files, never commit them)
Find them under **Project Settings → API** and **Project Settings → Database**.

| Where | Var | Value |
|-------|-----|-------|
| `server/.env` | `DATABASE_URL` | Settings → Database → Connection string → **URI** (use the **Session/Transaction pooler** string; add your DB password). |
| `server/.env` | `SUPABASE_URL` | Settings → API → Project URL |
| `server/.env` | `SUPABASE_SERVICE_ROLE_KEY` | Settings → API → `service_role` key (**secret — backend only**) |
| `web/.env`    | `VITE_SUPABASE_URL` | same Project URL |
| `web/.env`    | `VITE_SUPABASE_ANON_KEY` | Settings → API → `anon` `public` key |

The `service_role` key bypasses RLS and must **only** live on the backend. The `anon` key is
safe in the browser (RLS + the backend's own auth gate protect the data).

## Re-running
Every statement is idempotent (`create table if not exists`, `create index if not exists`).
The policies in `02_policies.sql` are not guarded — if you re-run it, drop the old ones first
(e.g. `drop policy "own rows" on budget_app_transactions;`) or just skip it.
