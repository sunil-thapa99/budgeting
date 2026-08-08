import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import './db.js';
import { requireAuth } from './auth.js';
import transactions from './routes/transactions.js';
import summary from './routes/summary.js';
import insights from './routes/insights.js';
import receipt from './routes/receipt.js';
import importXlsx from './routes/importXlsx.js';
import statements from './routes/statements.js';
import recurring from './routes/recurring.js';
import exportTx from './routes/export.js';
import accounts from './routes/accounts.js';
import rules from './routes/rules.js';

const app = express();
// CORS lockdown: in production set CORS_ORIGINS to a comma-separated list of allowed
// frontend origins (e.g. "https://mybudget.vercel.app"). Unset -> allow all (dev).
const origins = (process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
app.use(cors(origins.length ? { origin: origins } : undefined));
app.use(express.json({ limit: '12mb' })); // receipts arrive as base64

app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.use('/api', requireAuth); // everything below requires a valid Supabase session
app.use('/api/transactions', transactions);
app.use('/api/summary', summary);
app.use('/api/insights', insights);
app.use('/api/receipt', receipt);
app.use('/api/import', importXlsx);
app.use('/api/statements', statements);
app.use('/api/recurring', recurring);
app.use('/api/export', exportTx);
app.use('/api/accounts', accounts);
app.use('/api/rules', rules);

// central error handler -> JSON (zod, NVIDIA, etc.)
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const status = err.status || err.statusCode || (err.name === 'ZodError' ? 400 : 500);
  const message = err.name === 'ZodError' ? err.errors : (err.message || 'Server error');
  if (status >= 500) console.error(err);
  res.status(status).json({ error: message });
});

const port = Number(process.env.PORT) || 5174;
app.listen(port, () => console.log(`API on http://localhost:${port}`));
