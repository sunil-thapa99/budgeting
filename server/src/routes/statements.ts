import { Router } from 'express';
import multer from 'multer';
import { parseStatement, commitStatement, allowedCategories, type ProposedTx } from '../statements.js';
import { withUserCtx } from '../auth.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 12 } });

router.get('/categories', async (_req, res, next) => {
  try { res.json(await allowedCategories()); } catch (err) { next(err); }
});

// POST /api/statements/preview  (multipart: files[]) -> proposed transactions per file, NO writes
router.post('/preview', upload.array('files'), withUserCtx, async (req, res, next) => {
  try {
    const files = (req.files as Express.Multer.File[]) || [];
    if (!files.length) return res.status(400).json({ error: 'Upload one or more statement files (.csv/.pdf).' });
    const out = [];
    for (const f of files) {
      const rows = await parseStatement({ name: f.originalname, buffer: f.buffer });
      out.push({ file: f.originalname, account: rows[0]?.account ?? '', rows });
    }
    res.json({ files: out, categories: await allowedCategories() });
  } catch (err) { next(err); }
});

// POST /api/statements/commit  { rows: ProposedTx[] } -> insert (skips existing ext_id)
router.post('/commit', async (req, res, next) => {
  try {
    const rows = (req.body?.rows as ProposedTx[]) || [];
    if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: 'No rows to import.' });
    res.json(await commitStatement(rows));
  } catch (err) { next(err); }
});

export default router;
