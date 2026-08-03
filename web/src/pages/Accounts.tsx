import { useEffect, useState } from 'react';
import { api, type Accounts, type Account } from '../api';
import { money } from '../util';
import { NetWorthChart } from '../charts';

const TYPES = ['asset', 'credit', 'investment', 'cash'];

export default function AccountsPage() {
  const [data, setData] = useState<Accounts | null>(null);
  const [err, setErr] = useState('');

  const load = () => api.accounts().then(setData).catch(e => setErr(e.message));
  useEffect(() => { load(); }, []);

  if (err) return <div className="card neg">{err}</div>;
  if (!data) return <div className="muted">Loading…</div>;

  const save = async (name: string, type: string, opening: number) => {
    await api.saveAccount(name, type, opening); load();
  };

  return (
    <div className="stack">
      <div className="grid kpis">
        <div className="card tile">
          <div className="label">Net worth</div>
          <div className={`value ${data.netWorth >= 0 ? 'pos' : 'neg'}`}>{money(data.netWorth)}</div>
          <div className="delta">across {data.accounts.length} account{data.accounts.length === 1 ? '' : 's'}</div>
        </div>
      </div>

      <div className="card">
        <h3>Net worth over time</h3>
        <div className="sub">Opening balances + cumulative account flow, by month</div>
        <NetWorthChart data={data.series} />
      </div>

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <table>
          <thead>
            <tr><th>Account</th><th>Type</th><th className="num">Opening balance</th><th className="num">Current balance</th></tr>
          </thead>
          <tbody>
            {data.accounts.map(a => <Row key={a.name} a={a} onSave={save} />)}
            {!data.accounts.length && <tr><td colSpan={4} className="muted" style={{ textAlign: 'center', padding: 32 }}>
              No accounts yet. Import statements — each account is discovered automatically, then set its opening balance here.</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="sub">Balances are derived from your transactions. Set an opening balance to make them absolute; a credit card shows as negative (debt).</div>
    </div>
  );
}

function Row({ a, onSave }: { a: Account; onSave: (name: string, type: string, opening: number) => Promise<void> }) {
  const [type, setType] = useState(a.type);
  const [opening, setOpening] = useState(String(a.opening));
  const dirty = type !== a.type || Number(opening) !== a.opening;

  return (
    <tr>
      <td>{a.name}{!a.configured && <span className="pill" style={{ marginLeft: 8, opacity: .7 }}>unset</span>}</td>
      <td>
        <select className="control" value={type} onChange={e => setType(e.target.value)}>
          {TYPES.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
      </td>
      <td className="num">
        <input className="control" type="number" step="0.01" style={{ width: 130, textAlign: 'right' }}
               value={opening} onChange={e => setOpening(e.target.value)} />
      </td>
      <td className="num" style={{ fontWeight: 600 }}>
        <span className={a.balance < 0 ? 'neg' : ''}>{money(a.balance)}</span>
        {dirty && <button className="btn ghost icon" title="Save" style={{ marginLeft: 8 }}
                          onClick={() => onSave(a.name, type, Number(opening) || 0)}>✓</button>}
      </td>
    </tr>
  );
}
