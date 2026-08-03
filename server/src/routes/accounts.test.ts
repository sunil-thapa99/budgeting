import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { accountsSummary } from './accounts.js';

// Run: cd server && npx tsx src/routes/accounts.test.ts
const db = new DatabaseSync(':memory:');
db.exec(`
  CREATE TABLE transactions (id INTEGER PRIMARY KEY, date TEXT, type TEXT, amount REAL, account TEXT);
  CREATE TABLE accounts (name TEXT PRIMARY KEY, type TEXT, opening_balance REAL, updated_at TEXT);
  INSERT INTO accounts VALUES ('Chase','asset',1000,''), ('Capital One','credit',0,'');
  -- Chase: +3000 income, -2500 expense  -> 1000 + 500 = 1500
  INSERT INTO transactions (date,type,amount,account) VALUES
    ('2026-07-01','income',3000,'Chase'),
    ('2026-07-20','expense',2500,'Chase'),
    -- Capital One card: spend 800, pay 300 (a credit) -> 0 - 800 + 300 = -500 (debt)
    ('2026-07-05','expense',800,'Capital One'),
    ('2026-07-28','income',300,'Capital One'),
    -- Discover discovered from transactions, never configured -> opening 0, balance -120
    ('2026-08-02','expense',120,'Discover');
`);

const { accounts, netWorth, series } = accountsSummary(db as any);

const chase = accounts.find(a => a.name === 'Chase')!;
assert.equal(chase.balance, 1500, 'asset balance = opening + income - expense');

const card = accounts.find(a => a.name === 'Capital One')!;
assert.equal(card.balance, -500, 'credit card carries as negative net worth');

const disc = accounts.find(a => a.name === 'Discover')!;
assert(disc && !disc.configured && disc.balance === -120, 'discovered-but-unconfigured account still contributes');

assert.equal(netWorth, 1500 - 500 - 120, 'net worth = sum of balances');
assert.equal(series[series.length - 1].netWorth, netWorth, 'series ends at current net worth');
assert(series.length === 2, 'two months of activity -> two points'); // 2026-07, 2026-08

console.log('accounts.test.ts: all assertions passed');
