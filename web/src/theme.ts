import { useEffect, useState, useCallback } from 'react';

type Mode = 'light' | 'dark';

export function useTheme() {
  const [mode, setMode] = useState<Mode>(() =>
    (localStorage.getItem('theme') as Mode) ||
    (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
  );
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', mode);
    localStorage.setItem('theme', mode);
  }, [mode]);
  const toggle = useCallback(() => setMode(m => (m === 'dark' ? 'light' : 'dark')), []);
  return { mode, toggle };
}

// Resolve CSS custom properties to hex so Recharts (which needs strings) matches the theme.
export function tokens() {
  const s = getComputedStyle(document.documentElement);
  const v = (n: string) => s.getPropertyValue(n).trim();
  return {
    series: [v('--s1'), v('--s2'), v('--s3'), v('--s4'), v('--s5'), v('--s6'), v('--s7'), v('--s8')],
    accent: v('--accent'),
    good: v('--good'),
    bad: v('--bad'),
    text: v('--text-primary'),
    textMuted: v('--text-muted'),
    grid: v('--border'),
    surface: v('--surface-1'),
  };
}
