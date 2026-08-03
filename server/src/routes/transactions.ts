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

// GET /api/transactions?from=&to=&type=&category=&q=&limit=&offset=  ->  { rows, total }
router.get('/', (req, res) => {
  const { from, to, type, category, q, limit, offset } = req.query as Record<string, string>;
  const where: string[] = [];
  const params: any[] = [];
  if (from) { where.push('date >= ?'); params.push(from); }
  if (to) { where.push('date <= ?'); params.push(to); }
  if (type) { where.push('type = ?'); params.push(type); }
  if (category) { where.push('category = ?'); params.push(category); }
  if (q) { where.push('(description LIKE ? OR category LIKE ?)'); params.push(`%${q}%`, `%${q}%`); } // LIKE is ASCII-case-insensitive in SQLite
  where.push('parent_id IS NULL'); // split children are shown under their parent, not as top-level rows
  const whereSql = 'WHERE ' + where.join(' AND ');

  const total = (db.prepare(`SELECT COUNT(*) AS n FROM transactions ${whereSql}`).get(...params) as { n: number }).n;
  const lim = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const off = Math.max(Number(offset) || 0, 0);
  const rows = db.prepare(
    `SELECT t.*, (SELECT COUNT(*) FROM transactions c WHERE c.parent_id=t.id) AS split_count
     FROM transactions t ${whereSql} ORDER BY date DESC, id DESC LIMIT ? OFFSET ?`
  ).all(...params, lim, off);
  res.json({ rows, total });
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
  const id = Number(req.params.id);
  db.prepare('DELETE FROM transactions WHERE id=? OR parent_id=?').run(id, id); // cascade to split children
  res.status(204).end();
});

// Children of a split parent.
router.get('/:id/splits', (req, res) => {
  res.json(db.prepare('SELECT * FROM transactions WHERE parent_id=? ORDER BY id').all(Number(req.params.id)));
});

// Split a transaction into per-category child rows summing to its amount (empty array = unsplit).
// The parent stays as the real money movement (kept in account/net-worth flow); children carry the
// category breakdown (counted in spending/budgets). Guards in summary keep the parent out of category totals.
router.post('/:id/split', (req, res) => {
  const id = Number(req.params.id);
  const parent = db.prepare('SELECT * FROM transactions WHERE id=? AND parent_id IS NULL').get(id) as any;
  if (!parent) { res.status(404).json({ error: 'transaction not found' }); return; }
  const { splits } = z.object({
    splits: z.array(z.object({ category: z.string().min(1), amount: z.number().positive() })),
  }).parse(req.body);
  if (splits.length) {
    const sum = splits.reduce((s, x) => s + x.amount, 0);
    if (Math.abs(sum - parent.amount) > 0.01) { res.status(400).json({ error: `splits must sum to ${parent.amount}` }); return; }
  }

  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM transactions WHERE parent_id=?').run(id); // replace any prior split
    const ins = db.prepare(`INSERT INTO transactions (date,type,amount,category,description,method,source,account,excluded,parent_id)
                            VALUES (?,?,?,?,?,?,?,'',0,?)`);
    for (const s of splits) ins.run(parent.date, parent.type, s.amount, s.category, parent.description, parent.method, parent.source, id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  res.json({ ok: true, splits: splits.length });
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

// Rename a category everywhere (transactions, budgets, learned merchant memory).
// If `to` already exists it's a merge — budget rows for the same month are summed.
// Exported (taking `database`) so it's testable against an in-memory DB.
export function renameCategory(database: typeof db, from: string, to: string): number {
  if (from === to) return 0;
  database.exec('BEGIN');
  try {
    const moved = database.prepare('UPDATE transactions SET category=? WHERE category=?').run(to, from).changes;
    database.prepare('UPDATE merchant_categories SET category=? WHERE category=?').run(to, from);

    // Budgets have PK (month, category) — merge instead of blindly renaming into a conflict.
    const fromRows = database.prepare('SELECT month, expected FROM budgets WHERE category=?').all(from) as { month: string; expected: number }[];
    const target = database.prepare('SELECT 1 FROM budgets WHERE month=? AND category=?');
    const add = database.prepare('UPDATE budgets SET expected=expected+? WHERE month=? AND category=?');
    const ins = database.prepare('INSERT INTO budgets (month, category, expected) VALUES (?,?,?)');
    const delFrom = database.prepare('DELETE FROM budgets WHERE month=? AND category=?');
    for (const r of fromRows) {
      if (target.get(r.month, to)) add.run(r.expected, r.month, to);
      else ins.run(r.month, to, r.expected);
      delFrom.run(r.month, from);
    }
    database.exec('COMMIT');
    return Number(moved);
  } catch (e) {
    database.exec('ROLLBACK');
    throw e;
  }
}

router.post('/meta/categories/rename', (req, res) => {
  const { from, to } = z.object({ from: z.string().min(1), to: z.string().min(1) }).parse(req.body);
  res.json({ ok: true, moved: renameCategory(db, from, to) });
});

export default router;
