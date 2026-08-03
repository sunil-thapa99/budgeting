import { useEffect, useRef, useState } from 'react';
import { api, type Tx, type TxInput } from '../api';
import { money, fileToScaledDataURL } from '../util';

const empty = (): TxInput => ({
  date: new Date().toISOString().slice(0, 10),
  type: 'expense', amount: 0, category: '', description: '', method: '', source: 'manual',
});

const PAGE = 100;

export default function Transactions({ month, onChange }: { month: string | null; onChange: () => void }) {
  const [rows, setRows] = useState<Tx[]>([]);
  const [total, setTotal] = useState(0);
  const [cats, setCats] = useState<string[]>([]);
  const [q, setQ] = useState('');
  const [page, setPage] = useState(0);
  const [editing, setEditing] = useState<{ id?: number; data: TxInput } | null>(null);
  const [managing, setManaging] = useState(false);
  const [err, setErr] = useState('');

  const loadCats = () => api.categories().then(setCats).catch(() => {});
  const loadRows = () => {
    const query: Record<string, string> = { limit: String(PAGE), offset: String(page * PAGE) };
    if (month) { query.from = `${month}-01`; query.to = `${month}-31`; }
    if (q.trim()) query.q = q.trim();
    api.transactions(query).then(r => { setRows(r.rows); setTotal(r.total); }).catch(e => setErr(e.message));
  };
  const reload = () => { loadRows(); loadCats(); };

  useEffect(() => { loadCats(); }, []);
  useEffect(() => setPage(0), [month, q]);            // any filter change -> back to first page
  useEffect(() => { const t = setTimeout(loadRows, 250); return () => clearTimeout(t); }, [month, q, page]); // debounce search

  const save = async (data: TxInput, id?: number) => {
    try {
      if (id) await api.updateTx(id, data); else await api.createTx(data);
      setEditing(null); reload(); onChange();
    } catch (e: any) { setErr(e.message); }
  };
  const del = async (id: number) => {
    if (!confirm('Delete this transaction?')) return;
    await api.deleteTx(id); reload(); onChange();
  };
  const rename = async (from: string, to: string) => {
    await api.renameCategory(from, to); reload(); onChange();
  };

  const pages = Math.max(1, Math.ceil(total / PAGE));

  return (
    <div className="stack">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div className="section-title" style={{ margin: 0 }}>Transactions {month ? `· ${month}` : ''}</div>
        <div className="row">
          <input className="control" style={{ width: 200 }} placeholder="Search…" value={q}
                 onChange={e => setQ(e.target.value)} />
          <button className="btn ghost" onClick={() => setManaging(true)} title="Rename or merge categories">⚙ Categories</button>
          <a className="btn ghost" href="/api/export?format=csv" download title="Download all transactions as CSV">⬇ Export</a>
          <ReceiptButton onExtract={d => setEditing({ data: d })} onError={setErr} />
          <button className="btn" onClick={() => setEditing({ data: empty() })}>+ Add</button>
        </div>
      </div>
      {err && <div className="card neg">{err}</div>}

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <table>
          <thead>
            <tr><th>Date</th><th>Description</th><th>Category</th><th>Type</th><th className="num">Amount</th><th></th></tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.id}>
                <td className="muted">{r.date}</td>
                <td>{r.description || <span className="muted">—</span>}</td>
                <td><span className="pill">{r.category}</span></td>
                <td><span className={`pill ${r.type === 'income' ? 'income' : ''}`}>{r.type}</span></td>
                <td className="num" style={{ fontWeight: 600 }}>{r.type === 'income' ? '+' : '−'}{money(r.amount)}</td>
                <td className="num">
                  <button className="btn ghost icon" title="Edit" onClick={() => setEditing({ id: r.id, data: r })}>✎</button>
                  <button className="btn ghost icon" title="Delete" onClick={() => del(r.id)}>🗑</button>
                </td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 32 }}>
              {q.trim() ? 'No matches.' : `No transactions ${month ? 'this month' : 'yet'}. Add one or import your sheet.`}</td></tr>}
          </tbody>
        </table>
      </div>

      {total > 0 && (
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div className="muted">
            {total.toLocaleString()} transaction{total === 1 ? '' : 's'}
            {pages > 1 && ` · showing ${page * PAGE + 1}–${Math.min((page + 1) * PAGE, total)}`}
          </div>
          {pages > 1 && (
            <div className="row">
              <button className="btn ghost" disabled={page === 0} onClick={() => setPage(p => p - 1)}>← Prev</button>
              <span className="muted">Page {page + 1} / {pages}</span>
              <button className="btn ghost" disabled={page >= pages - 1} onClick={() => setPage(p => p + 1)}>Next →</button>
            </div>
          )}
        </div>
      )}

      {editing && <TxForm init={editing.data} id={editing.id} cats={cats}
                    onClose={() => setEditing(null)} onSave={save} />}
      {managing && <CategoryManager cats={cats} onRename={rename} onClose={() => setManaging(false)} />}
    </div>
  );
}

