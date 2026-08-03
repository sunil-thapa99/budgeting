import { DatabaseSync } from 'node:sqlite';
import 'dotenv/config';

// Built-in Node SQLite (node:sqlite) — no native build step. Node >= 22.5.
const db = new DatabaseSync(process.env.DB_PATH || './budget.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS transactions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    date        TEXT    NOT NULL,              -- ISO yyyy-mm-dd
    type        TEXT    NOT NULL DEFAULT 'expense',  -- 'expense' | 'income'
    amount      REAL    NOT NULL,              -- always positive
    category    TEXT    NOT NULL DEFAULT 'Uncategorized',
    description TEXT    NOT NULL DEFAULT '',
    method      TEXT    NOT NULL DEFAULT '',   -- cash / card / bank ...
    source      TEXT    NOT NULL DEFAULT 'manual', -- manual | receipt | import | statement
    account     TEXT    NOT NULL DEFAULT '',   -- e.g. "Discover", "Chase Checking", "Capital One"
    ext_id      TEXT,                          -- stable dedupe hash for imported rows
    excluded    INTEGER NOT NULL DEFAULT 0,    -- 1 = transfer/card-payment, ignored in totals
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_tx_date ON transactions(date);

  -- Monthly expected/budget amount per category (from the sheet's "Expected Amount")
  CREATE TABLE IF NOT EXISTS budgets (
    month    TEXT NOT NULL,   -- 'YYYY-MM'
    category TEXT NOT NULL,
    expected REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (month, category)
  );

  -- Learned merchant -> category memory. Populated by imports and by user edits;
  -- reused so categorization is consistent across imports and improves over time.
  CREATE TABLE IF NOT EXISTS merchant_categories (
    merchant   TEXT PRIMARY KEY,  -- normalized merchant key
    category   TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- User-configured metadata for an account (opening balance + kind). Accounts
  -- themselves are discovered from transactions.account; this just annotates them.
  CREATE TABLE IF NOT EXISTS accounts (
    name            TEXT PRIMARY KEY,
    type            TEXT NOT NULL DEFAULT 'asset',  -- asset | credit | investment | cash
    opening_balance REAL NOT NULL DEFAULT 0,        -- balance before the first recorded transaction
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Migrate an older DB that predates the statement columns (SQLite has no ADD COLUMN IF NOT EXISTS).
for (const [col, def] of [
  ['account', `TEXT NOT NULL DEFAULT ''`],
  ['ext_id', `TEXT`],
  ['excluded', `INTEGER NOT NULL DEFAULT 0`],
] as const) {
  try { db.exec(`ALTER TABLE transactions ADD COLUMN ${col} ${def}`); } catch { /* already exists */ }
}
try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_tx_extid ON transactions(ext_id) WHERE ext_id IS NOT NULL`); } catch {}

export default db;

export type Transaction = {
  id: number;
  date: string;
  type: 'expense' | 'income';
  amount: number;
  category: string;
  description: string;
  method: string;
  source: string;
  account: string;
  ext_id: string | null;
  excluded: number;   // 0 | 1
  created_at: string;
};
