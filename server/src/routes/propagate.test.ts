import assert from 'node:assert';
import { planPropagation } from '../statements.js';

// Run: cd server && npx tsx src/routes/propagate.test.ts
// Tests the pure core: which rows follow a correction (same merchant key, actually changing).
// The DB wrapper (propagateCategory) just SELECTs parents then UPDATEs these ids.
const rows = [
  { id: 1, description: 'ALLY FINANCIAL PAYMENT', category: 'Transfer', excluded: 1 },  // the edited one
  { id: 2, description: 'ALLY FINANCIAL PMT 0099', category: 'Transfer', excluded: 1 }, // twin -> follows
  { id: 3, description: 'WALMART SUPERCENTER', category: 'Groceries', excluded: 0 },     // unrelated -> untouched
  // (split children are excluded by the SELECT's `parent_id IS NULL`, so they never reach here)
];

const ids = planPropagation(rows, 'ALLY FINANCIAL PAYMENT', 'Transportation');
assert.deepEqual(ids.sort(), [1, 2], 'both ALLY FINANCIAL rows follow (same merchant key); WALMART skipped');

// Idempotent: once they're already Transportation + un-excluded, nothing changes.
const done = [
  { id: 1, description: 'ALLY FINANCIAL PAYMENT', category: 'Transportation', excluded: 0 },
  { id: 2, description: 'ALLY FINANCIAL PMT 0099', category: 'Transportation', excluded: 0 },
];
assert.deepEqual(planPropagation(done, 'ALLY FINANCIAL PAYMENT', 'Transportation'), [], 'second run is a no-op');

console.log('propagate.test.ts: all assertions passed');
