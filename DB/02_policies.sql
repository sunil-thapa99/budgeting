-- Row Level Security: every user can only touch their own rows.
-- Run this AFTER 01_schema.sql.
--
-- The backend connects with the SERVICE ROLE key, which BYPASSES RLS — so the
-- server still scopes every query by user_id in application code (that is the real
-- guard). These policies are defense-in-depth: if anything ever hits Postgres with a
-- normal user's anon JWT (e.g. supabase-js directly from the browser), it stays isolated.
-- `with check` (not just `using`) also stops a user inserting rows tagged as someone else.

alter table budget_app_transactions        enable row level security;
alter table budget_app_budgets             enable row level security;
alter table budget_app_merchant_categories enable row level security;
alter table budget_app_category_rules      enable row level security;
alter table budget_app_accounts            enable row level security;

create policy "own rows" on budget_app_transactions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own rows" on budget_app_budgets
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own rows" on budget_app_merchant_categories
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own rows" on budget_app_category_rules
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own rows" on budget_app_accounts
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
