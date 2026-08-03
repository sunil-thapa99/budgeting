import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Cell,
  LineChart, Line, Legend, LabelList,
} from 'recharts';
import { tokens } from './theme';
import { money0, money, monthLabel } from './util';
import type { Summary } from './api';

const axis = (t: ReturnType<typeof tokens>) => ({ fill: t.textMuted, fontSize: 12 });

function TooltipBox({ active, payload, label, t }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: t.surface, border: `1px solid ${t.grid}`, borderRadius: 8, padding: '8px 10px', boxShadow: '0 4px 16px rgba(0,0,0,.15)' }}>
      <div style={{ color: t.textMuted, fontSize: 12, marginBottom: 4 }}>{label}</div>
      {payload.map((p: any) => (
        <div key={p.name} style={{ color: t.text, fontSize: 13, display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={{ width: 8, height: 8, borderRadius: 2, background: p.color || p.fill }} />
          <span style={{ textTransform: 'capitalize' }}>{p.name}</span>
          <b style={{ marginLeft: 'auto', fontVariantNumeric: 'tabular-nums' }}>{money(p.value)}</b>
        </div>
      ))}
    </div>
  );
}

/* Spending by category — single-hue magnitude bars (top 7 + Other), direct labels. */
export function CategoryChart({ data }: { data: Summary['byCategory'] }) {
  const t = tokens();
  const top = data.slice(0, 7);
  const rest = data.slice(7).reduce((s, d) => s + d.amount, 0);
  const rows = rest > 0 ? [...top, { category: 'Other', amount: rest }] : top;
  if (!rows.length) return <Empty />;
  const h = Math.max(160, rows.length * 40 + 20);
  return (
    <ResponsiveContainer width="100%" height={h}>
      <BarChart data={rows} layout="vertical" margin={{ left: 8, right: 56, top: 4, bottom: 4 }}>
        <CartesianGrid horizontal={false} stroke={t.grid} />
        <XAxis type="number" tick={axis(t)} tickFormatter={money0} axisLine={false} tickLine={false} />
        <YAxis type="category" dataKey="category" width={110} tick={axis(t)} axisLine={false} tickLine={false} />
        <Tooltip cursor={{ fill: t.grid, opacity: .4 }} content={<TooltipBox t={t} />} />
        <Bar dataKey="amount" name="spent" fill={t.accent} radius={[0, 4, 4, 0]} barSize={20}>
          <LabelList dataKey="amount" position="right" formatter={money0} style={{ fill: t.textMuted, fontSize: 12 }} />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

/* Income vs Expense over time — two categorical series, one axis, legend. */
export function TrendChart({ data }: { data: Summary['trend'] }) {
  const t = tokens();
  if (!data.length) return <Empty />;
  const rows = data.map(d => ({ ...d, label: monthLabel(d.month) }));
  return (
    <ResponsiveContainer width="100%" height={260}>
      <LineChart data={rows} margin={{ left: 8, right: 16, top: 8, bottom: 4 }}>
        <CartesianGrid vertical={false} stroke={t.grid} />
        <XAxis dataKey="label" tick={axis(t)} axisLine={false} tickLine={false} />
        <YAxis tick={axis(t)} tickFormatter={money0} axisLine={false} tickLine={false} width={64} />
        <Tooltip content={<TooltipBox t={t} />} />
        <Legend wrapperStyle={{ fontSize: 12, color: t.textMuted }} iconType="plainline" />
        <Line type="monotone" dataKey="income" name="Income" stroke={t.series[0]} strokeWidth={2} dot={{ r: 3 }} activeDot={{ r: 5 }} />
        <Line type="monotone" dataKey="expense" name="Expense" stroke={t.series[1]} strokeWidth={2} dot={{ r: 3 }} activeDot={{ r: 5 }} />
      </LineChart>
    </ResponsiveContainer>
  );
}

/* Budget vs actual — grouped horizontal bars; actual turns red when over budget. */
export function BudgetChart({ data }: { data: Summary['budgetVsActual'] }) {
  const t = tokens();
  const rows = data.filter(d => d.expected > 0).slice(0, 10);
  if (!rows.length) return <Empty note="No budget data for this month. Import your sheet or set budgets." />;
  const h = Math.max(180, rows.length * 46 + 30);
  return (
    <ResponsiveContainer width="100%" height={h}>
      <BarChart data={rows} layout="vertical" margin={{ left: 8, right: 16, top: 4, bottom: 4 }} barGap={2}>
        <CartesianGrid horizontal={false} stroke={t.grid} />
        <XAxis type="number" tick={axis(t)} tickFormatter={money0} axisLine={false} tickLine={false} />
        <YAxis type="category" dataKey="category" width={110} tick={axis(t)} axisLine={false} tickLine={false} />
        <Tooltip cursor={{ fill: t.grid, opacity: .4 }} content={<TooltipBox t={t} />} />
        <Legend wrapperStyle={{ fontSize: 12, color: t.textMuted }} />
        <Bar dataKey="expected" name="Budget" fill={t.grid} radius={[0, 3, 3, 0]} barSize={12} />
        <Bar dataKey="actual" name="Actual" radius={[0, 3, 3, 0]} barSize={12}>
          {rows.map((d, i) => <Cell key={i} fill={d.actual > d.expected ? t.bad : t.good} />)}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

function Empty({ note }: { note?: string }) {
  return <div className="muted" style={{ padding: '32px 8px', textAlign: 'center' }}>{note || 'No data yet.'}</div>;
}
