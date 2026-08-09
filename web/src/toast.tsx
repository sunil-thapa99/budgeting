import { useEffect, useState } from 'react';

// Minimal toast system — module store + <Toaster/>. No dependency. ponytail: swap for sonner if we outgrow it.
type Kind = 'success' | 'error' | 'info';
type Toast = { id: number; kind: Kind; msg: string };

let items: Toast[] = [];
let seq = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(l => l());
const dismiss = (id: number) => { items = items.filter(t => t.id !== id); emit(); };

export function toast(msg: string, kind: Kind = 'info', ms = kind === 'error' ? 6000 : 4000) {
  const t = { id: ++seq, kind, msg };
  items = [...items, t];
  emit();
  setTimeout(() => dismiss(t.id), ms);
}
toast.success = (m: string) => toast(m, 'success');
toast.error = (m: string) => toast(m, 'error');
toast.info = (m: string) => toast(m, 'info');

const ICON: Record<Kind, string> = { success: '✓', error: '!', info: 'i' };

export function Toaster() {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force(n => n + 1);
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, []);
  return (
    <div className="toaster" role="region" aria-live="polite">
      {items.map(t => (
        <div key={t.id} className={`toast ${t.kind}`} onClick={() => dismiss(t.id)}>
          <span className="toast-icon">{ICON[t.kind]}</span>
          <span className="toast-msg">{t.msg}</span>
        </div>
      ))}
    </div>
  );
}
