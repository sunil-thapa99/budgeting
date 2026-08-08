import assert from 'node:assert';
import { planBudgetMerge } from './transactions.js';

// Run: cd server && npx tsx src/routes/categories.test.ts
// Tests the non-trivial part of renameCategory: merging the source category's budget rows
// into the target. Months the target already has are SUMMED; months it lacks are RENAMED.
// (transactions/merchant/rule updates are plain UPDATEs; the merge is the tricky bit.)
const fromRows = [
  { month: '2026-07', expected: 100 }, // target already has July -> add
  { month: '2026-08', expected: 150 }, // target lacks August    -> insert
];
const targetMonths = new Set(['2026-07']); // target ("Groceries") already budgeted July at 400

const { add, insert } = planBudgetMerge(fromRows, targetMonths);

assert.deepEqual(add, [{ month: '2026-07', expected: 100 }], 'conflicting month is summed into target (400 + 100)');
assert.deepEqual(insert, [{ month: '2026-08', expected: 150 }], 'non-conflicting month is renamed into target');

// No overlap at all -> everything inserts.
assert.deepEqual(
  planBudgetMerge([{ month: '2026-09', expected: 50 }], new Set()).insert,
  [{ month: '2026-09', expected: 50 }], 'empty target -> all inserts');

console.log('categories.test.ts: all assertions passed');
