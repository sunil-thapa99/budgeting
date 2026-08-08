import { Router } from 'express';
import { z } from 'zod';
import { db, uid } from '../db.js';
import { matchRule } from '../statements.js';

const router = Router();

type RuleRow = { id: number; description: string; category: string; excluded: number };

// Pure core: given transactions + keyword rules, which rows should change (and to what).
// A matched row gets the rule's category and is un-excluded. Skips no-op rows. Testable.
export function planReapply(
  rows: RuleRow[],
  rules: { keyword: string; category: string }[],
): { id: number; category: string }[] {
  const out: { id: number; category: string }[] = [];
  for (const r of rows) {
    const c = matchRule(r.description, rules);
    if (c && (c !== r.category || r.excluded !== 0)) out.push({ id: r.id, category: c });
  }
  return out;
}

// Apply every keyword rule to existing (non-child) transactions. Returns rows changed.
export async function reapplyRules(): Promise<number> {
  const rules = await db.all<{ keyword: string; category: string }>('SELECT keyword, category FROM budget_app_category_rules WHERE user_id=?', [uid()]);
  if (!rules.length) return 0;
  const rows = await db.all<RuleRow>('SELECT id, description, category, excluded FROM budget_app_transactions WHERE user_id=? AND parent_id IS NULL', [uid()]);
  const changes = planReapply(rows, rules);
  for (const c of changes) await db.run('UPDATE budget_app_transactions SET category=?, excluded=0 WHERE id=? AND user_id=?', [c.category, c.id, uid()]);
  return changes.length;
}

// GET /api/rules -> keyword -> category rules (applied first during import categorization).
router.get('/', async (_req, res, next) => {
  try {
    res.json(await db.all('SELECT keyword, category FROM budget_app_category_rules WHERE user_id=? ORDER BY keyword', [uid()]));
  } catch (err) { next(err); }
});

router.post('/', async (req, res, next) => {
  try {
    const { keyword, category } = z.object({
      keyword: z.string().trim().min(2, 'keyword needs ≥2 characters'),
      category: z.string().trim().min(1),
    }).parse(req.body);
    await db.run(`INSERT INTO budget_app_category_rules (user_id, keyword, category, updated_at) VALUES (?,?,?,now())
                ON CONFLICT (user_id, keyword) DO UPDATE SET category=excluded.category, updated_at=excluded.updated_at`,
      [uid(), keyword.toUpperCase(), category]);
    res.status(201).json({ ok: true, applied: await reapplyRules() }); // fix existing matching transactions too
  } catch (err) { next(err); }
});

router.delete('/:keyword', async (req, res, next) => {
  try {
    await db.run('DELETE FROM budget_app_category_rules WHERE keyword=? AND user_id=?', [req.params.keyword.toUpperCase(), uid()]);
    res.status(204).end();
  } catch (err) { next(err); }
});

export default router;
