-- Budget app — Supabase (Postgres) schema.
-- Run this FIRST in the Supabase SQL editor (Dashboard -> SQL -> New query), then 02_policies.sql.
-- Mirrors the old node:sqlite schema, with a user_id on every row for multi-user isolation.
-- All tables are prefixed budget_app_ so this app can share a Supabase project with others.
--
-- Notes on type choices:
--   amount  -> numeric (exact money; the backend parses it back to a JS number)
--   excluded-> integer 0/1 (kept as-is so the whole codebase's 0|1 checks are unchanged)
--   date    -> date     (the backend keeps it as a 'YYYY-MM-DD' string)
--   user_id -> references auth.users so a deleted user's data cascades away.

create table if not exists budget_app_transactions (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references auth.users(id) on delete cascade default auth.uid(),
  date        date not null,                          -- YYYY-MM-DD
  type        text not null default 'expense' check (type in ('expense','income')),
  amount      numeric not null,                       -- always positive
  category    text not null default 'Uncategorized',
  description text not null default '',
  method      text not null default '',               -- cash / card / bank ...
  source      text not null default 'manual',         -- manual | receipt | import | statement
  account     text not null default '',               -- e.g. "Discover", "Chase Checking"
  ext_id      text,                                   -- stable dedupe hash for imported rows
  excluded    integer not null default 0,             -- 1 = transfer/card-payment, ignored in totals
  parent_id   bigint references budget_app_transactions(id) on delete cascade,  -- set on split children
  created_at  timestamptz not null default now()
);
create index if not exists idx_tx_user_date   on budget_app_transactions(user_id, date);
create index if not exists idx_tx_user_parent on budget_app_transactions(user_id, parent_id);
-- Re-imports are idempotent: a row's ext_id is unique per user.
create unique index if not exists idx_tx_user_extid on budget_app_transactions(user_id, ext_id) where ext_id is not null;

-- Monthly expected/budget amount per category.
create table if not exists budget_app_budgets (
  user_id  uuid not null references auth.users(id) on delete cascade default auth.uid(),
  month    text not null,   -- 'YYYY-MM'
  category text not null,
  expected numeric not null default 0,
  primary key (user_id, month, category)
);

-- Learned merchant -> category memory (improves categorization from your edits).
create table if not exists budget_app_merchant_categories (
  user_id    uuid not null references auth.users(id) on delete cascade default auth.uid(),
  merchant   text not null,   -- normalized merchant key
  category   text not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, merchant)
);

-- User keyword rules (highest-priority categorization signal; token-prefix match).
create table if not exists budget_app_category_rules (
  user_id    uuid not null references auth.users(id) on delete cascade default auth.uid(),
  keyword    text not null,   -- stored uppercase
  category   text not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, keyword)
);

-- Per-account metadata (opening balance + kind). Accounts are discovered from transactions.account.
create table if not exists budget_app_accounts (
  user_id         uuid not null references auth.users(id) on delete cascade default auth.uid(),
  name            text not null,
  type            text not null default 'asset' check (type in ('asset','credit','investment','cash')),
  opening_balance numeric not null default 0,
  updated_at      timestamptz not null default now(),
  primary key (user_id, name)
);
