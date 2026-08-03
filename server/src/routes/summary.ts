import { Router } from 'express';
import db from '../db.js';

const router = Router();

// A split parent is re-sliced by its children, which carry the real categories/amounts.
// Exclude parents from every spending aggregation so their amount isn't counted twice.
const NOT_SPLIT_PARENT = `AND id NOT IN (SELECT parent_id FROM transactions WHERE parent_id IS NOT NULL)`;

// GET /api/summary?month=YYYY-MM   (month optional -> all-time + latest month)
router.get('/', (req, res) => {
  const month = (req.query.month as string) || null; // 'YYYY-MM'
  const monthFilter = month ? `AND strftime('%Y-%m', date) = ?` : '';
  const mp = month ? [month] : [];

  const totals = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN type='income'  THEN amount END),0) AS income,
      COALESCE(SUM(CASE WHEN type='expense' THEN amount END),0) AS expense
    FROM transactions WHERE excluded=0 ${NOT_SPLIT_PARENT} ${monthFilter}
  `).get(...mp) as { income: number; expense: number };
  const net = totals.income - totals.expense;
  const savingsRate = totals.income > 0 ? net / totals.income : 0;

  const byCategory = db.prepare(`
    SELECT category, SUM(amount) AS amount
    FROM transactions WHERE type='expense' AND excluded=0 ${NOT_SPLIT_PARENT} ${monthFilter}
    GROUP BY category ORDER BY amount DESC
  `).all(...mp);

  // Monthly income vs expense trend (all months, ignores month filter)
  const trend = db.prepare(`
    SELECT strftime('%Y-%m', date) AS month,
      COALESCE(SUM(CASE WHEN type='income'  THEN amount END),0) AS income,
      COALESCE(SUM(CASE WHEN type='expense' THEN amount END),0) AS expense
    FROM transactions WHERE excluded=0 ${NOT_SPLIT_PARENT} GROUP BY month ORDER BY month
  `).all();

  // Budget vs actual for the selected month, with sinking-fund carryover.
  let budgetVsActual: BudgetRow[] = [];
  if (month) {
    const budgets = db.prepare('SELECT month, category, expected FROM budgets').all() as ExpRow[];
    const actuals = db.prepare(`
      SELECT strftime('%Y-%m', date) AS month, category, SUM(amount) AS actual
      FROM transactions WHERE type='expense' AND excluded=0 ${NOT_SPLIT_PARENT} GROUP BY month, category
    `).all() as ActRow[];
    budgetVsActual = computeBudget(budgets, actuals, month);
  }

  const months = (db.prepare(
    `SELECT DISTINCT strftime('%Y-%m', date) AS m FROM transactions ORDER BY m DESC`
  ).all() as { m: string }[]).map(r => r.m);

  res.json({
    month, months,
    totals: { income: totals.income, expense: totals.expense, net, savingsRate },
    byCategory, trend, budgetVsActual,
  });
});

export default router;

type ExpRow = { month: string; category: string; expected: number };
type ActRow = { month: string; category: string; actual: number };
type BudgetRow = { category: string; expected: number; actual: number; rollover: number; available: number };

// Sinking-fund carryover: a category's "available" this month = unspent/overspent
// from prior budgeted months + this month's (expected − actual). Pure, so it's testable.
export function computeBudget(budgets: ExpRow[], actuals: ActRow[], month: string): BudgetRow[] {
  const index = (rows: { month: string; category: string }[], val: (r: any) => number) => {
    const m = new Map<string, Map<string, number>>();
    for (const r of rows) {
      let byMonth = m.get(r.category);
      if (!byMonth) m.set(r.category, (byMonth = new Map()));
      byMonth.set(r.month, val(r));
    }
    return m;
  };
  const exp = index(budgets, r => r.expected);
  const act = index(actuals, r => r.actual);

  const out: BudgetRow[] = [];
  for (const [category, months] of exp) {
    if (!months.has(month)) continue; // only categories budgeted in the selected month
    const am = act.get(category);
    let rollover = 0;
    for (const [m, e] of months) if (m < month) rollover += e - (am?.get(m) ?? 0); // carry from prior budgeted months
    const expected = months.get(month) ?? 0;
    const actual = am?.get(month) ?? 0;
    out.push({ category, expected, actual, rollover, available: rollover + expected - actual });
  }
  return out.filter(r => r.expected > 0 || r.actual > 0).sort((a, b) => b.expected - a.expected);
}
