import { Router } from 'express';
import { db, uid } from '../db.js';

const router = Router();

// A split parent is re-sliced by its children, which carry the real categories/amounts.
// Exclude parents from every spending aggregation so their amount isn't counted twice.
const NOT_SPLIT_PARENT = `AND id NOT IN (SELECT parent_id FROM budget_app_transactions WHERE parent_id IS NOT NULL AND user_id=?)`;

// GET /api/summary?month=YYYY-MM   (month optional -> all-time + latest month)
router.get('/', async (req, res, next) => {
  try {
    const u = uid();
    const month = (req.query.month as string) || null; // 'YYYY-MM'
    const monthFilter = month ? `AND to_char(date,'YYYY-MM') = ?` : '';
    // Param order below follows each query's `?` left-to-right: user_id (WHERE), user_id (NOT_SPLIT_PARENT subquery), then month.
    const base = month ? [u, u, month] : [u, u];

    const totals = (await db.get<{ income: number; expense: number }>(`
      SELECT
        COALESCE(SUM(CASE WHEN type='income'  THEN amount END),0) AS income,
        COALESCE(SUM(CASE WHEN type='expense' THEN amount END),0) AS expense
      FROM budget_app_transactions WHERE user_id=? AND excluded=0 ${NOT_SPLIT_PARENT} ${monthFilter}
    `, base))!;
    const net = totals.income - totals.expense;
    const savingsRate = totals.income > 0 ? net / totals.income : 0;

    const byCategory = await db.all(`
      SELECT category, SUM(amount) AS amount
      FROM budget_app_transactions WHERE user_id=? AND type='expense' AND excluded=0 ${NOT_SPLIT_PARENT} ${monthFilter}
      GROUP BY category ORDER BY amount DESC
    `, base);

    // Monthly income vs expense trend (all months, ignores month filter)
    const trend = await db.all(`
      SELECT to_char(date,'YYYY-MM') AS month,
        COALESCE(SUM(CASE WHEN type='income'  THEN amount END),0) AS income,
        COALESCE(SUM(CASE WHEN type='expense' THEN amount END),0) AS expense
      FROM budget_app_transactions WHERE user_id=? AND excluded=0 ${NOT_SPLIT_PARENT} GROUP BY month ORDER BY month
    `, [u, u]);

    // Budget vs actual for the selected month, with sinking-fund carryover.
    let budgetVsActual: BudgetRow[] = [];
    if (month) {
      const budgets = await db.all<ExpRow>('SELECT month, category, expected FROM budget_app_budgets WHERE user_id=?', [u]);
      const actuals = await db.all<ActRow>(`
        SELECT to_char(date,'YYYY-MM') AS month, category, SUM(amount) AS actual
        FROM budget_app_transactions WHERE user_id=? AND type='expense' AND excluded=0 ${NOT_SPLIT_PARENT} GROUP BY month, category
      `, [u, u]);
      budgetVsActual = computeBudget(budgets, actuals, month);
    }

    const months = (await db.all<{ m: string }>(
      `SELECT DISTINCT to_char(date,'YYYY-MM') AS m FROM budget_app_transactions WHERE user_id=? ORDER BY m DESC`, [u]
    )).map(r => r.m);

    res.json({
      month, months,
      totals: { income: totals.income, expense: totals.expense, net, savingsRate },
      byCategory, trend, budgetVsActual,
    });
  } catch (err) { next(err); }
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
