import { useEffect, useState } from 'react';
import { useTheme } from './theme';
import { api } from './api';
import { monthLabel, CURRENCIES, getCurrency, setCurrency } from './util';
import Dashboard from './pages/Dashboard';
import Transactions from './pages/Transactions';
import ImportPage from './pages/Import';
import Statements from './pages/Statements';
import Recurring from './pages/Recurring';

type View = 'dashboard' | 'transactions' | 'recurring' | 'statements' | 'import';

export default function App() {
  const { mode, toggle } = useTheme();
  const [view, setView] = useState<View>('dashboard');
  const [months, setMonths] = useState<string[]>([]);
  const [month, setMonth] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0); // bump to reload data after edits/import
  const [cur, setCur] = useState(getCurrency()); // currency selection (drives re-render)

  useEffect(() => {
    api.summary().then(s => {
      const ms = s.months.filter(Boolean);
      setMonths(ms);
      setMonth(prev => prev ?? ms[0] ?? null);
    }).catch(() => {});
  }, [refresh]);

  const bump = () => setRefresh(r => r + 1);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand"><span className="dot" /> Budget</div>
        <nav className="nav">
          <button className={view === 'dashboard' ? 'active' : ''} onClick={() => setView('dashboard')}>Dashboard</button>
          <button className={view === 'transactions' ? 'active' : ''} onClick={() => setView('transactions')}>Transactions</button>
          <button className={view === 'recurring' ? 'active' : ''} onClick={() => setView('recurring')}>Recurring</button>
          <button className={view === 'statements' ? 'active' : ''} onClick={() => setView('statements')}>Statements</button>
          <button className={view === 'import' ? 'active' : ''} onClick={() => setView('import')}>Import sheet</button>
        </nav>
        <div className="spacer" />
        {(view === 'dashboard' || view === 'transactions') && months.length > 0 && (
          <select className="control" value={month ?? ''} onChange={e => setMonth(e.target.value || null)}>
            <option value="">All time</option>
            {months.map(m => <option key={m} value={m}>{monthLabel(m)}</option>)}
          </select>
        )}
        <select className="control" value={cur} title="Display currency"
          onChange={e => { setCurrency(e.target.value); setCur(e.target.value); }}>
          {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <button className="btn icon ghost" title="Toggle theme" onClick={toggle}>{mode === 'dark' ? '☀' : '☾'}</button>
      </header>

      <main className="main">
        {view === 'dashboard' && <Dashboard month={month} key={`d${refresh}${month}`} />}
        {view === 'transactions' && <Transactions month={month} onChange={bump} key={`t${refresh}`} />}
        {view === 'recurring' && <Recurring key={`r${refresh}`} />}
        {view === 'statements' && <Statements onDone={() => { bump(); setView('dashboard'); }} />}
        {view === 'import' && <ImportPage onDone={() => { bump(); setView('dashboard'); }} />}
      </main>
    </div>
  );
}
