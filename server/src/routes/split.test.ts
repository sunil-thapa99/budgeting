import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';

// Validates the split accounting invariant directly against the SQL guards:
// a split parent stays in account/net-worth flow but is kept out of spending/category totals,
// while its children carry the categories — no double counting either way.
// Run: cd server && npx tsx src/routes/split.test.ts
const db = new DatabaseSync(':memory:');
db.exec(`
  CREATE TABLE transactions (id INTEGER PRIMARY KEY, date TEXT, type TEXT, amount REAL,
    category TEXT, account TEXT, excluded INTEGER DEFAULT 0, parent_id INTEGER);
  -- Parent: a $100 Chase purchase later split into Groceries $60 + Household $40.
  INSERT INTO transactions (id,date,type,amount,category,account,excluded,parent_id)
    VALUES (1,'2026-07-10','expense',100,'Shopping','Chase',0,NULL);
  INSERT INTO transactions (date,type,amount,category,account,excluded,parent_id) VALUES
    ('2026-07-10','expense',60,'Groceries','',0,1),
    ('2026-07-10','expense',40,'Household','',0,1);
  -- A plain unsplit expense, to be sure normal rows still count.
  INSERT INTO transactions (date,type,amount,category,account,excluded,parent_id)
    VALUES ('2026-07-12','expense',25,'Gas','Chase',0,NULL);
`);

const NOT_PARENT = `AND id NOT IN (SELECT parent_id FROM transactions WHERE parent_id IS NOT NULL)`;

// Spending by category excludes the parent, includes children + normal rows.
const cats = db.prepare(`SELECT category, SUM(amount) amount FROM transactions
  WHERE type='expense' AND excluded=0 ${NOT_PARENT} GROUP BY category ORDER BY category`).all();
assert.deepEqual(cats, [
  { category: 'Gas', amount: 25 },
  { category: 'Groceries', amount: 60 },
  { category: 'Household', amount: 40 },
], 'parent category "Shopping" is gone; children + normal row counted');

const totalSpend = (db.prepare(`SELECT SUM(amount) s FROM transactions
  WHERE type='expense' AND excluded=0 ${NOT_PARENT}`).get() as { s: number }).s;
assert.equal(totalSpend, 125, 'total spend unchanged by the split (60+40+25)');

// Account flow counts the parent once; children (account='') never match a real account.
const chaseFlow = (db.prepare(`SELECT SUM(-amount) f FROM transactions WHERE account='Chase'`).get() as { f: number }).f;
assert.equal(chaseFlow, -125, 'net worth flow counts parent $100 once, not its children');

// Top-level list hides children and reports split_count.
const list = db.prepare(`SELECT id, (SELECT COUNT(*) FROM transactions c WHERE c.parent_id=t.id) split_count
  FROM transactions t WHERE parent_id IS NULL ORDER BY id`).all();
assert.deepEqual(list, [{ id: 1, split_count: 2 }, { id: 4, split_count: 0 }], 'parent shown with 2 splits, children hidden');

console.log('split.test.ts: all assertions passed');
