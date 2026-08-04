import { Router } from 'express';
import { z } from 'zod';
import db from '../db.js';
import { matchRule } from '../statements.js';

const router = Router();

// Apply every keyword rule to existing transactions: matched rows get the rule's category and
// are un-excluded (a user category means it's real spending/income, not a transfer). Returns the
// number of rows changed. Pure over `database` so it's testable. Skips split children.
export function reapplyRules(database: typeof db): number {
  const rules = database.prepare('SELECT keyword, category FROM category_rules').all() as { keyword: string; category: string }[];
  if (!rules.length) return 0;
  const rows = database.prepare('SELECT id, description, category, excluded FROM transactions WHERE parent_id IS NULL').all() as
    { id: number; description: string; category: string; excluded: number }[];
  const upd = database.prepare('UPDATE transactions SET category=?, excluded=0 WHERE id=?');
  let changed = 0;
  for (const r of rows) {
    const c = matchRule(r.description, rules);
    if (c && (c !== r.category || r.excluded !== 0)) { upd.run(c, r.id); changed++; }
  }
  return changed;
}

// GET /api/rules -> keyword -> category rules (applied first during import categorization).
router.get('/', (_req, res) => {
  res.json(db.prepare('SELECT keyword, category FROM category_rules ORDER BY keyword').all());
});

router.post('/', (req, res) => {
  const { keyword, category } = z.object({
    keyword: z.string().trim().min(2, 'keyword needs ≥2 characters'),
    category: z.string().trim().min(1),
  }).parse(req.body);
  db.prepare(`INSERT INTO category_rules (keyword, category, updated_at) VALUES (?,?,datetime('now'))
              ON CONFLICT(keyword) DO UPDATE SET category=excluded.category, updated_at=excluded.updated_at`)
    .run(keyword.toUpperCase(), category);
  res.status(201).json({ ok: true, applied: reapplyRules(db) }); // fix existing matching transactions too
});

router.delete('/:keyword', (req, res) => {
  db.prepare('DELETE FROM category_rules WHERE keyword=?').run(req.params.keyword.toUpperCase());
  res.status(204).end();
});

export default router;
