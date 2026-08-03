import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import db from './db.js';
import { nvidia, INSIGHTS_MODEL, CATEGORIZE_MODEL, assertKey } from './nvidia.js';

const exec = promisify(execFile);

/** A parsed statement line, normalized. `out` = money left the account. */
export type RawRow = {
  date: string;          // YYYY-MM-DD
  description: string;
  amount: number;        // positive magnitude
  direction: 'out' | 'in';
  account: string;
  bankType?: string;     // bank's own txn type, e.g. Chase "DEBIT_CARD" / "ACCT_XFER"
};

/** After classification + categorization, ready for the review UI. */
export type ProposedTx = RawRow & {
  extId: string;
  type: 'expense' | 'income';
  category: string;
  excluded: boolean;         // transfer / card payment -> not counted
  reason?: string;           // why excluded / flagged
  duplicate?: 'imported' | 'possible'; // already in DB / fuzzy match
};

// ---------- account + date helpers ----------------------------------------

const MON: Record<string, number> = { jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12 };

function accountFromName(name: string, text = ''): string {
  const n = name.toLowerCase();
  if (n.includes('discover')) return 'Discover';
  if (n.includes('chase')) return 'Chase Checking';
  if (n.includes('capital') || /quicksilver|capital one/i.test(text)) return 'Capital One';
  if (/6582/.test(n) || /capital one/i.test(text)) return 'Capital One';
  return name.replace(/\.(csv|pdf|xlsx?)$/i, '');
}

// "06/14/2026" or "6/14/2026" -> 2026-06-14  (US mm/dd/yyyy from these banks)
function usDate(s: string): string | null {
  const m = String(s).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return null;
  let [, mo, d, y] = m;
  const yy = y.length === 2 ? `20${y}` : y;
  const mn = +mo, dn = +d;
  if (mn < 1 || mn > 12 || dn < 1 || dn > 31) return null;
  return `${yy}-${String(mn).padStart(2,'0')}-${String(dn).padStart(2,'0')}`;
}

// ---------- CSV extraction (deterministic) --------------------------------

