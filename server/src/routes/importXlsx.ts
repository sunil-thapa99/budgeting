import { Router } from 'express';
import multer from 'multer';
import * as XLSX from 'xlsx';
import db from '../db.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

// ---- helpers for the "Budget by Paycheck" template ----------------------

function money(v: any): number {
  const s = String(v ?? '').replace(/[$,\s]/g, '');
  if (s === '' || s === '-') return 0;
  return Math.abs(Number(s)) || 0;
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

// The workbook mixes dd/mm/yyyy (Isha) and mm/dd/yyyy (Sunil). Disambiguate by the
// >12 rule; truly ambiguous (both <=12) -> null so the caller pins it to the tab month.
function parseDate(v: any): string | null {
  const m = String(v ?? '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const a = +m[1], b = +m[2], y = +m[3];
  let day: number, mon: number;
  if (a > 12 && b <= 12) { day = a; mon = b; }        // dd/mm
  else if (b > 12 && a <= 12) { day = b; mon = a; }   // mm/dd
  else return null;                                    // ambiguous or invalid
  if (mon < 1 || mon > 12 || day < 1 || day > 31) return null;
  return `${y}-${String(mon).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function findIdx(row: any[], label: string, from = 0): number {
  for (let i = from; i < row.length; i++) {
    if (String(row[i]).trim().toLowerCase() === label.toLowerCase()) return i;
  }
  return -1;
}

type Parsed = {
  sheet: string;
  month: string; // YYYY-MM
  income: { date: string; amount: number; description: string }[];
  expenses: { date: string; amount: number; category: string; description: string; method: string }[];
  budgets: { category: string; expected: number }[];
};

function parseSheet(name: string, rows: any[][]): Parsed | null {
  // --- determine the month/year for this tab ---
  // Year is unambiguous even when d/m order isn't, so scan raw for any /yyyy.
  const years: number[] = [];
  for (const r of rows) for (const c of r) {
    const m = String(c).match(/\b\d{1,2}\/\d{1,2}\/(\d{4})\b/); if (m) years.push(+m[1]);
  }
  let year = years.length ? Math.min(...years) : 2024;
  let mon: number | undefined;
  const lname = name.toLowerCase();          // tab name names the month, e.g. "Sunil-July"
  for (const key in MONTHS) if (lname.includes(key)) mon = MONTHS[key];
  if (!mon) { const d = rows.flat().map(parseDate).find(Boolean); if (d) mon = +d.slice(5, 7); }
  if (!mon) return null;
  const month = `${year}-${String(mon).padStart(2, '0')}`;
  const fallbackDate = `${month}-15`;
  // Keep an exact day only when unambiguous AND in this tab's month; else pin to the tab month.
  const dateOf = (cell: any): string => {
    const d = parseDate(cell);
    return d && d.slice(0, 7) === month ? d : fallbackDate;
  };

  // --- income actuals: header row has col4="Current Income" (second block) ---
  const income: Parsed['income'] = [];
  const incHdr = rows.findIndex(r => String(r[4]).trim() === 'Current Income');
  if (incHdr >= 0) {
    for (let i = incHdr + 1; i < rows.length; i++) {
      const nm = String(rows[i][4] ?? '').trim();
      if (nm === '' ) { if (String(rows[i][5]).trim()==='') continue; }
      if (nm.toLowerCase() === 'total') break;
      const amt = money(rows[i][5]);
      if (nm && amt > 0) income.push({ description: nm, amount: amt, date: dateOf(rows[i][6]) });
      if (i - incHdr > 40) break;
    }
  }

  // --- expenses: locate the actual-log header (has "Vendor" and "Amount Paid") ---
  const expHdrIdx = rows.findIndex(r => findIdx(r, 'Vendor') >= 0 && findIdx(r, 'Amount Paid') >= 0);
  const expenses: Parsed['expenses'] = [];
  const budgets: Parsed['budgets'] = [];
  if (expHdrIdx >= 0) {
    const h = rows[expHdrIdx];
    const vendorI = findIdx(h, 'Vendor');
    const catI = findIdx(h, 'Category', vendorI + 1);
    const amtI = findIdx(h, 'Amount Paid');
    const dateI = findIdx(h, 'Date', amtI + 1);
    const methI = findIdx(h, 'Payment Method');

    // budget table (left side): col0=Category, col1=Expected, until "Total"
    for (let i = expHdrIdx + 1; i < rows.length; i++) {
      const cat = String(rows[i][0] ?? '').trim();
      if (cat.toLowerCase() === 'total') break;
      if (cat) { const exp = money(rows[i][1]); if (exp > 0) budgets.push({ category: cat, expected: exp }); }
      if (i - expHdrIdx > 60) break;
    }

    // actual expense log (right side): any row with a positive Amount Paid
    for (let i = expHdrIdx + 1; i < rows.length; i++) {
      const amt = money(rows[i][amtI]);
      if (amt <= 0) continue;
      const category = String(rows[i][catI] ?? '').trim() || 'Uncategorized';
      const vendor = String(rows[i][vendorI] ?? '').trim();
      expenses.push({
        amount: amt,
        category,
        description: vendor,
        method: methI >= 0 ? String(rows[i][methI] ?? '').trim() : '',
        date: dateOf(rows[i][dateI]),
      });
    }
  }

  if (!income.length && !expenses.length) return null;
  return { sheet: name, month, income, expenses, budgets };
}

function parseWorkbook(buf: Buffer, only?: string[]): Parsed[] {
  const wb = XLSX.read(buf, { type: 'buffer' });
  const out: Parsed[] = [];
  for (const name of wb.SheetNames) {
    if (only && only.length && !only.includes(name)) continue;
    const rows = XLSX.utils.sheet_to_json<any[]>(wb.Sheets[name], { header: 1, raw: false, defval: '' });
    const p = parseSheet(name, rows);
    if (p) out.push(p);
  }
  return out;
}

// POST /api/import/preview  (multipart: file) -> per-tab counts, no writes
router.post('/preview', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Upload an .xlsx file as "file".' });
  const parsed = parseWorkbook(req.file.buffer);
  res.json(parsed.map(p => ({
    sheet: p.sheet, month: p.month,
    income: p.income.length, expenses: p.expenses.length, budgets: p.budgets.length,
    expenseTotal: Math.round(p.expenses.reduce((s, e) => s + e.amount, 0) * 100) / 100,
  })));
});

// POST /api/import  (multipart: file, sheets=JSON array) -> commit
router.post('/', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Upload an .xlsx file as "file".' });
  let only: string[] | undefined;
  try { only = req.body.sheets ? JSON.parse(req.body.sheets) : undefined; } catch { only = undefined; }
  const parsed = parseWorkbook(req.file.buffer, only);

  // idempotent: importing replaces all prior import-sourced data
  const tx = db.prepare('DELETE FROM transactions WHERE source=?');
  const insTx = db.prepare(
    `INSERT INTO transactions (date,type,amount,category,description,method,source) VALUES (?,?,?,?,?,?,?)`
  );
  const clearBudgets = db.prepare('DELETE FROM budgets');
  const insBudget = db.prepare(
    `INSERT INTO budgets (month,category,expected) VALUES (?,?,?)
     ON CONFLICT(month,category) DO UPDATE SET expected=excluded.expected`
  );

  db.exec('BEGIN');
  try {
    tx.run('import');
    clearBudgets.run();
    let nTx = 0, nBud = 0;
    for (const p of parsed) {
      for (const e of p.expenses) { insTx.run(e.date, 'expense', e.amount, e.category, e.description, e.method, 'import'); nTx++; }
      for (const inc of p.income) { insTx.run(inc.date, 'income', inc.amount, 'Income', inc.description, '', 'import'); nTx++; }
      for (const b of p.budgets) { insBudget.run(p.month, b.category, b.expected); nBud++; }
    }
    db.exec('COMMIT');
    res.json({ sheets: parsed.map(p => p.sheet), transactions: nTx, budgets: nBud });
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
});

export default router;
