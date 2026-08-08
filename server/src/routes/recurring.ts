import { Router } from 'express';
import { db, uid } from '../db.js';
import { normalizeMerchant } from '../statements.js';

const router = Router();
const DAY = 86400000;

// [minGapDays, maxGapDays, label, chargesPerMonth] — a merchant whose median gap
// lands in a bucket (and is regular enough) is treated as recurring.
const CADENCES: [number, number, string, number][] = [
  [5, 9, 'weekly', 4.33],
  [12, 16, 'biweekly', 2.17],
  [26, 35, 'monthly', 1],
  [85, 100, 'quarterly', 1 / 3],
  [350, 380, 'yearly', 1 / 12],
];

type Row = { date: string; amount: number; category: string; description: string };

// GET /api/recurring -> detected subscriptions + total monthly cost of active ones.
router.get('/', async (_req, res, next) => {
  try {
    const rows = await db.all<Row>(
      `SELECT date, amount, category, description FROM budget_app_transactions
       WHERE user_id=? AND type='expense' AND excluded=0 ORDER BY date`, [uid()]);
    res.json(detectRecurring(rows, Date.now()));
  } catch (err) { next(err); }
});

// Pure so it's testable without a DB. `rows` must be date-ascending.
export function detectRecurring(rows: Row[], now: number) {
  const groups = new Map<string, Row[]>();
  for (const r of rows) {
    const key = normalizeMerchant(r.description);
    if (!key) continue;
    let arr = groups.get(key);
    if (!arr) groups.set(key, (arr = []));
    arr.push(r); // rows are date-ascending, so each group is too
  }

  const nowDay = now / DAY;
  const subs = [];
  for (const g of groups.values()) {
    if (g.length < 3) continue; // need a few hits to call it a pattern
    const days = g.map(r => Date.parse(r.date) / DAY);
    const gaps = days.slice(1).map((d, i) => d - days[i]);
    const median = gaps.slice().sort((a, b) => a - b)[Math.floor(gaps.length / 2)];
    const cad = CADENCES.find(([lo, hi]) => median >= lo && median <= hi);
    if (!cad) continue;
    const [lo, hi, label, perMonth] = cad;
    // Regularity gate: most gaps must fall in the bucket, else it's just a
    // frequently-visited merchant (groceries) rather than a subscription.
    if (gaps.filter(x => x >= lo && x <= hi).length / gaps.length < 0.6) continue;

    const avg = g.reduce((a, r) => a + r.amount, 0) / g.length;
    const last = g[g.length - 1];
    const lastDay = days[days.length - 1];
    subs.push({
      merchant: last.description || last.category,
      category: last.category,
      cadence: label,
      avgAmount: round(avg),
      monthlyCost: round(avg * perMonth),
      lastDate: last.date,
      nextExpected: new Date((lastDay + median) * DAY).toISOString().slice(0, 10),
      count: g.length,
      active: nowDay - lastDay <= median * 1.5, // seen recently enough to look live
    });
  }
  subs.sort((a, b) => b.monthlyCost - a.monthlyCost);
  const monthlyTotal = round(subs.filter(s => s.active).reduce((a, s) => a + s.monthlyCost, 0));
  return { subscriptions: subs, monthlyTotal };
}

const round = (n: number) => Math.round(n * 100) / 100;

export default router;

// ponytail: merchant grouping reuses normalizeMerchant (2-token key) — may over-merge
// (all "AMAZON …" as one) or split renamed billers. Regularity gate filters most noise;
// tighten with an amount-stability check if false positives show up.
