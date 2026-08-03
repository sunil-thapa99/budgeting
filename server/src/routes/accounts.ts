import { Router } from 'express';
import { z } from 'zod';
import db from '../db.js';

const router = Router();

type DB = typeof db;
export type Account = { name: string; type: string; opening: number; balance: number; configured: boolean };

// Derived-balance net worth. Balance = opening + Σ(income − expense) over the account's
// transactions (excluded transfers included — they still move money between accounts).
// A credit card naturally goes negative as you spend, so it subtracts from net worth.
export function accountsSummary(database: DB): { accounts: Account[]; netWorth: number; series: { month: string; netWorth: number }[] } {
  const cfg = new Map(
    (database.prepare('SELECT name, type, opening_balance FROM accounts').all() as { name: string; type: string; opening_balance: number }[])
      .map(a => [a.name, a] as const)
  );
  const discovered = (database.prepare(`SELECT DISTINCT account AS name FROM transactions WHERE account<>''`).all() as { name: string }[]).map(r => r.name);
  const names = [...new Set([...cfg.keys(), ...discovered])];

  const flowStmt = database.prepare(`SELECT COALESCE(SUM(CASE WHEN type='income' THEN amount ELSE -amount END),0) AS flow
    FROM transactions WHERE account=?`);
  const accounts: Account[] = names.map(name => {
    const c = cfg.get(name);
    const opening = c?.opening_balance ?? 0;
    const flow = (flowStmt.get(name) as { flow: number }).flow;
    return { name, type: c?.type ?? 'asset', opening, balance: opening + flow, configured: !!c };
  }).sort((a, b) => b.balance - a.balance);

  const netWorth = round(accounts.reduce((s, a) => s + a.balance, 0));

  // Net worth over time: total openings + cumulative monthly flow across tracked accounts.
  const totalOpening = accounts.reduce((s, a) => s + a.opening, 0);
  const monthly = database.prepare(`SELECT strftime('%Y-%m',date) AS month,
      COALESCE(SUM(CASE WHEN type='income' THEN amount ELSE -amount END),0) AS delta
    FROM transactions WHERE account<>'' GROUP BY month ORDER BY month`).all() as { month: string; delta: number }[];
  let run = 0;
  const series = monthly.map(m => { run += m.delta; return { month: m.month, netWorth: round(totalOpening + run) }; });

  return { accounts: accounts.map(a => ({ ...a, balance: round(a.balance) })), netWorth, series };
}

const round = (n: number) => Math.round(n * 100) / 100;

router.get('/', (_req, res) => res.json(accountsSummary(db)));

router.put('/:name', (req, res) => {
  const { type, opening_balance } = z.object({
    type: z.enum(['asset', 'credit', 'investment', 'cash']),
    opening_balance: z.number(),
  }).parse(req.body);
  db.prepare(`INSERT INTO accounts (name, type, opening_balance, updated_at) VALUES (?,?,?,datetime('now'))
    ON CONFLICT(name) DO UPDATE SET type=excluded.type, opening_balance=excluded.opening_balance, updated_at=excluded.updated_at`)
    .run(req.params.name, type, opening_balance);
  res.json({ ok: true });
});

export default router;

// ponytail: derived model is only as complete as imported data — a payment from an
// unimported account, or an asset with no transaction feed (house, 401k), won't show.
// Add manual balance snapshots if those matter.
