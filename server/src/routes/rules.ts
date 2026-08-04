import { Router } from 'express';
import { z } from 'zod';
import db from '../db.js';

const router = Router();

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
  res.status(201).json({ ok: true });
});

router.delete('/:keyword', (req, res) => {
  db.prepare('DELETE FROM category_rules WHERE keyword=?').run(req.params.keyword.toUpperCase());
  res.status(204).end();
});

export default router;
