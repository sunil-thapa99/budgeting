import { Router } from 'express';
import { z } from 'zod';
import { db, tx, uid } from '../db.js';
import { learnMerchant, propagateCategory } from '../statements.js';

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
router.get('/', async (req, res, next) => {
  try {
    const { from, to, type, category, q, limit, offset } = req.query as Record<string, string>;
    const where: string[] = ['user_id = ?'];
    const params: any[] = [uid()];
    if (from) { where.push('date >= ?'); params.push(from); }
    if (to) { where.push('date <= ?'); params.push(to); }
    if (type) { where.push('type = ?'); params.push(type); }
    if (category) { where.push('category = ?'); params.push(category); }
    if (q) { where.push('(description ILIKE ? OR category ILIKE ?)'); params.push(`%${q}%`, `%${q}%`); } // ILIKE = case-insensitive
    where.push('parent_id IS NULL'); // split children are shown under their parent, not as top-level rows
    const whereSql = 'WHERE ' + where.join(' AND ');

    const total = (await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM budget_app_transactions ${whereSql}`, params))!.n;
    const lim = Math.min(Math.max(Number(limit) || 100, 1), 500);
    const off = Math.max(Number(offset) || 0, 0);
    const rows = await db.all(
      `SELECT t.*, (SELECT COUNT(*) FROM budget_app_transactions c WHERE c.parent_id=t.id AND c.user_id=t.user_id) AS split_count
       FROM budget_app_transactions t ${whereSql} ORDER BY date DESC, id DESC LIMIT ? OFFSET ?`,
      [...params, lim, off]);
    res.json({ rows, total });
  } catch (err) { next(err); }
});

router.post('/', async (req, res, next) => {
  try {
    const p = TxInput.parse(req.body);
    const row = await db.get(
      `INSERT INTO budget_app_transactions (user_id,date,type,amount,category,description,method,source)
       VALUES (?,?,?,?,?,?,?,?) RETURNING *`,
      [uid(), p.date, p.type, p.amount, p.category, p.description, p.method, p.source]);
    res.status(201).json(row);
  } catch (err) { next(err); }
});

router.put('/:id', async (req, res, next) => {
  try {
    const p = TxInput.parse(req.body);
    const id = Number(req.params.id);
    // excluded=0: assigning a category means it's real (undoes a wrong transfer/exclusion).
    await db.run(
      `UPDATE budget_app_transactions SET date=?,type=?,amount=?,category=?,description=?,method=?,source=?,excluded=0 WHERE id=? AND user_id=?`,
      [p.date, p.type, p.amount, p.category, p.description, p.method, p.source, id, uid()]);
    let propagated = 0;
    if (p.description && p.category) {
      await learnMerchant(p.description, p.category);              // remember for future imports
      propagated = await propagateCategory(db, p.description, p.category); // apply to all OTHER similar existing rows
    }
    const row = await db.get('SELECT * FROM budget_app_transactions WHERE id=? AND user_id=?', [id, uid()]);
    res.json({ row, propagated });
  } catch (err) { next(err); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    await db.run('DELETE FROM budget_app_transactions WHERE (id=? OR parent_id=?) AND user_id=?', [id, id, uid()]); // cascade to split children
    res.status(204).end();
  } catch (err) { next(err); }
});

// Children of a split parent.
router.get('/:id/splits', async (req, res, next) => {
  try {
    res.json(await db.all('SELECT * FROM budget_app_transactions WHERE parent_id=? AND user_id=? ORDER BY id', [Number(req.params.id), uid()]));
  } catch (err) { next(err); }
});

// Split a transaction into per-category child rows summing to its amount (empty array = unsplit).
// The parent stays as the real money movement (kept in account/net-worth flow); children carry the
// category breakdown (counted in spending/budgets). Guards in summary keep the parent out of category totals.
router.post('/:id/split', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const parent = await db.get<any>('SELECT * FROM budget_app_transactions WHERE id=? AND user_id=? AND parent_id IS NULL', [id, uid()]);
    if (!parent) { res.status(404).json({ error: 'transaction not found' }); return; }
    const { splits } = z.object({
      splits: z.array(z.object({ category: z.string().min(1), amount: z.number().positive() })),
    }).parse(req.body);
    if (splits.length) {
      const sum = splits.reduce((s, x) => s + x.amount, 0);
      if (Math.abs(sum - parent.amount) > 0.01) { res.status(400).json({ error: `splits must sum to ${parent.amount}` }); return; }
    }

    await tx(async (conn) => {
      await conn.run('DELETE FROM budget_app_transactions WHERE parent_id=? AND user_id=?', [id, uid()]); // replace any prior split
      for (const s of splits) {
        await conn.run(
          `INSERT INTO budget_app_transactions (user_id,date,type,amount,category,description,method,source,account,excluded,parent_id)
           VALUES (?,?,?,?,?,?,?,?,'',0,?)`,
          [uid(), parent.date, parent.type, s.amount, s.category, parent.description, parent.method, parent.source, id]);
      }
    });
    res.json({ ok: true, splits: splits.length });
  } catch (err) { next(err); }
});

// Distinct categories (for dropdowns), union of used + budgeted
router.get('/meta/categories', async (_req, res, next) => {
  try {
    const rows = await db.all<{ category: string }>(
      `SELECT category FROM budget_app_transactions WHERE user_id=?
       UNION SELECT category FROM budget_app_budgets WHERE user_id=?
       ORDER BY category`, [uid(), uid()]);
    res.json(rows.map(r => r.category));
  } catch (err) { next(err); }
});

// Pure core of the budget merge in renameCategory: given the source category's budget rows and
// the set of months the target already has, decide what to add-to vs insert. Kept pure to test.
export function planBudgetMerge(fromRows: { month: string; expected: number }[], targetMonths: Set<string>) {
  const add: { month: string; expected: number }[] = [];    // target month exists -> sum into it
  const insert: { month: string; expected: number }[] = []; // target month absent -> rename into it
  for (const r of fromRows) (targetMonths.has(r.month) ? add : insert).push(r);
  return { add, insert };
}

// Rename a category everywhere (transactions, budgets, learned merchant memory, keyword rules).
// If `to` already exists it's a merge — budget rows for the same month are summed. Returns rows moved.
export async function renameCategory(from: string, to: string): Promise<number> {
  if (from === to) return 0;
  return tx(async (conn) => {
    const moved = (await conn.run('UPDATE budget_app_transactions SET category=? WHERE category=? AND user_id=?', [to, from, uid()])).changes;
    await conn.run('UPDATE budget_app_merchant_categories SET category=? WHERE category=? AND user_id=?', [to, from, uid()]);
    await conn.run('UPDATE budget_app_category_rules SET category=? WHERE category=? AND user_id=?', [to, from, uid()]);

    // Budgets have PK (user_id, month, category) — merge instead of renaming into a conflict.
    const fromRows = await conn.all<{ month: string; expected: number }>('SELECT month, expected FROM budget_app_budgets WHERE category=? AND user_id=?', [from, uid()]);
    const targetMonths = new Set((await conn.all<{ month: string }>('SELECT month FROM budget_app_budgets WHERE category=? AND user_id=?', [to, uid()])).map(r => r.month));
    const { add, insert } = planBudgetMerge(fromRows, targetMonths);
    for (const r of add) await conn.run('UPDATE budget_app_budgets SET expected=expected+? WHERE month=? AND category=? AND user_id=?', [r.expected, r.month, to, uid()]);
    for (const r of insert) await conn.run('INSERT INTO budget_app_budgets (user_id, month, category, expected) VALUES (?,?,?,?)', [uid(), r.month, to, r.expected]);
    await conn.run('DELETE FROM budget_app_budgets WHERE category=? AND user_id=?', [from, uid()]);
    return moved;
  });
}

router.post('/meta/categories/rename', async (req, res, next) => {
  try {
    const { from, to } = z.object({ from: z.string().min(1), to: z.string().min(1) }).parse(req.body);
    res.json({ ok: true, moved: await renameCategory(from, to) });
  } catch (err) { next(err); }
});

export default router;
