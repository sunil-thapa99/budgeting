import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { reapplyRules } from './rules.js';

// Run: cd server && npx tsx src/routes/reapply.test.ts
const db = new DatabaseSync(':memory:');
db.exec(`
  CREATE TABLE transactions (id INTEGER PRIMARY KEY, description TEXT, category TEXT, excluded INTEGER, parent_id INTEGER);
  CREATE TABLE category_rules (keyword TEXT PRIMARY KEY, category TEXT);
  INSERT INTO category_rules VALUES ('ALLY','Transportation');
  -- Two identical ALLY payments both mis-filed as excluded Transfers (the reported bug).
  INSERT INTO transactions (description,category,excluded,parent_id) VALUES
    ('ALLY FINANCIAL PAYMENT','Transfer',1,NULL),
    ('ALLY FINANCIAL PAYMENT','Transfer',1,NULL),
    ('WALMART','Groceries',0,NULL),        -- unrelated, must stay put
    ('ALLY SPLIT CHILD','Transfer',1,1);   -- split child, must be skipped
`);

const changed = reapplyRules(db as any);
assert.equal(changed, 2, 'both ALLY parents updated, unrelated + child skipped');

const ally = db.prepare(`SELECT category, excluded FROM transactions WHERE description='ALLY FINANCIAL PAYMENT'`).all() as { category: string; excluded: number }[];
assert(ally.every(r => r.category === 'Transportation' && r.excluded === 0), 'both ALLY rows recategorized and un-excluded');

const wal = db.prepare(`SELECT category, excluded FROM transactions WHERE description='WALMART'`).get() as { category: string; excluded: number };
assert(wal.category === 'Groceries' && wal.excluded === 0, 'unrelated row untouched');

const child = db.prepare(`SELECT category FROM transactions WHERE parent_id=1`).get() as { category: string };
assert.equal(child.category, 'Transfer', 'split child not touched');

// Idempotent: running again changes nothing.
assert.equal(reapplyRules(db as any), 0, 'second run is a no-op');

console.log('reapply.test.ts: all assertions passed');
