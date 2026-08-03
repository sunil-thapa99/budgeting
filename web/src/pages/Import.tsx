import { useState } from 'react';
import { api } from '../api';
import { money0, monthLabel } from '../util';

type Preview = Awaited<ReturnType<typeof api.importPreview>>;

export default function ImportPage({ onDone }: { onDone: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [drag, setDrag] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [done, setDone] = useState<{ transactions: number; budgets: number } | null>(null);

  const choose = async (f: File) => {
    setErr(''); setDone(null); setFile(f); setPreview([]); setBusy(true);
    try {
      const p = await api.importPreview(f);
      setPreview(p);
      setPicked(new Set(p.map(x => x.sheet)));
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };

  const commit = async () => {
    if (!file || !picked.size) return;
    setBusy(true); setErr('');
    try {
      const r = await api.importCommit(file, [...picked]);
      setDone({ transactions: r.transactions, budgets: r.budgets });
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };

  const toggle = (s: string) => setPicked(p => { const n = new Set(p); n.has(s) ? n.delete(s) : n.add(s); return n; });

  return (
    <div className="stack" style={{ maxWidth: 720 }}>
      <div className="section-title" style={{ margin: 0 }}>Import from Excel</div>
      <div className="muted" style={{ marginTop: -8 }}>
        Upload your budget spreadsheet (.xlsx). Each monthly tab becomes transactions + category budgets.
        Re-importing replaces previously imported data.
      </div>

      <label
        className={`dropzone ${drag ? 'drag' : ''}`}
        onDragOver={e => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={e => { e.preventDefault(); setDrag(false); const f = e.dataTransfer.files?.[0]; if (f) choose(f); }}
      >
        <input type="file" accept=".xlsx" hidden onChange={e => e.target.files?.[0] && choose(e.target.files[0])} />
        <div style={{ fontSize: 15, fontWeight: 600 }}>{file ? file.name : 'Drop your .xlsx here or click to browse'}</div>
        <div className="muted" style={{ marginTop: 4 }}>Only actual (paid) rows and expected budgets are imported.</div>
      </label>

      {busy && !preview.length && <div className="muted"><span className="spin" /> Reading workbook…</div>}
      {err && <div className="card neg">{err}</div>}

      {preview.length > 0 && !done && (
        <div className="card">
          <h3>Select tabs to import</h3>
          <div className="sub">Your workbook has multiple people/months — pick what’s yours.</div>
          <table>
            <thead><tr><th></th><th>Tab</th><th>Month</th><th className="num">Expenses</th><th className="num">Income</th><th className="num">Budgets</th><th className="num">Total spent</th></tr></thead>
            <tbody>
              {preview.map(p => (
                <tr key={p.sheet} style={{ cursor: 'pointer' }} onClick={() => toggle(p.sheet)}>
                  <td><input type="checkbox" checked={picked.has(p.sheet)} onChange={() => toggle(p.sheet)} onClick={e => e.stopPropagation()} /></td>
                  <td style={{ fontWeight: 600 }}>{p.sheet}</td>
                  <td className="muted">{monthLabel(p.month)}</td>
                  <td className="num">{p.expenses}</td>
                  <td className="num">{p.income}</td>
                  <td className="num">{p.budgets}</td>
                  <td className="num" style={{ fontWeight: 600 }}>{money0(p.expenseTotal)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 14 }}>
            <button className="btn" disabled={busy || !picked.size} onClick={commit}>
              {busy ? <><span className="spin" /> Importing…</> : `Import ${picked.size} tab${picked.size === 1 ? '' : 's'}`}
            </button>
          </div>
        </div>
      )}

      {done && (
        <div className="card">
          <h3 className="pos">✓ Imported</h3>
          <div className="sub">Added {done.transactions} transactions and {done.budgets} category budgets.</div>
          <button className="btn" onClick={onDone}>Go to dashboard</button>
        </div>
      )}
    </div>
  );
}
