import { useEffect, useState } from 'react';
import { api, type Summary } from '../api';
import { money, pct, monthLabel } from '../util';
import { CategoryChart, TrendChart, BudgetChart } from '../charts';

export default function Dashboard({ month }: { month: string | null }) {
  const [s, setS] = useState<Summary | null>(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    setS(null); setErr('');
    api.summary(month || undefined).then(setS).catch(e => setErr(e.message));
  }, [month]);

  if (err) return <div className="card">Couldn’t load data: {err}</div>;
  if (!s) return <div className="muted">Loading…</div>;

  const { totals } = s;
  const scope = month ? monthLabel(month) : 'All time';
  const overBudget = s.budgetVsActual.filter(b => b.actual > b.expected && b.expected > 0);

  return (
    <div className="stack">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div className="section-title" style={{ margin: 0 }}>{scope}</div>
      </div>

      <div className="grid kpis">
        <Tile label="Income" value={money(totals.income)} />
        <Tile label="Expenses" value={money(totals.expense)} />
        <Tile label="Net" value={money(totals.net)} cls={totals.net >= 0 ? 'pos' : 'neg'} />
        <Tile label="Savings rate" value={pct(totals.savingsRate)}
              delta={overBudget.length ? `${overBudget.length} over budget` : 'on track'}
              deltaCls={overBudget.length ? 'neg' : 'pos'} />
      </div>

      <div className="grid two">
        <div className="card">
          <h3>Spending by category</h3>
          <div className="sub">Where your money went — {scope.toLowerCase()}</div>
          <CategoryChart data={s.byCategory} />
        </div>
        <div className="card">
          <h3>Budget vs actual</h3>
          <div className="sub">{month ? 'Green = within budget, red = over' : 'Pick a month to see budget health'}</div>
          <BudgetChart data={s.budgetVsActual} />
        </div>
      </div>

      <div className="card">
        <h3>Income vs expenses over time</h3>
        <div className="sub">Monthly trend across all imported data</div>
        <TrendChart data={s.trend} />
      </div>

      <Insights month={month} />
    </div>
  );
}

function Tile({ label, value, cls, delta, deltaCls }:
  { label: string; value: string; cls?: string; delta?: string; deltaCls?: string }) {
  return (
    <div className="card tile">
      <div className="label">{label}</div>
      <div className={`value ${cls || ''}`}>{value}</div>
      {delta && <div className={`delta ${deltaCls || ''}`}>{delta}</div>}
    </div>
  );
}

function Insights({ month }: { month: string | null }) {
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  const run = (question?: string) => {
    setLoading(true); setErr('');
    api.insights(month, question)
      .then(r => setText(r.text))
      .catch(e => setErr(e.message))
      .finally(() => setLoading(false));
  };

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div><h3>AI insights</h3><div className="sub">Powered by an open model on NVIDIA build</div></div>
        <button className="btn" onClick={() => run()} disabled={loading}>
          {loading ? <><span className="spin" /> Analyzing…</> : 'Generate insights'}
        </button>
      </div>
      {err && <div className="neg" style={{ marginTop: 8 }}>
        {err.includes('NVIDIA_API_KEY') ? 'Add your NVIDIA API key to server/.env to enable insights.' : err}
      </div>}
      {text && <div className="insights" style={{ marginTop: 12 }} dangerouslySetInnerHTML={{ __html: mdLite(text) }} />}
      <div className="row" style={{ marginTop: 14 }}>
        <input className="control" style={{ flex: 1 }} placeholder="Ask about your budget… e.g. Where can I cut back?"
               value={q} onChange={e => setQ(e.target.value)}
               onKeyDown={e => { if (e.key === 'Enter' && q.trim()) run(q.trim()); }} />
        <button className="btn secondary" disabled={loading || !q.trim()} onClick={() => run(q.trim())}>Ask</button>
      </div>
    </div>
  );
}

// tiny markdown: bold + bullets -> HTML (server output is trusted-ish; keep minimal)
function mdLite(s: string): string {
  return s
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/^\s*[-*]\s+(.*)$/gm, '• $1');
}
