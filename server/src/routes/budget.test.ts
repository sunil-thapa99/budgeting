import assert from 'node:assert';
import { computeBudget } from './summary.js';

// Run: cd server && npx tsx src/routes/budget.test.ts
const budgets = [
  { month: '2026-07', category: 'Groceries', expected: 400 },
  { month: '2026-08', category: 'Groceries', expected: 400 },
  { month: '2026-08', category: 'Rent', expected: 1200 },
  { month: '2026-07', category: 'Gifts', expected: 100 }, // budgeted in July only -> absent for Aug
];
const actuals = [
  { month: '2026-07', category: 'Groceries', actual: 350 }, // saved 50
  { month: '2026-08', category: 'Groceries', actual: 380 },
  { month: '2026-08', category: 'Rent', actual: 1200 },
];

const rows = computeBudget(budgets, actuals, '2026-08');

const groc = rows.find(r => r.category === 'Groceries')!;
assert(groc, 'Groceries present');
assert.equal(groc.rollover, 50, 'July surplus (400-350) carries in');
assert.equal(groc.available, 70, 'available = 50 carried + 400 budget - 380 spent');

const rent = rows.find(r => r.category === 'Rent')!;
assert.equal(rent.rollover, 0, 'no prior month -> no carryover');
assert.equal(rent.available, 0, 'spent exactly to budget');

assert(!rows.some(r => r.category === 'Gifts'), 'category not budgeted this month is excluded');

// Overspend a prior month -> negative carryover reduces availability.
const deficit = computeBudget(
  [{ month: '2026-07', category: 'Fun', expected: 50 }, { month: '2026-08', category: 'Fun', expected: 50 }],
  [{ month: '2026-07', category: 'Fun', actual: 90 }],
  '2026-08',
);
assert.equal(deficit[0].rollover, -40, 'July overspend carries as a deficit');
assert.equal(deficit[0].available, 10, 'available = -40 + 50 - 0');

console.log('budget.test.ts: all assertions passed');
