import { useState } from 'react';
import { supabase } from './supabase';

// Email + password sign in / register. On success, App's onAuthStateChange takes over.
export default function Auth() {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null); setMsg(null); setBusy(true);
    try {
      if (mode === 'register') {
        const { data, error } = await supabase.auth.signUp({ email, password });
        if (error) throw error;
        // If email confirmation is ON, there's no session yet.
        if (!data.session) setMsg('Account created. Check your email to confirm, then sign in.');
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
      }
    } catch (e: any) {
      setErr(e?.message || 'Something went wrong');
    } finally { setBusy(false); }
  }

  return (
    <div className="auth-wrap">
      <form className="card auth-card" onSubmit={submit}>
        <div className="brand" style={{ marginBottom: 4 }}><span className="dot" /> Budget</div>
        <h3>{mode === 'login' ? 'Sign in' : 'Create your account'}</h3>
        <p className="sub">{mode === 'login' ? 'Welcome back.' : 'Your data is private to your account.'}</p>

        <div className="field">
          <label>Email</label>
          <input className="control" type="email" autoComplete="email" required
            value={email} onChange={e => setEmail(e.target.value)} />
        </div>
        <div className="field">
          <label>Password</label>
          <input className="control" type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            required minLength={6} value={password} onChange={e => setPassword(e.target.value)} />
        </div>

        {err && <p className="neg" style={{ margin: '0 0 12px' }}>{err}</p>}
        {msg && <p className="muted" style={{ margin: '0 0 12px' }}>{msg}</p>}

        <button className="btn" style={{ width: '100%' }} disabled={busy}>
          {busy ? <span className="spin" /> : (mode === 'login' ? 'Sign in' : 'Create account')}
        </button>

        <p className="sub" style={{ marginTop: 14, textAlign: 'center' }}>
          {mode === 'login' ? "No account? " : 'Already have one? '}
          <a href="#" onClick={e => { e.preventDefault(); setErr(null); setMsg(null); setMode(mode === 'login' ? 'register' : 'login'); }}>
            {mode === 'login' ? 'Register' : 'Sign in'}
          </a>
        </p>
      </form>
    </div>
  );
}
