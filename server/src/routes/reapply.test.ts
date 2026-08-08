import assert from 'node:assert';
import { planReapply } from './rules.js';

// Run: cd server && npx tsx src/routes/reapply.test.ts
// Tests the pure core: which rows a keyword rule should recategorize + un-exclude.
// The DB wrapper (reapplyRules) SELECTs non-child rows then UPDATEs these.
const rules = [{ keyword: 'ALLY', category: 'Transportation' }];
const rows = [
  { id: 1, description: 'ALLY FINANCIAL PAYMENT', category: 'Transfer', excluded: 1 },
  { id: 2, description: 'ALLY FINANCIAL PAYMENT', category: 'Transfer', excluded: 1 },
  { id: 3, description: 'WALMART', category: 'Groceries', excluded: 0 },   // unrelated, must stay put
];

const changes = planReapply(rows, rules);
assert.deepEqual(changes, [
  { id: 1, category: 'Transportation' },
  { id: 2, category: 'Transportation' },
], 'both ALLY rows recategorized; WALMART untouched');

// Idempotent once applied.
const applied = [
  { id: 1, description: 'ALLY FINANCIAL PAYMENT', category: 'Transportation', excluded: 0 },
  { id: 3, description: 'WALMART', category: 'Groceries', excluded: 0 },
];
assert.deepEqual(planReapply(applied, rules), [], 'second run is a no-op');

console.log('reapply.test.ts: all assertions passed');
