import { Router } from 'express';
import { db, uid } from '../db.js';

const router = Router();
const COLS = ['id', 'date', 'type', 'amount', 'category', 'description', 'method', 'source', 'account', 'excluded'];

// GET /api/export?format=csv|json -> download all transactions. Your data is yours.
router.get('/', async (req, res, next) => {
  try {
  const rows = await db.all<Record<string, unknown>>('SELECT * FROM budget_app_transactions WHERE user_id=? ORDER BY date DESC, id DESC', [uid()]);

  if ((req.query.format as string) === 'json') {
    res.setHeader('Content-Disposition', 'attachment; filename="transactions.json"');
    return res.json(rows);
  }
  const esc = (v: unknown) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [COLS.join(','), ...rows.map(r => COLS.map(c => esc(r[c])).join(','))].join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="transactions.csv"');
  res.send(csv);
  } catch (err) { next(err); }
});

export default router;
