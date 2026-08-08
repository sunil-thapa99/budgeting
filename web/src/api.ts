export type Tx = {
  id: number;
  date: string;
  type: 'expense' | 'income';
  amount: number;
  category: string;
  description: string;
  method: string;
  source: string;
  account?: string;
  excluded?: number;
  parent_id?: number | null;
  split_count?: number;
  created_at: string;
};

export type Recurring = {
  monthlyTotal: number;
  subscriptions: {
    merchant: string; category: string; cadence: string;
    avgAmount: number; monthlyCost: number; lastDate: string;
    nextExpected: string; count: number; active: boolean;
  }[];
};

export type Summary = {
  month: string | null;
  months: string[];
  totals: { income: number; expense: number; net: number; savingsRate: number };
  byCategory: { category: string; amount: number }[];
  trend: { month: string; income: number; expense: number }[];
  budgetVsActual: { category: string; expected: number; actual: number; rollover: number; available: number }[];
};

export type Account = { name: string; type: string; opening: number; balance: number; configured: boolean };
export type Accounts = {
  accounts: Account[];
  netWorth: number;
  series: { month: string; netWorth: number }[];
};

export type ReceiptResult = {
  merchant: string | null;
  date: string | null;
  total: number | null;
  currency: string;
  category: string;
  raw: string;
};

import { getCurrency } from './util';
import { supabase } from './supabase';

// In dev, Vite proxies /api -> :5174. In production set VITE_API_URL to the backend origin.
const BASE = import.meta.env.VITE_API_URL ?? '';

async function send(url: string, init: RequestInit | undefined, token?: string) {
  const headers = new Headers(init?.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  return fetch(BASE + url, { ...init, headers });
}

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const { data } = await supabase.auth.getSession();
  let res = await send(url, init, data.session?.access_token);
  // Access token likely expired (idle tab). Refresh once and retry before giving up. init.body is a
  // JSON string or FormData here, both re-sendable — so the same init can be replayed.
  if (res.status === 401) {
    const { data: r } = await supabase.auth.refreshSession();
    if (r.session?.access_token) res = await send(url, init, r.session.access_token);
  }
  if (res.status === 401) { await supabase.auth.signOut(); throw new Error('Session expired — please sign in again.'); }
  if (!res.ok) {
    let msg = res.statusText;
    try { const j = await res.json(); msg = typeof j.error === 'string' ? j.error : JSON.stringify(j.error); } catch {}
    throw new Error(msg);
  }
  return res.status === 204 ? (undefined as T) : res.json();
}

const json = (body: unknown): RequestInit => ({
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

export type TxInput = Omit<Tx, 'id' | 'created_at'>;

export const api = {
  summary: (month?: string) => req<Summary>(`/api/summary${month ? `?month=${month}` : ''}`),
  transactions: (q: Record<string, string> = {}) =>
    req<{ rows: Tx[]; total: number }>(`/api/transactions?${new URLSearchParams(q)}`),
  categories: () => req<string[]>('/api/transactions/meta/categories'),
  renameCategory: (from: string, to: string) =>
    req<{ ok: boolean; moved: number }>('/api/transactions/meta/categories/rename', json({ from, to })),
  rules: () => req<{ keyword: string; category: string }[]>('/api/rules'),
  addRule: (keyword: string, category: string) => req<{ ok: boolean; applied: number }>('/api/rules', json({ keyword, category })),
  deleteRule: (keyword: string) => req<void>(`/api/rules/${encodeURIComponent(keyword)}`, { method: 'DELETE' }),
  recurring: () => req<Recurring>('/api/recurring'),
  accounts: () => req<Accounts>('/api/accounts'),
  saveAccount: (name: string, type: string, opening_balance: number) =>
    req<{ ok: boolean }>(`/api/accounts/${encodeURIComponent(name)}`, { ...json({ type, opening_balance }), method: 'PUT' }),
  createTx: (t: TxInput) => req<Tx>('/api/transactions', json(t)),
  updateTx: (id: number, t: TxInput) => req<{ row: Tx; propagated: number }>(`/api/transactions/${id}`, { ...json(t), method: 'PUT' }),
  deleteTx: (id: number) => req<void>(`/api/transactions/${id}`, { method: 'DELETE' }),
  splits: (id: number) => req<Tx[]>(`/api/transactions/${id}/splits`),
  saveSplit: (id: number, splits: { category: string; amount: number }[]) =>
    req<{ ok: boolean; splits: number }>(`/api/transactions/${id}/split`, json({ splits })),
  insights: (month: string | null, question?: string) =>
    req<{ text: string; model: string }>('/api/insights', json({ month, question, currency: getCurrency() })),
  scanReceipt: (image: string) => req<ReceiptResult>('/api/receipt', json({ image })),
  importPreview: (file: File) => {
    const fd = new FormData(); fd.append('file', file);
    return req<{ sheet: string; month: string; income: number; expenses: number; budgets: number; expenseTotal: number }[]>(
      '/api/import/preview', { method: 'POST', body: fd });
  },
  importCommit: (file: File, sheets: string[]) => {
    const fd = new FormData(); fd.append('file', file); fd.append('sheets', JSON.stringify(sheets));
    return req<{ sheets: string[]; transactions: number; budgets: number }>('/api/import', { method: 'POST', body: fd });
  },
  stmtCategories: () => req<string[]>('/api/statements/categories'),
  stmtPreview: (files: File[]) => {
    const fd = new FormData(); files.forEach(f => fd.append('files', f));
    return req<{ files: { file: string; account: string; rows: ProposedTx[] }[]; categories: string[] }>(
      '/api/statements/preview', { method: 'POST', body: fd });
  },
  stmtCommit: (rows: ProposedTx[]) =>
    req<{ inserted: number; skipped: number }>('/api/statements/commit', json({ rows })),
};

export type ProposedTx = {
  date: string; description: string; amount: number;
  direction: 'out' | 'in'; account: string; extId: string;
  type: 'expense' | 'income'; category: string;
  excluded: boolean; reason?: string;
  duplicate?: 'imported' | 'possible';
};
