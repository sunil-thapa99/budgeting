import { Router } from 'express';
import db from '../db.js';

const router = Router();

// GET /api/summary?month=YYYY-MM   (month optional -> all-time + latest month)
router.get('/', (req, res) => {
  const month = (req.query.month as string) || null; // 'YYYY-MM'
  const monthFilter = month ? `AND strftime('%Y-%m', date) = ?` : '';
  const mp = month ? [month] : [];

  const totals = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN type='income'  THEN amount END),0) AS income,
      COALESCE(SUM(CASE WHEN type='expense' THEN amount END),0) AS expense
    FROM transactions WHERE excluded=0 ${monthFilter}
  `).get(...mp) as { income: number; expense: number };
  const net = totals.income - totals.expense;
  const savingsRate = totals.income > 0 ? net / totals.income : 0;

  const byCategory = db.prepare(`
    SELECT category, SUM(amount) AS amount
    FROM transactions WHERE type='expense' AND excluded=0 ${monthFilter}
    GROUP BY category ORDER BY amount DESC
  `).all(...mp);

  // Monthly income vs expense trend (all months, ignores month filter)
  const trend = db.prepare(`
    SELECT strftime('%Y-%m', date) AS month,
      COALESCE(SUM(CASE WHEN type='income'  THEN amount END),0) AS income,
      COALESCE(SUM(CASE WHEN type='expense' THEN amount END),0) AS expense
    FROM transactions WHERE excluded=0 GROUP BY month ORDER BY month
  `).all();

  // Budget vs actual for the selected month
  const budgetVsActual = month ? db.prepare(`
    SELECT b.category,
           b.expected,
           COALESCE(a.actual,0) AS actual
    FROM budgets b
    LEFT JOIN (
      SELECT category, SUM(amount) AS actual
      FROM transactions
      WHERE type='expense' AND excluded=0 AND strftime('%Y-%m', date)=?
      GROUP BY category
    ) a ON a.category=b.category
    WHERE b.month=? AND (b.expected>0 OR a.actual>0)
    ORDER BY b.expected DESC
  `).all(month, month) : [];

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
