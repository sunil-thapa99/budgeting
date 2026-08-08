import pg from 'pg';
import { AsyncLocalStorage } from 'node:async_hooks';
import 'dotenv/config';

// Postgres (Supabase). Backend connects with the service role, so it scopes every
// query by user_id in code (see uid()); RLS is defense-in-depth on top of that.

// Return JS numbers/strings, not driver defaults, so the rest of the code is unchanged:
pg.types.setTypeParser(1700, parseFloat);          // numeric  -> number (money)
pg.types.setTypeParser(20, (v) => parseInt(v, 10)); // int8/bigint -> number (ids, counts)
pg.types.setTypeParser(1082, (v) => v);            // date -> keep 'YYYY-MM-DD' string

const url = process.env.DATABASE_URL || '';
const pool = new pg.Pool({
  connectionString: url,
  // Supabase requires TLS; local Postgres doesn't. ponytail: rejectUnauthorized:false is
  // fine for Supabase's managed cert — tighten with a CA bundle if you self-host.
  ssl: url.includes('localhost') || url.includes('127.0.0.1') ? false : { rejectUnauthorized: false },
});

// The old sqlite code used `?` placeholders; rewrite to Postgres `$1,$2,...` positionally.
// (No SQL string in this codebase contains a literal `?`, so this is safe.)
const subst = (sql: string) => { let i = 0; return sql.replace(/\?/g, () => '$' + ++i); };

type Q = (sql: string, params?: any[]) => Promise<any>;
type Handle = {
  all: <T = any>(sql: string, params?: any[]) => Promise<T[]>;
  get: <T = any>(sql: string, params?: any[]) => Promise<T | undefined>;
  run: (sql: string, params?: any[]) => Promise<{ changes: number; rows: any[] }>;
};
const bind = (q: Q): Handle => ({
  all: async (sql, params = []) => (await q(subst(sql), params)).rows,
  get: async (sql, params = []) => (await q(subst(sql), params)).rows[0],
  run: async (sql, params = []) => { const r = await q(subst(sql), params); return { changes: r.rowCount ?? 0, rows: r.rows }; },
});

/** Default handle — one query, its own pooled connection. */
export const db = bind((sql, params) => pool.query(sql, params));

/** Run `fn` inside a single transaction; every query in it uses the same connection. */
export async function tx<T>(fn: (h: Handle) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(bind((sql, params) => client.query(sql, params)));
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// Current request's user, carried through async calls so DB helpers can scope by it
// without threading userId through every function signature.
export const authCtx = new AsyncLocalStorage<{ userId: string }>();
export function uid(): string {
  const s = authCtx.getStore();
  if (!s) throw Object.assign(new Error('No auth context'), { status: 401 });
  return s.userId;
}

export type Transaction = {
  id: number;
  date: string;
  type: 'expense' | 'income';
  amount: number;
  category: string;
  description: string;
  method: string;
  source: string;
  account: string;
  ext_id: string | null;
  excluded: number;   // 0 | 1
  created_at: string;
};
