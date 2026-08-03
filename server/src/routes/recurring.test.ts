import assert from 'node:assert';
import { detectRecurring } from './recurring.js';

// Run: cd server && npx tsx src/routes/recurring.test.ts
const NOW = Date.parse('2026-08-03') ; // fixed "today" so `active` is deterministic
const mk = (date: string, amount: number, desc: string) => ({ date, amount, category: 'Subscriptions', description: desc });

// Monthly Netflix -> detected, active, ~monthly cost = charge amount.
const monthly = ['2026-05-04', '2026-06-04', '2026-07-04', '2026-08-02'].map(d => mk(d, 15.49, 'NETFLIX.COM'));
// Irregular grocery runs at a fixed store -> should NOT be flagged (gaps not regular).
const grocery = ['2026-07-01', '2026-07-03', '2026-07-14', '2026-07-16', '2026-07-30'].map(d => mk(d, 42.1, 'WHOLE FOODS'));
// Old monthly gym that stopped in spring -> detected but inactive.
const gym = ['2026-01-10', '2026-02-10', '2026-03-10'].map(d => mk(d, 30, 'PLANET FITNESS'));

const { subscriptions, monthlyTotal } = detectRecurring([...monthly, ...grocery, ...gym], NOW);

const netflix = subscriptions.find(s => s.merchant.includes('NETFLIX'));
assert(netflix, 'Netflix should be detected');
assert.equal(netflix!.cadence, 'monthly');
assert(netflix!.active, 'Netflix charged last month -> active');
assert(Math.abs(netflix!.monthlyCost - 15.49) < 0.5, 'monthly cost ~ charge amount');

const planet = subscriptions.find(s => s.merchant.includes('PLANET'));
assert(planet && !planet.active, 'stale gym should be detected but inactive');

assert(!subscriptions.some(s => s.merchant.includes('WHOLE')), 'irregular grocery must not be flagged');

// Only active subs count toward the monthly total.
assert(Math.abs(monthlyTotal - 15.49) < 0.5, `monthlyTotal should exclude inactive, got ${monthlyTotal}`);

console.log('recurring.test.ts: all assertions passed');
