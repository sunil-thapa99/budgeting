import { useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { useTheme } from './theme';
import { api } from './api';
import { supabase } from './supabase';
import { monthLabel, CURRENCIES, getCurrency, setCurrency } from './util';
import Auth from './Auth';
import { Toaster } from './toast';
import Dashboard from './pages/Dashboard';
import Transactions from './pages/Transactions';
import ImportPage from './pages/Import';
import Statements from './pages/Statements';
import Recurring from './pages/Recurring';
import Accounts from './pages/Accounts';

type View = 'dashboard' | 'transactions' | 'recurring' | 'accounts' | 'statements' | 'import';

export default function App() {
  const { mode, toggle } = useTheme();
  const [session, setSession] = useState<Session | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [view, setView] = useState<View>('dashboard');
  const [months, setMonths] = useState<string[]>([]);
  const [month, setMonth] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0); // bump to reload data after edits/import
  const [cur, setCur] = useState(getCurrency()); // currency selection (drives re-render)
  const [menuOpen, setMenuOpen] = useState(false); // mobile nav drawer

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setAuthReady(true); });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session) return;
    api.summary().then(s => {
      const ms = s.months.filter(Boolean);
      setMonths(ms);
      setMonth(prev => prev ?? ms[0] ?? null);
    }).catch(() => {});
  }, [refresh, session]);

  if (!authReady) return null;              // avoid a flash of the login screen on reload
  if (!session) return <Auth />;

  const bump = () => setRefresh(r => r + 1);
  const go = (v: View) => { setView(v); setMenuOpen(false); };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand"><span className="dot" /> Budget</div>
        <button className="btn icon ghost menu-toggle" aria-label="Menu" aria-expanded={menuOpen}
          onClick={() => setMenuOpen(o => !o)}>{menuOpen ? '✕' : '☰'}</button>
        <nav className={`nav ${menuOpen ? 'open' : ''}`}>
          <button className={view === 'dashboard' ? 'active' : ''} onClick={() => go('dashboard')}>Dashboard</button>
          <button className={view === 'transactions' ? 'active' : ''} onClick={() => go('transactions')}>Transactions</button>
          <button className={view === 'recurring' ? 'active' : ''} onClick={() => go('recurring')}>Recurring</button>
          <button className={view === 'accounts' ? 'active' : ''} onClick={() => go('accounts')}>Net worth</button>
          <button className={view === 'statements' ? 'active' : ''} onClick={() => go('statements')}>Statements</button>
          <button className={view === 'import' ? 'active' : ''} onClick={() => go('import')}>Import sheet</button>
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
        <button className="btn ghost" title={`Signed in as ${session.user.email ?? ''}`} onClick={() => supabase.auth.signOut()}>Sign out</button>
      </header>

      <main className="main">
        {view === 'dashboard' && <Dashboard month={month} key={`d${refresh}${month}`} />}
        {view === 'transactions' && <Transactions month={month} onChange={bump} key={`t${refresh}`} />}
        {view === 'recurring' && <Recurring key={`r${refresh}`} />}
        {view === 'accounts' && <Accounts key={`a${refresh}`} />}
        {view === 'statements' && <Statements onDone={() => { bump(); setView('dashboard'); }} />}
        {view === 'import' && <ImportPage onDone={() => { bump(); setView('dashboard'); }} />}
      </main>
      <Toaster />
    </div>
  );
}
