import { useMemo, useState } from 'react';
import { api, type ProposedTx } from '../api';
import { money, monthLabel } from '../util';
import { toast } from '../toast';

type Item = ProposedTx & { _id: number; import: boolean };

export default function Statements({ onDone }: { onDone: () => void }) {
  const [items, setItems] = useState<Item[]>([]);
  const [cats, setCats] = useState<string[]>([]);
  const [drag, setDrag] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [done, setDone] = useState<{ inserted: number; skipped: number } | null>(null);
  const [showTransfers, setShowTransfers] = useState(false);
  const [fileFilter, setFileFilter] = useState('');

  const upload = async (files: File[]) => {
    setErr(''); setDone(null); setBusy(true); setItems([]);
    try {
      const res = await api.stmtPreview(files);
      const flat: Item[] = [];
      let id = 0;
      for (const f of res.files)
        for (const r of f.rows)
          flat.push({ ...r, _id: id++, import: r.duplicate !== 'imported' }); // skip already-imported by default
      setItems(flat);
      setCats([...res.categories, 'Income', 'Reimbursement', 'Investment', 'Transfer']);
      toast.success(`Read ${flat.length} transaction${flat.length === 1 ? '' : 's'} from ${files.length} file${files.length === 1 ? '' : 's'}`);
    } catch (e: any) {
      const m = e.message.includes('NVIDIA_API_KEY') ? 'Add your NVIDIA API key to server/.env to categorize statements.' : e.message;
      setErr(m); toast.error(`Upload failed: ${m}`);
    }
    finally { setBusy(false); }
  };

  const set = (id: number, patch: Partial<Item>) =>
    setItems(list => list.map(it => it._id === id ? { ...it, ...patch } : it));

  // #1: explicit expense / income / transfer control per row
  const setKind = (id: number, kind: 'Expense' | 'Income' | 'Transfer') => set(id,
    kind === 'Income'   ? { type: 'income', excluded: false, category: 'Income' }
  : kind === 'Transfer' ? { excluded: true, category: 'Transfer' }
  :                       { type: 'expense', excluded: false, category: 'Miscellaneous' });
  const kindOf = (it: Item): 'Expense' | 'Income' | 'Transfer' =>
    it.excluded ? 'Transfer' : it.type === 'income' ? 'Income' : 'Expense';

  // #1: flip income<->expense for the rows currently shown (fixes a whole account read backwards)
  const flipVisible = () => setItems(list => list.map(it =>
    (showTransfers || !it.excluded) && (!fileFilter || it.account === fileFilter) && !it.excluded
      ? { ...it, type: it.type === 'income' ? 'expense' : 'income' } : it));

  const files = useMemo(() => [...new Set(items.map(i => i.account))], [items]);
  const visible = items.filter(i =>
    (showTransfers || !i.excluded) && (!fileFilter || i.account === fileFilter));

  const toImport = items.filter(i => i.import);
  const spend = toImport.filter(i => !i.excluded && i.type === 'expense').reduce((s, i) => s + i.amount, 0);
  const income = toImport.filter(i => !i.excluded && i.type === 'income').reduce((s, i) => s + i.amount, 0);
  const transfers = toImport.filter(i => i.excluded).length;
  const dupes = items.filter(i => i.duplicate).length;

  const commit = async () => {
    setBusy(true); setErr('');
    try {
      // row.type / excluded / category are kept consistent by the Type + Category controls
      const rows: ProposedTx[] = toImport.map(({ _id, import: _imp, ...r }) => r);
      const res = await api.stmtCommit(rows);
      setDone(res);
      toast.success(`Imported ${res.inserted} transaction${res.inserted === 1 ? '' : 's'}${res.skipped ? `, skipped ${res.skipped}` : ''}`);
    } catch (e: any) { setErr(e.message); toast.error(`Import failed: ${e.message}`); } finally { setBusy(false); }
  };

  if (done) return (
    <div className="stack" style={{ maxWidth: 560 }}>
      <div className="card">
        <h3 className="pos">✓ Statements imported</h3>
        <div className="sub">Added {done.inserted} transactions{done.skipped ? `, skipped ${done.skipped} already-imported` : ''}.</div>
        <div className="row">
          <button className="btn" onClick={onDone}>Go to dashboard</button>
          <button className="btn ghost" onClick={() => { setItems([]); setDone(null); }}>Import more</button>
        </div>
      </div>
    </div>
  );

  return (
    <div className="stack">
      <div className="section-title" style={{ margin: 0 }}>Import bank & card statements</div>
      <div className="muted" style={{ marginTop: -8 }}>
        Upload Discover / Chase / Capital One exports (.csv or .pdf). Transactions are auto-categorized;
        transfers and credit-card payments are flagged so they don’t double-count your spending. Nothing saves until you click import.
      </div>

      {!items.length && (
        <label className={`dropzone ${drag ? 'drag' : ''}`}
          onDragOver={e => { e.preventDefault(); setDrag(true); }}
          onDragLeave={() => setDrag(false)}
          onDrop={e => { e.preventDefault(); setDrag(false); const fs = [...e.dataTransfer.files]; if (fs.length) upload(fs); }}>
          <input type="file" accept=".csv,.pdf" multiple hidden onChange={e => e.target.files && upload([...e.target.files])} />
          <div style={{ fontSize: 15, fontWeight: 600 }}>Drop statement files here or click to browse</div>
          <div className="muted" style={{ marginTop: 4 }}>Multiple files at once. CSV or PDF.</div>
        </label>
      )}

      {busy && !items.length && <div className="muted"><span className="spin" /> Reading & categorizing… (a few seconds)</div>}
      {err && <div className="card neg">{err}</div>}

      {items.length > 0 && (
        <>
          <div className="grid kpis">
            <Mini label="To import" value={String(toImport.length)} sub={`of ${items.length} rows`} />
            <Mini label="Spending" value={money(spend)} cls="neg" />
            <Mini label="Income" value={money(income)} cls="pos" />
            <Mini label="Transfers excluded" value={String(transfers)} sub={dupes ? `${dupes} possible dupes` : 'no dupes'} />
          </div>

          <div className="card" style={{ padding: 12 }}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <div className="row">
                <select className="control" value={fileFilter} onChange={e => setFileFilter(e.target.value)}>
                  <option value="">All accounts</option>
                  {files.map(f => <option key={f} value={f}>{f}</option>)}
                </select>
                <label className="row" style={{ gap: 6 }}>
                  <input type="checkbox" checked={showTransfers} onChange={e => setShowTransfers(e.target.checked)} />
                  <span className="muted">Show transfers/payments</span>
                </label>
              </div>
              <div className="row">
                <button className="btn ghost" onClick={flipVisible}
                  title="Swap income⇄expense for the rows shown — fixes an account whose signs were read backwards">⇅ Flip income/expense</button>
                <button className="btn ghost" onClick={() => setItems(l => l.map(i => ({ ...i, import: true })))}>Select all</button>
                <button className="btn ghost" onClick={() => setItems(l => l.map(i => ({ ...i, import: false })))}>None</button>
                <button className="btn" disabled={busy || !toImport.length} onClick={commit}>
                  {busy ? <><span className="spin" /> Importing…</> : `Import ${toImport.length}`}
                </button>
              </div>
            </div>
          </div>

          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            <table>
              <thead><tr>
                <th style={{ width: 34 }}></th><th>Date</th><th>Description</th><th>Account</th>
                <th className="num">Amount</th><th>Type</th><th>Category</th><th></th>
              </tr></thead>
              <tbody>
                {visible.map(it => (
                  <tr key={it._id} style={{ opacity: it.import ? 1 : .5 }}>
                    <td><input type="checkbox" checked={it.import} onChange={e => set(it._id, { import: e.target.checked })} /></td>
                    <td className="muted">{it.date}</td>
                    <td title={it.description}>{it.description.slice(0, 44)}{it.description.length > 44 ? '…' : ''}</td>
                    <td className="muted">{it.account}</td>
                    <td className="num" style={{ fontWeight: 600, color: it.excluded ? 'var(--text-muted)' : it.type === 'income' ? 'var(--good)' : 'inherit' }}>
                      {it.type === 'income' ? '+' : '−'}{money(it.amount)}
                    </td>
                    <td>
                      <select className="control" style={{ padding: '4px 8px' }} value={kindOf(it)}
                        onChange={e => setKind(it._id, e.target.value as any)}>
                        <option>Expense</option><option>Income</option><option>Transfer</option>
                      </select>
                    </td>
                    <td>
                      <select className="control" style={{ padding: '4px 8px' }} value={it.category} disabled={it.excluded}
                        onChange={e => { const c = e.target.value; const mv = c === 'Transfer' || c === 'Reimbursement' || c === 'Investment'; set(it._id, { category: c, excluded: mv, type: (c === 'Income' || c === 'Reimbursement') ? 'income' : 'expense' }); }}>
                        {[...new Set([it.category, ...cats])].map(c => <option key={c} value={c}>{c}</option>)}
                      </select>
                    </td>
                    <td>
                      {it.excluded && <span className="pill" title={it.reason}>transfer</span>}
                      {it.duplicate === 'imported' && <span className="pill" style={{ color: 'var(--bad)' }}>already imported</span>}
                      {it.duplicate === 'possible' && <span className="pill" style={{ color: 'var(--s4)' }}>possible dupe</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function Mini({ label, value, sub, cls }: { label: string; value: string; sub?: string; cls?: string }) {
  return (
    <div className="card tile">
      <div className="label">{label}</div>
      <div className={`value ${cls || ''}`} style={{ fontSize: 22 }}>{value}</div>
      {sub && <div className="delta muted">{sub}</div>}
    </div>
  );
}
