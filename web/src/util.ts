export const CURRENCIES = ['USD', 'CAD', 'EUR', 'GBP', 'INR', 'AUD', 'JPY'] as const;

// Display currency, persisted locally. money()/money0() read the current value each call,
// so changing it and re-rendering updates every amount in the app.
let _currency = localStorage.getItem('currency') || 'USD';
export const getCurrency = () => _currency;
export const setCurrency = (c: string) => { _currency = c; localStorage.setItem('currency', c); };

const cache = new Map<string, Intl.NumberFormat>();
function nf(digits: number): Intl.NumberFormat {
  const key = `${_currency}:${digits}`;
  let f = cache.get(key);
  if (!f) { f = new Intl.NumberFormat('en-US', { style: 'currency', currency: _currency, maximumFractionDigits: digits }); cache.set(key, f); }
  return f;
}
export const money = (n: number) => nf(2).format(n || 0);
export const money0 = (n: number) => nf(0).format(n || 0);
export const pct = (n: number) => `${(n * 100).toFixed(0)}%`;

export function monthLabel(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, (m || 1) - 1, 1).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

// Downscale an image file to a small JPEG data URL so it fits NVIDIA's inline-image limit.
export function fileToScaledDataURL(file: File, maxDim = 1024, quality = 0.72): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d')!.drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = (e) => { URL.revokeObjectURL(url); reject(e); };
    img.src = url;
  });
}
