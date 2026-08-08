import { Router } from 'express';
import { z } from 'zod';
import { db, uid } from '../db.js';

const router = Router();

export type Account = { name: string; type: string; opening: number; balance: number; configured: boolean };
type Cfg = { name: string; type: string; opening_balance: number };
type Flow = { name: string; flow: number };
type Monthly = { month: string; delta: number };

const round = (n: number) => Math.round(n * 100) / 100;

// Pure core: derive balances + net-worth series from configured accounts, per-account flow,
// and cumulative monthly flow. Balance = opening + Σ(income − expense). A credit card goes
// negative as you spend, so it subtracts from net worth. Kept pure so it's testable.
export function computeAccounts(cfgRows: Cfg[], flows: Flow[], monthly: Monthly[]) {
  const cfg = new Map(cfgRows.map(a => [a.name, a] as const));
  const flowOf = new Map(flows.map(f => [f.name, f.flow] as const));
  const names = [...new Set([...cfg.keys(), ...flows.map(f => f.name)])];

  const accounts: Account[] = names.map(name => {
    const c = cfg.get(name);
    const opening = c?.opening_balance ?? 0;
    const flow = flowOf.get(name) ?? 0;
    return { name, type: c?.type ?? 'asset', opening, balance: opening + flow, configured: !!c };
  }).sort((a, b) => b.balance - a.balance);

  const netWorth = round(accounts.reduce((s, a) => s + a.balance, 0));

  const totalOpening = accounts.reduce((s, a) => s + a.opening, 0);
  let run = 0;
  const series = monthly.map(m => { run += m.delta; return { month: m.month, netWorth: round(totalOpening + run) }; });

  return { accounts: accounts.map(a => ({ ...a, balance: round(a.balance) })), netWorth, series };
}

// Derived-balance net worth (transfers included — they still move money between accounts).
export async function accountsSummary() {
  const u = uid();
  const cfg = await db.all<Cfg>('SELECT name, type, opening_balance FROM budget_app_accounts WHERE user_id=?', [u]);
  const flows = await db.all<Flow>(
    `SELECT account AS name, COALESCE(SUM(CASE WHEN type='income' THEN amount ELSE -amount END),0) AS flow
     FROM budget_app_transactions WHERE user_id=? AND account<>'' GROUP BY account`, [u]);
  const monthly = await db.all<Monthly>(
    `SELECT to_char(date,'YYYY-MM') AS month,
       COALESCE(SUM(CASE WHEN type='income' THEN amount ELSE -amount END),0) AS delta
     FROM budget_app_transactions WHERE user_id=? AND account<>'' GROUP BY month ORDER BY month`, [u]);
  return computeAccounts(cfg, flows, monthly);
}

router.get('/', async (_req, res, next) => {
  try { res.json(await accountsSummary()); } catch (err) { next(err); }
});

router.put('/:name', async (req, res, next) => {
  try {
    const { type, opening_balance } = z.object({
      type: z.enum(['asset', 'credit', 'investment', 'cash']),
      opening_balance: z.number(),
    }).parse(req.body);
    await db.run(`INSERT INTO budget_app_accounts (user_id, name, type, opening_balance, updated_at) VALUES (?,?,?,?,now())
      ON CONFLICT (user_id, name) DO UPDATE SET type=excluded.type, opening_balance=excluded.opening_balance, updated_at=excluded.updated_at`,
      [uid(), req.params.name, type, opening_balance]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

export default router;

// ponytail: derived model is only as complete as imported data — a payment from an
// unimported account, or an asset with no transaction feed (house, 401k), won't show.
// Add manual balance snapshots if those matter.
