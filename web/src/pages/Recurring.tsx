import { useEffect, useState } from 'react';
import { api, type Recurring } from '../api';
import { money } from '../util';

export default function RecurringPage() {
  const [data, setData] = useState<Recurring | null>(null);
  const [err, setErr] = useState('');

  useEffect(() => { api.recurring().then(setData).catch(e => setErr(e.message)); }, []);

  if (err) return <div className="card neg">{err}</div>;
  if (!data) return <div className="muted">Loading…</div>;

  const active = data.subscriptions.filter(s => s.active).length;

  return (
    <div className="stack">
      <div className="grid kpis">
        <div className="card tile"><div className="label">Recurring / month</div><div className="value">{money(data.monthlyTotal)}</div><div className="delta">active subscriptions</div></div>
        <div className="card tile"><div className="label">Active</div><div className="value">{active}</div></div>
        <div className="card tile"><div className="label">Detected</div><div className="value">{data.subscriptions.length}</div></div>
      </div>

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <table>
          <thead>
            <tr><th>Merchant</th><th>Category</th><th>Cadence</th><th className="num">Avg</th><th className="num">Per month</th><th>Next charge</th><th className="num">Seen</th></tr>
          </thead>
          <tbody>
            {data.subscriptions.map((s, i) => (
              <tr key={i} style={{ opacity: s.active ? 1 : 0.5 }}>
                <td>{s.merchant}</td>
                <td><span className="pill">{s.category}</span></td>
                <td className="muted">{s.cadence}</td>
                <td className="num">{money(s.avgAmount)}</td>
                <td className="num" style={{ fontWeight: 600 }}>{money(s.monthlyCost)}</td>
                <td className="muted">{s.active ? s.nextExpected : 'inactive'}</td>
                <td className="num muted">×{s.count}</td>
              </tr>
            ))}
            {!data.subscriptions.length && <tr><td colSpan={7} className="muted" style={{ textAlign: 'center', padding: 32 }}>
              No recurring charges detected yet. Import a few months of statements so patterns can emerge.</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="sub">Detected from your history by charge cadence — average amount shown so variable bills (utilities) are easy to spot.</div>
    </div>
  );
}
