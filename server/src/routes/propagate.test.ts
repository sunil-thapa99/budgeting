import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { propagateCategory } from '../statements.js';

// Run: cd server && npx tsx src/routes/propagate.test.ts
const db = new DatabaseSync(':memory:');
db.exec(`
  CREATE TABLE transactions (id INTEGER PRIMARY KEY, description TEXT, category TEXT, excluded INTEGER, parent_id INTEGER);
  INSERT INTO transactions (description,category,excluded,parent_id) VALUES
    ('ALLY FINANCIAL PAYMENT','Transfer',1,NULL),   -- the one the user is editing (already set below)
    ('ALLY FINANCIAL PMT 0099','Transfer',1,NULL),  -- a twin -> must follow
    ('WALMART SUPERCENTER','Groceries',0,NULL),     -- unrelated -> untouched
    ('ALLY BANK CHILD','Transfer',1,1);             -- split child -> skipped
`);

// User corrected the first ALLY to Transportation; propagate to all similar.
const changed = propagateCategory(db as any, 'ALLY FINANCIAL PAYMENT', 'Transportation');
assert.equal(changed, 2, 'both ALLY FINANCIAL parents follow (same merchant key), child + WALMART skipped');

const ally = db.prepare(`SELECT category, excluded FROM transactions WHERE description LIKE 'ALLY FINANCIAL%'`).all() as { category: string; excluded: number }[];
assert(ally.every(r => r.category === 'Transportation' && r.excluded === 0), 'twins recategorized and un-excluded');

const wal = db.prepare(`SELECT category FROM transactions WHERE description='WALMART SUPERCENTER'`).get() as { category: string };
assert.equal(wal.category, 'Groceries', 'unrelated merchant untouched');

const child = db.prepare(`SELECT category FROM transactions WHERE parent_id=1`).get() as { category: string };
assert.equal(child.category, 'Transfer', 'split child untouched');

// Idempotent.
assert.equal(propagateCategory(db as any, 'ALLY FINANCIAL PAYMENT', 'Transportation'), 0, 'second run is a no-op');

console.log('propagate.test.ts: all assertions passed');
