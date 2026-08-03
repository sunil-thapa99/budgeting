import { Router } from 'express';
import { z } from 'zod';
import db from '../db.js';
import { learnMerchant } from '../statements.js';

const router = Router();

const TxInput = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
  type: z.enum(['expense', 'income']).default('expense'),
  amount: z.number().positive(),
  category: z.string().min(1).default('Uncategorized'),
  description: z.string().default(''),
  method: z.string().default(''),
  source: z.string().default('manual'),
});

// GET /api/transactions?from=&to=&type=&category=
router.get('/', (req, res) => {
  const { from, to, type, category } = req.query as Record<string, string>;
  const where: string[] = [];
  const params: any[] = [];
  if (from) { where.push('date >= ?'); params.push(from); }
  if (to) { where.push('date <= ?'); params.push(to); }
  if (type) { where.push('type = ?'); params.push(type); }
  if (category) { where.push('category = ?'); params.push(category); }
  const sql = `SELECT * FROM transactions ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY date DESC, id DESC`;
  res.json(db.prepare(sql).all(...params));
});

router.post('/', (req, res) => {
  const p = TxInput.parse(req.body);
  const r = db.prepare(
    `INSERT INTO transactions (date,type,amount,category,description,method,source)
     VALUES (?,?,?,?,?,?,?)`
  ).run(p.date, p.type, p.amount, p.category, p.description, p.method, p.source);
  res.status(201).json(db.prepare('SELECT * FROM transactions WHERE id=?').get(r.lastInsertRowid));
});

router.put('/:id', (req, res) => {
  const p = TxInput.parse(req.body);
  db.prepare(
    `UPDATE transactions SET date=?,type=?,amount=?,category=?,description=?,method=?,source=? WHERE id=?`
  ).run(p.date, p.type, p.amount, p.category, p.description, p.method, p.source, Number(req.params.id));
  if (p.description) learnMerchant(p.description, p.category); // fix once, remembered for future imports
  res.json(db.prepare('SELECT * FROM transactions WHERE id=?').get(Number(req.params.id)));
});

router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM transactions WHERE id=?').run(Number(req.params.id));
  res.status(204).end();
});

// Distinct categories (for dropdowns), union of used + budgeted
router.get('/meta/categories', (_req, res) => {
  const rows = db.prepare(
    `SELECT category FROM transactions
     UNION SELECT category FROM budgets
     ORDER BY category`
  ).all() as { category: string }[];
  res.json(rows.map(r => r.category));
});

export default router;
