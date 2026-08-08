import assert from 'node:assert';
import { computeAccounts } from './accounts.js';

// Run: cd server && npx tsx src/routes/accounts.test.ts
// Tests the pure balance/net-worth core (the DB fetch is a thin wrapper around it).
//   Chase (asset, opening 1000): +3000 income −2500 expense -> flow 500 -> balance 1500
//   Capital One (credit, opening 0): spend 800, pay 300 -> flow −500 -> balance −500 (debt)
//   Discover (discovered, unconfigured): −120 -> balance −120
const cfg = [
  { name: 'Chase', type: 'asset', opening_balance: 1000 },
  { name: 'Capital One', type: 'credit', opening_balance: 0 },
];
const flows = [
  { name: 'Chase', flow: 500 },
  { name: 'Capital One', flow: -500 },
  { name: 'Discover', flow: -120 },
];
const monthly = [
  { month: '2026-07', delta: 0 },     // Chase +500 and Capital One −500 net out
  { month: '2026-08', delta: -120 },  // Discover expense
];

const { accounts, netWorth, series } = computeAccounts(cfg, flows, monthly);

const chase = accounts.find(a => a.name === 'Chase')!;
assert.equal(chase.balance, 1500, 'asset balance = opening + income - expense');

const card = accounts.find(a => a.name === 'Capital One')!;
assert.equal(card.balance, -500, 'credit card carries as negative net worth');

const disc = accounts.find(a => a.name === 'Discover')!;
assert(disc && !disc.configured && disc.balance === -120, 'discovered-but-unconfigured account still contributes');

assert.equal(netWorth, 1500 - 500 - 120, 'net worth = sum of balances');
assert.equal(series[series.length - 1].netWorth, netWorth, 'series ends at current net worth');
assert(series.length === 2, 'two months of activity -> two points');

console.log('accounts.test.ts: all assertions passed');