function CategoryManager({ cats, onRename, onClose }:
  { cats: string[]; onRename: (from: string, to: string) => Promise<void>; onClose: () => void }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (from: string) => {
    const target = to.trim();
    if (!target || target === from) { setEditing(null); return; }
    if (cats.includes(target) && !confirm(`Merge "${from}" into existing "${target}"? This can't be undone.`)) return;
    setBusy(true);
    try { await onRename(from, target); setEditing(null); } finally { setBusy(false); }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="card modal" onClick={e => e.stopPropagation()}>
        <h3 style={{ marginBottom: 6 }}>Manage categories</h3>
        <div className="sub" style={{ marginBottom: 12 }}>Rename to clean up sprawl; rename to an existing name to merge.</div>
        <div className="stack" style={{ maxHeight: 360, overflow: 'auto', gap: 6 }}>
          {cats.map(c => (
            <div key={c} className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
              {editing === c ? (
                <>
                  <input className="control" style={{ flex: 1 }} autoFocus value={to}
                         onChange={e => setTo(e.target.value)}
                         onKeyDown={e => { if (e.key === 'Enter') submit(c); if (e.key === 'Escape') setEditing(null); }} />
                  <button className="btn" disabled={busy} onClick={() => submit(c)}>{busy ? '…' : 'Save'}</button>
                  <button className="btn ghost" onClick={() => setEditing(null)}>Cancel</button>
                </>
              ) : (
                <>
                  <span className="pill">{c}</span>
                  <button className="btn ghost icon" title="Rename / merge" onClick={() => { setEditing(c); setTo(c); }}>✎</button>
                </>
              )}
            </div>
          ))}
          {!cats.length && <div className="muted">No categories yet.</div>}
        </div>
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
          <button className="btn ghost" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

function TxForm({ init, id, cats, onClose, onSave }:
  { init: TxInput; id?: number; cats: string[]; onClose: () => void; onSave: (d: TxInput, id?: number) => void }) {
  const [d, setD] = useState<TxInput>(init);
  const set = (k: keyof TxInput, v: any) => setD(p => ({ ...p, [k]: v }));
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="card modal" onClick={e => e.stopPropagation()}>
        <h3 style={{ marginBottom: 14 }}>{id ? 'Edit' : 'Add'} transaction</h3>
        <div className="row" style={{ gap: 12 }}>
          <div className="field" style={{ flex: 1 }}>
            <label>Type</label>
            <select className="control" value={d.type} onChange={e => set('type', e.target.value)}>
              <option value="expense">Expense</option><option value="income">Income</option>
            </select>
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label>Amount</label>
            <input className="control" type="number" step="0.01" min="0" value={d.amount || ''}
                   onChange={e => set('amount', parseFloat(e.target.value) || 0)} />
          </div>
        </div>
        <div className="row" style={{ gap: 12 }}>
          <div className="field" style={{ flex: 1 }}>
            <label>Date</label>
            <input className="control" type="date" value={d.date} onChange={e => set('date', e.target.value)} />
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label>Category</label>
            <input className="control" list="catlist" value={d.category} onChange={e => set('category', e.target.value)} placeholder="e.g. Groceries" />
            <datalist id="catlist">{cats.map(c => <option key={c} value={c} />)}</datalist>
          </div>
        </div>
        <div className="field">
          <label>Description</label>
          <input className="control" value={d.description} onChange={e => set('description', e.target.value)} placeholder="Vendor / note" />
        </div>
        <div className="field">
          <label>Payment method</label>
          <input className="control" value={d.method} onChange={e => set('method', e.target.value)} placeholder="Card / cash…" />
        </div>
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 8 }}>
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn" disabled={!d.amount || !d.category} onClick={() => onSave(d, id)}>Save</button>
        </div>
      </div>
    </div>
  );
}

function ReceiptButton({ onExtract, onError }: { onExtract: (d: TxInput) => void; onError: (m: string) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const pick = async (file: File) => {
    setBusy(true); onError('');
    try {
      const img = await fileToScaledDataURL(file);
      const r = await api.scanReceipt(img);
      onExtract({
        date: r.date || new Date().toISOString().slice(0, 10),
        type: 'expense',
        amount: r.total || 0,
        category: r.category || 'Miscellaneous',
        description: r.merchant || '',
        method: '', source: 'receipt',
      });
    } catch (e: any) {
      onError(e.message.includes('NVIDIA_API_KEY') ? 'Add your NVIDIA API key to server/.env to scan receipts.' : e.message);
    } finally { setBusy(false); if (ref.current) ref.current.value = ''; }
  };
  return (
    <>
      <input ref={ref} type="file" accept="image/*" capture="environment" hidden
             onChange={e => e.target.files?.[0] && pick(e.target.files[0])} />
      <button className="btn secondary" disabled={busy} onClick={() => ref.current?.click()}>
        {busy ? <><span className="spin" /> Scanning…</> : '📷 Scan receipt'}
      </button>
    </>
  );
}