// Minimal RFC-4180 parser — keeps dates as text (XLSX would coerce them to serials)
// and handles quoted commas (Chase descriptions contain them).
function parseCSV(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function extractCSV(buf: Buffer, account: string): RawRow[] {
  const table = parseCSV(buf.toString('utf8')).filter(r => r.some(c => c.trim() !== ''));
  if (table.length < 2) return [];
  const headers = table[0].map(h => h.trim());
  const rows = table.slice(1).map(r => Object.fromEntries(headers.map((h, i) => [h, (r[i] ?? '').trim()])));
  const find = (re: RegExp) => headers.find(h => re.test(h.toLowerCase().trim()));

  const dateH = find(/^trans.*date|transaction date|trans\. date/) || find(/posting date|post date|^date$/) || find(/date/);
  const descH = find(/description|payee|memo|^name$/) || headers[1];
  const amtH  = find(/^amount$/) || find(/amount/);
  const detailsH = find(/^details$/);           // Chase: DEBIT/CREDIT
  const typeH = find(/^type$/) || find(/^transaction type$/); // Chase: DEBIT_CARD / ACCT_XFER / ...
  const debitH = find(/^debit/); const creditH = find(/^credit/);
  // A "balance"/"details" column => bank export (positive = inflow). Otherwise a card (positive = charge).
  const isBank = !!(detailsH || find(/balance/));

  const out: RawRow[] = [];
  for (const r of rows) {
    const date = dateH ? usDate(r[dateH]) : null;
    const description = (descH ? r[descH] : '').replace(/\s+/g, ' ').trim();
    if (!date || !description) continue;

    let amount: number, direction: 'out' | 'in';
    if (debitH || creditH) {
      const dv = Math.abs(parseFloat((r[debitH!] || '').replace(/[^0-9.-]/g, '')) || 0);
      const cv = Math.abs(parseFloat((r[creditH!] || '').replace(/[^0-9.-]/g, '')) || 0);
      if (dv > 0) { amount = dv; direction = 'out'; }
      else if (cv > 0) { amount = cv; direction = 'in'; }
      else continue;
    } else {
      const raw = parseFloat((r[amtH!] || '').replace(/[^0-9.-]/g, ''));
      if (!isFinite(raw) || raw === 0) continue;
      amount = Math.abs(raw);
      const positiveIsOut = !isBank; // card: +charge=out; bank: +deposit=in
      const isOut = detailsH
        ? /debit/i.test(r[detailsH])
        : (raw > 0 ? positiveIsOut : !positiveIsOut);
      direction = isOut ? 'out' : 'in';
    }
    out.push({ date, description, amount, direction, account, bankType: typeH ? r[typeH] : undefined });
  }
  return out;
}

// ---------- PDF extraction (Capital One layout, LLM fallback) -------------

async function pdfToText(buf: Buffer): Promise<string> {
  const f = join(tmpdir(), `stmt-${createHash('sha1').update(buf).digest('hex').slice(0, 12)}.pdf`);
  await writeFile(f, buf);
  try {
    const { stdout } = await exec('pdftotext', ['-layout', f, '-'], { maxBuffer: 20 * 1024 * 1024 });
    return stdout;
  } finally { unlink(f).catch(() => {}); }
}

function extractCapitalOnePDF(text: string, account: string): RawRow[] {
  // statement period gives the year: "May 18, 2026 - Jun 15, 2026"
  const per = text.match(/([A-Z][a-z]{2}) \d{1,2}, (\d{4})\s*-\s*([A-Z][a-z]{2}) \d{1,2}, (\d{4})/);
  const endMon = per ? MON[per[3].toLowerCase()] : 12;
  const endYear = per ? +per[4] : new Date().getFullYear();
  const out: RawRow[] = [];
  const re = /^\s*([A-Z][a-z]{2})\s+(\d{1,2})\s+([A-Z][a-z]{2})\s+(\d{1,2})\s+(.+?)\s+(-?\s*\$[\d,]+\.\d{2})\s*$/;
  for (const line of text.split('\n')) {
    const m = line.match(re);
    if (!m) continue;
    const mon = MON[m[1].toLowerCase()]; const day = +m[2];
    if (!mon) continue;
    // year: months after the cycle-end month belong to the previous year (Dec->Jan wrap)
    const year = mon > endMon ? endYear - 1 : endYear;
    const date = `${year}-${String(mon).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
    const description = m[5].replace(/\s+/g, ' ').trim();
    const neg = m[6].includes('-');
    const amount = Math.abs(parseFloat(m[6].replace(/[^0-9.]/g, '')));
    if (!amount) continue;
    out.push({ date, description, amount, direction: neg ? 'in' : 'out', account }); // card: charge=out, payment/credit=in
  }
  return out;
}

async function extractPDFviaLLM(text: string, account: string): Promise<RawRow[]> {
  assertKey();
  const prompt = `Extract every transaction from this credit-card/bank statement text.
Return ONLY a JSON array. Each item: {"date":"YYYY-MM-DD","description":string,"amount":number,"direction":"out"|"in"}.
"out" = money spent/charged/debited; "in" = payment/credit/deposit/refund. amount is a positive number.
Ignore summary/fees/interest lines that aren't real transactions.\n\nSTATEMENT TEXT:\n${text.slice(0, 12000)}`;
  const c = await nvidia.chat.completions.create({
    model: INSIGHTS_MODEL, temperature: 0, max_tokens: 4000,
    messages: [{ role: 'user', content: prompt }],
  });
  const t = c.choices[0]?.message?.content ?? '';
  const m = t.match(/\[[\s\S]*\]/);
  if (!m) return [];
  try {
    return (JSON.parse(m[0]) as any[])
      .filter(r => r?.date && r?.amount)
      .map(r => ({ date: r.date, description: String(r.description||'').trim(), amount: Math.abs(+r.amount),
                   direction: r.direction === 'in' ? 'in' : 'out', account } as RawRow));
  } catch { return []; }
}

// ---------- classification: transfers / card payments / income ------------

const ISSUERS = /(discover|capital one|chase|amex|american express|citi|synchrony|barclay|wells fargo|bank of america|boa|ally|sofi)\b/i;
const PAYMENT = /\b(payment|paymt|pymt|pmt|e-?payment|autopay|auto pay|thank you|(online|mobile) (pymt|pmt|payment))\b/i;
const XFER    = /\b(zelle|quickpay|acct xfer|account transfer|online transfer|transfer (to|from)|wire (transfer|incoming|outgoing)|to sav|from sav|to chk|from chk|venmo|cash ?app|paypal|coinbase|crypto|kraken|binance|gemini|robinhood|webull|acorns|betterment|wealthfront|vanguard|fidelity|schwab|brokerage|real time payment|ally|sofi|marcus)\b/i;
// Gambling/betting: gross deposits churn (you withdraw much of it), so treat as money-movement, not spend. Editable in review.
const BETTING = /\b(draftkings|dk\*|fanduel|betfair|betmgm|caesars ?(sports|palace)|bet365|pointsbet|polymarket|underdog|prizepicks|bovada|sportsbook|sportsbk)/i;

/** Returns a definite classification, or null to let the LLM decide the category. */
function ruleClassify(r: RawRow): { excluded: boolean; type: 'expense'|'income'; category: string; reason: string } | null {
  const d = r.description;
  // Card payment -> transfer, never spend. Two shapes:
  //  - incoming "PAYMENT / THANK YOU" on a card statement (reduces the card balance)
  //  - outgoing payment from checking naming the card issuer (e.g. "DISCOVER E-PAYMENT")
  if (PAYMENT.test(d) && (r.direction === 'in' || ISSUERS.test(d))) {
    return { excluded: true, type: r.direction === 'in' ? 'income' : 'expense', category: 'Transfer', reason: 'card payment' };
  }
  if (XFER.test(d)) return { excluded: true, type: r.direction === 'in' ? 'income' : 'expense', category: 'Transfer', reason: 'account transfer' };
  if (BETTING.test(d)) return { excluded: true, type: r.direction === 'in' ? 'income' : 'expense', category: 'Transfer', reason: 'betting/gambling' };
  if (/payroll|direct dep|direct deposit/i.test(d)) return { excluded: false, type: 'income', category: 'Income', reason: 'payroll' };
  if (/cash back|cash award|reward|interest paid|refund/i.test(d)) return { excluded: false, type: 'income', category: 'Income', reason: 'credit' };

  // The bank's own transaction type is the strongest signal for a checking account.
  const bt = (r.bankType || '').toLowerCase();
  if (/quickpay|acct[_ ]?xfer|_xfer|wire|partnerfi|misc_(debit|credit)/.test(bt))
    return { excluded: true, type: r.direction === 'in' ? 'income' : 'expense', category: 'Transfer', reason: r.bankType || 'transfer' };
  if (/fee/.test(bt)) return { excluded: false, type: 'expense', category: 'Fees', reason: 'bank fee' };
  // DEBIT_CARD / ATM / BILLPAY / ACH_* fall through to LLM categorization (real spend vs investing).
  return null;
}

// ---------- categorization via LLM (batched, unique descriptions) ---------

export function allowedCategories(): string[] {
  const fromBudgets = (db.prepare(`SELECT DISTINCT category FROM budgets ORDER BY category`).all() as {category:string}[])
    .map(r => r.category).filter(c => c && c.toLowerCase() !== 'total');
  const base = ['Groceries','Dining','Coffee','Transportation','Gas for Car','Shopping','Rent','Insurance',
    'Internet','Cell Phone Bill','Subscriptions','Utilities','Health','Entertainment','Education','Travel','Fees','Miscellaneous'];
  return Array.from(new Set([...fromBudgets, ...base]));
}

// Deterministic rules for common merchants — reliable, free, and shrink the LLM load
// (which turns flaky under rate limits). Only unmatched merchants go to the model.
const MERCHANT_RULES: [RegExp, string][] = [
  [/wal-?mart|walmart|target|costco|sam'?s club|kroger|aldi|trader joe|whole foods|safeway|publix|no frills|instacart|grocery/i, 'Groceries'],
  [/uber eats|doordash|grubhub|postmates|mcdonald|burger|pizza|chipotle|taco|wendy|popeye|chick-?fil|kfc|subway|restaurant|dining|diner|grill|kitchen|sushi|thai|mexican|cafe|bistro/i, 'Dining'],
  [/starbucks|dunkin|tim hortons|coffee|peet'?s|caribou/i, 'Coffee'],
  [/uber(?!\s*eats)|lyft|transit|metro|parking|toll|shell|exxon|chevron|murphy|circle k|marathon|valero|bp\b|gas /i, 'Transportation'],
  [/amazon|amzn|ebay|etsy|best buy|shein|temu|nike|macy|nordstrom|shopping/i, 'Shopping'],
  [/netflix|spotify|hulu|disney|hbo|youtube premium|apple\.com\/bill|prime video|patreon|audible/i, 'Subscriptions'],
  [/at&t|verizon|t-?mobile|sprint|cricket|mint mobile/i, 'Cell Phone Bill'],
  [/spectrum|comcast|xfinity|cox comm|centurylink|internet/i, 'Internet'],
  [/electric|energy|water|sewer|gas company|utility|entergy|dominion/i, 'Utilities'],
  [/uscis|tuition|university|college|\bedu\b|bookstore/i, 'Education'],
  [/pharmacy|cvs|walgreens|rite aid|doctor|dental|clinic|hospital|health/i, 'Health'],
  [/airline|flight|hotel|airbnb|expedia|delta air|united air|american air|flighthub|booking\.com/i, 'Travel'],
];
function localCategory(desc: string): string | null {
  for (const [re, cat] of MERCHANT_RULES) if (re.test(desc)) return cat;
  return null;
}

async function categorize(descriptions: string[], cats: string[]): Promise<Record<string, string>> {
  if (!descriptions.length) return {};
  const local: Record<string, string> = {};
  const remaining: string[] = [];
  for (const d of descriptions) { const c = localCategory(d); if (c) local[d] = c; else remaining.push(d); }
  if (!remaining.length) return local;
  assertKey();
  const allowed = new Set(cats);
  const chunkSize = 40;
  const chunks: string[][] = [];
  for (let i = 0; i < remaining.length; i += chunkSize) chunks.push(remaining.slice(i, i + chunkSize));

  // Parallel chunks, small model, bounded per-call time. On any failure a chunk
  // falls back to "Miscellaneous" — the review UI lets the user correct it.
  const results = await Promise.all(chunks.map(async (chunk): Promise<(readonly [string, string])[]> => {
    const prompt = `You categorize card/bank transactions. Allowed categories:
${cats.join(', ')}.
For each merchant string below (they may contain city/state/ID noise — infer the real merchant), pick the best category.
Use "Transfer" for money moved rather than spent: transfers to your own savings/brokerage/investment/crypto, gambling/betting deposits (Polymarket, Underdog, DraftKings, FanDuel), person-to-person (Zelle/Venmo), or credit-card payments.
Use "Income" for money received (payroll, refunds, rewards).
Reply with ONLY a JSON array of category strings, one per input, IN THE SAME ORDER. Use "Miscellaneous" if unsure.

Inputs (${chunk.length}):
${JSON.stringify(chunk)}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const c = await nvidia.chat.completions.create({
          model: CATEGORIZE_MODEL, temperature: 0, max_tokens: 1200,
          messages: [{ role: 'user', content: prompt }],
        }, { timeout: 30_000, maxRetries: 0 });
        const t = c.choices[0]?.message?.content ?? '';
        const m = t.match(/\[[\s\S]*\]/);
        const arr: string[] = m ? JSON.parse(m[0]) : [];
        return chunk.map((desc, i) => [desc, allowed.has(arr[i]) ? arr[i] : 'Miscellaneous'] as const);
      } catch { /* retry once, then give up to Miscellaneous */ }
    }
    return chunk.map(desc => [desc, 'Miscellaneous'] as const);
  }));

  return { ...local, ...Object.fromEntries(results.flat()) };
}

// ---------- dedupe ---------------------------------------------------------

const normDesc = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 24);

function extIdFor(r: RawRow, occ: number): string {
  return createHash('sha1')
    .update(`${r.account}|${r.date}|${r.amount.toFixed(2)}|${normDesc(r.description)}|${occ}`)
    .digest('hex');
}

// ---------- main pipeline --------------------------------------------------

export async function parseStatement(file: { name: string; buffer: Buffer }): Promise<ProposedTx[]> {
  const isPdf = /\.pdf$/i.test(file.name) || file.buffer.subarray(0, 4).toString() === '%PDF';
  let account = accountFromName(file.name);
  let raw: RawRow[];

  if (isPdf) {
    const text = await pdfToText(file.buffer);
    account = accountFromName(file.name, text);
    raw = extractCapitalOnePDF(text, account);
    if (raw.length < 3) raw = await extractPDFviaLLM(text, account); // unknown layout fallback
  } else {
    raw = extractCSV(file.buffer, account);
  }

  // occurrence index so legitimately-identical rows keep distinct ext_ids, but re-imports match.
  const occ = new Map<string, number>();
  const cats = allowedCategories();

  // rule pass first; collect the rest for the LLM
  const pre = raw.map(r => ({ r, rule: ruleClassify(r) }));
  const needCat = Array.from(new Set(pre.filter(p => !p.rule && p.r.direction === 'out').map(p => p.r.description)));
  console.error(`[stmt] ${file.name}: extracted ${raw.length}, categorizing ${needCat.length} descriptions…`);
  const t0 = Date.now();
  const catMap = await categorize(needCat, [...cats, 'Transfer', 'Income']);
  console.error(`[stmt] categorized in ${Date.now() - t0}ms`);

  const existing = db.prepare(`SELECT ext_id FROM transactions WHERE ext_id IS NOT NULL`).all() as {ext_id:string}[];
  const known = new Set(existing.map(e => e.ext_id));

  const proposed: ProposedTx[] = pre.map(({ r, rule }) => {
    const key = `${r.account}|${r.date}|${r.amount.toFixed(2)}|${normDesc(r.description)}`;
    const n = occ.get(key) ?? 0; occ.set(key, n + 1);
    const extId = extIdFor(r, n);

    let type: 'expense'|'income', category: string, excluded: boolean, reason: string | undefined;
    if (rule) { ({ type, category, excluded, reason } = rule); }
    else if (r.direction === 'in') { type = 'income'; category = 'Income'; excluded = false; }
    else {
      const c = catMap[r.description] || 'Miscellaneous';
      if (c === 'Transfer') { type = 'expense'; category = 'Transfer'; excluded = true; reason = 'moved money (not spending)'; }
      else if (c === 'Income') { type = 'income'; category = 'Income'; excluded = false; }
      else { type = 'expense'; category = c; excluded = false; }
    }

    const p: ProposedTx = { ...r, extId, type, category, excluded, reason };
    if (known.has(extId)) p.duplicate = 'imported';
    else if (fuzzyDup(r)) p.duplicate = 'possible';
    return p;
  });

  return proposed;
}

// fuzzy cross-source match (e.g. a scanned receipt already in the DB)
function fuzzyDup(r: RawRow): boolean {
  const row = db.prepare(`
    SELECT 1 FROM transactions
    WHERE excluded=0 AND ABS(amount - ?) < 0.005
      AND ABS(julianday(date) - julianday(?)) <= 3
    LIMIT 1`).get(r.amount, r.date);
  return !!row;
}

export function commitStatement(rows: ProposedTx[]): { inserted: number; skipped: number } {
  const ins = db.prepare(`
    INSERT OR IGNORE INTO transactions (date,type,amount,category,description,method,source,account,ext_id,excluded)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);
  let inserted = 0, skipped = 0;
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      const res = ins.run(r.date, r.type, r.amount, r.category, r.description, '', 'statement',
        r.account, r.extId, r.excluded ? 1 : 0);
      if (res.changes > 0) inserted++; else skipped++;
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { inserted, skipped };
}
