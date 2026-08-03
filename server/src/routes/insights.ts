import { Router } from 'express';
import db from '../db.js';
import { nvidia, INSIGHTS_MODEL, CATEGORIZE_MODEL, assertKey } from '../nvidia.js';

const router = Router();

// POST /api/insights  { month?: 'YYYY-MM', question?: string }
router.post('/', async (req, res, next) => {
  try {
    assertKey();
    const month: string | null = req.body?.month || null;
    const question: string | undefined = req.body?.question;
    const mf = month ? `AND strftime('%Y-%m', date)=?` : '';
    const mp = month ? [month] : [];

    const totals = db.prepare(`
      SELECT COALESCE(SUM(CASE WHEN type='income' THEN amount END),0) income,
             COALESCE(SUM(CASE WHEN type='expense' THEN amount END),0) expense
      FROM transactions WHERE excluded=0 ${mf}`).get(...mp);
    const byCat = db.prepare(`
      SELECT category, ROUND(SUM(amount),2) amount FROM transactions
      WHERE type='expense' AND excluded=0 ${mf} GROUP BY category ORDER BY amount DESC LIMIT 15`).all(...mp);
    const budget = month ? db.prepare(`
      SELECT b.category, b.expected, ROUND(COALESCE(SUM(t.amount),0),2) actual
      FROM budgets b LEFT JOIN transactions t
        ON t.category=b.category AND t.type='expense' AND t.excluded=0 AND strftime('%Y-%m',t.date)=?
      WHERE b.month=? GROUP BY b.category, b.expected
      HAVING b.expected>0 OR actual>0 ORDER BY b.expected DESC`).all(month, month) : [];

    const currency = typeof req.body?.currency === 'string' ? req.body.currency : 'USD';
    const data = { scope: month || 'all-time', currency, totals, byCategory: byCat, budgetVsActual: budget };

    const system = `You are a concise, practical personal-finance assistant.
Analyze the user's budget JSON and give specific, actionable insights.
Use the actual numbers. Prefer short markdown: a one-line summary, then 3-6 bullets
covering overspending vs budget, top categories, savings rate, and one concrete suggestion.
Do not invent data that isn't present. Keep it under 200 words.`;

    const user = question
      ? `Budget data:\n${JSON.stringify(data)}\n\nQuestion: ${question}`
      : `Budget data:\n${JSON.stringify(data)}\n\nGive me insights.`;

    const messages = [
      { role: 'system' as const, content: system },
      { role: 'user' as const, content: user },
    ];
    // Try the primary model with a bounded timeout; if NVIDIA is slow/overloaded,
    // fall back to the fast small model so the user always gets a result.
    let text = '', used = INSIGHTS_MODEL;
    try {
      const c = await nvidia.chat.completions.create(
        { model: INSIGHTS_MODEL, temperature: 0.4, max_tokens: 600, messages },
        { timeout: 40_000, maxRetries: 0 });
      text = c.choices[0]?.message?.content ?? '';
    } catch (e) {
      const c = await nvidia.chat.completions.create(
        { model: CATEGORIZE_MODEL, temperature: 0.4, max_tokens: 600, messages },
        { timeout: 40_000, maxRetries: 1 });
      text = c.choices[0]?.message?.content ?? '';
      used = CATEGORIZE_MODEL + ' (fallback)';
    }
    res.json({ text, model: used });
  } catch (err) { next(err); }
});

export default router;
