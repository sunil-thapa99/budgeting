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

const pad2 = (n: number) => String(n).padStart(2, '0');
// Parse the common statement date shapes -> YYYY-MM-DD:
//  MM/DD/YYYY (US cards), YYYY-MM-DD / YYYY/MM/DD (ISO / Canadian exports).
function usDate(s: string): string | null {
  const t = String(s).trim();
  let m = t.match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})$/); // ISO first
  if (m) { const [, y, mo, d] = m; if (+mo >= 1 && +mo <= 12 && +d >= 1 && +d <= 31) return `${y}-${pad2(+mo)}-${pad2(+d)}`; }
  m = t.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})$/);   // MM/DD/YYYY
  if (m) { const mo = +m[1], d = +m[2], y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
           if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return `${y}-${pad2(mo)}-${pad2(d)}`; }
  return null;
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

type CsvMap = {
  date?: string; desc?: string; amount?: string;
  debit?: string; credit?: string; type?: string; details?: string;
  positiveIsOut: boolean; // for a single signed amount column
};

// Deterministic mapping from header names (covers most bank/card exports).
function heuristicMap(headers: string[]): CsvMap {
  const find = (re: RegExp) => headers.find(h => re.test(h.toLowerCase().trim()));
  const details = find(/^details$/);
  return {
    date: find(/^trans.*date|transaction date|trans\. date/) || find(/posting date|post date|^date$/) || find(/date/),
    desc: find(/description|payee|memo|merchant|^name$/) || headers[1],
    amount: find(/^amount$/) || find(/amount/),
    debit: find(/^debit/), credit: find(/^credit/),
    type: find(/^type$/) || find(/^transaction type$/),
    details,
    positiveIsOut: !(details || find(/balance/)), // card: +charge=out; bank(has balance/details): +deposit=in
  };
}

function buildRows(rows: Record<string, string>[], m: CsvMap, account: string): RawRow[] {
  const out: RawRow[] = [];
  for (const r of rows) {
    const date = m.date ? usDate(r[m.date]) : null;
    const description = (m.desc ? r[m.desc] : '').replace(/\s+/g, ' ').trim();
    if (!date || !description) continue;

    let amount: number, direction: 'out' | 'in';
    if (m.debit || m.credit) {
      const dv = Math.abs(parseFloat((r[m.debit!] || '').replace(/[^0-9.-]/g, '')) || 0);
      const cv = Math.abs(parseFloat((r[m.credit!] || '').replace(/[^0-9.-]/g, '')) || 0);
      if (dv > 0) { amount = dv; direction = 'out'; }
      else if (cv > 0) { amount = cv; direction = 'in'; }
      else continue;
    } else if (m.amount) {
      const raw = parseFloat((r[m.amount] || '').replace(/[^0-9.-]/g, ''));
      if (!isFinite(raw) || raw === 0) continue;
      amount = Math.abs(raw);
      // Prefer an explicit DEBIT/CREDIT signal (Details or Type column, e.g. "ACH_DEBIT") over the sign heuristic.
      const dc = m.details ? r[m.details] : (m.type ? r[m.type] : '');
      const isOut = /debit/i.test(dc) ? true : /credit/i.test(dc) ? false
        : (raw > 0 ? m.positiveIsOut : !m.positiveIsOut);
      direction = isOut ? 'out' : 'in';
    } else continue;

    out.push({ date, description, amount, direction, account, bankType: m.type ? r[m.type] : undefined });
  }
  return out;
}

// #2: when the heuristic doesn't recognize the layout, let the LLM map columns + sign.
async function llmCsvMap(headers: string[], sample: string[][]): Promise<CsvMap | null> {
  try {
    assertKey();
    const prompt = `A bank/credit-card statement CSV has these columns:
${JSON.stringify(headers)}
Sample rows:
${sample.map(r => JSON.stringify(r)).join('\n')}

Identify the columns. Reply with ONLY JSON:
{"date": <header>, "description": <header>, "amount": <header or null>, "debit": <header or null>, "credit": <header or null>, "type": <header or null>, "positiveMeans": "out" | "in"}
- "amount" = a single signed amount column (else null and use debit/credit).
- If there are TWO separate money columns, one is DEBIT (money spent — store/restaurant/online purchases) and one is CREDIT (money received — deposits, PAYROLL, refunds). Decide which is which from the sample rows: a payroll/deposit row fills the CREDIT column; a purchase row fills the DEBIT column.
- "positiveMeans" (only for a single amount column) = does a POSITIVE number mean money OUT (charge/purchase) or IN (deposit/payment)? Most credit cards: positive = charge ("out"); most checking exports: positive = deposit ("in").`;
    const c = await nvidia.chat.completions.create({
      model: CATEGORIZE_MODEL, temperature: 0, max_tokens: 300,
      messages: [{ role: 'user', content: prompt }],
    }, { timeout: 30_000, maxRetries: 1 });
    const t = c.choices[0]?.message?.content ?? '';
    const mm = t.match(/\{[\s\S]*\}/);
    if (!mm) return null;
    const j = JSON.parse(mm[0]);
    const has = (h: any) => typeof h === 'string' && headers.includes(h) ? h : undefined;
    return {
      date: has(j.date), desc: has(j.description), amount: has(j.amount),
      debit: has(j.debit), credit: has(j.credit), type: has(j.type),
      positiveIsOut: j.positiveMeans !== 'in',
    };
  } catch { return null; }
}

// Deterministic column analysis for headerless CSVs (e.g. CIBC): find the date, money,
// and description columns by their contents, and tell debit from credit by row content.
function positionalMap(dataRows: string[][], headers: string[]): CsvMap {
  const isMoney = (c: string) => /^-?\$?\s?\(?-?\d[\d,]*\.\d{2}\)?$/.test(c.trim());
  const sample = dataRows.slice(0, 40);
  const stat = headers.map((_, i) => {
    let date = 0, money = 0, textLen = 0;
    for (const r of sample) { const c = (r[i] ?? '').trim(); if (!c) continue;
      if (usDate(c)) date++; else if (isMoney(c)) money++; else textLen += c.length; }
    return { i, date, money, textLen };
  });
  const dateCol = [...stat].sort((a, b) => b.date - a.date)[0];
  const moneyCols = stat.filter(s => s.money > 0 && s.i !== dateCol.i).sort((a, b) => a.i - b.i);
  const descCol = stat.filter(s => s.i !== dateCol.i && !moneyCols.some(m => m.i === s.i))
    .sort((a, b) => b.textLen - a.textLen)[0];

  const map: CsvMap = { date: headers[dateCol.i], desc: headers[descCol ? descCol.i : 1], positiveIsOut: false };
  const di = descCol ? descCol.i : 1;
  if (moneyCols.length >= 2) {
    let debitI = moneyCols[0].i, creditI = moneyCols[1].i; // CIBC default: debit column first
    for (const r of sample) {                              // ...but confirm from an income row
      if (/payroll|deposit|refund|interest|reversal|e-?transfer|payment from|gov|benefit/i.test(r[di] || '')) {
        const inDebit = !!(r[debitI] || '').trim(), inCredit = !!(r[creditI] || '').trim();
        if (inDebit && !inCredit) { [debitI, creditI] = [creditI, debitI]; }
        break;
      }
    }
    map.debit = headers[debitI]; map.credit = headers[creditI];
  } else if (moneyCols.length === 1) {
    map.amount = headers[moneyCols[0].i];
    // Single signed column: infer card-vs-bank sign from a payment row (payments are money-in).
    const mi = moneyCols[0].i;
    for (const r of sample) {
      if (/payment|thank you/i.test(r[di] || '')) {
        const v = parseFloat((r[mi] || '').replace(/[^0-9.-]/g, ''));
        if (isFinite(v) && v !== 0) { map.positiveIsOut = v < 0; break; } // payment negative => positive = charge (out)
      }
    }
  }
  return map;
}

async function extractCSV(buf: Buffer, account: string): Promise<RawRow[]> {
  const table = parseCSV(buf.toString('utf8')).filter(r => r.some(c => c.trim() !== ''));
  if (!table.length) return [];

  // Some banks (e.g. CIBC) export with NO header row — the first row is already a
  // transaction. Detect that (row 0 contains a date or a money amount) and synthesize
  // positional column names so the LLM mapper can still identify the columns.
  const looksLikeData = (row: string[]) =>
    row.some(c => usDate(c.trim())) || row.some(c => /^\$?\s?-?\d[\d,]*\.\d{2}$/.test(c.trim()));
  const headerless = looksLikeData(table[0]);
  const headers = headerless ? table[0].map((_, i) => `col${i + 1}`) : table[0].map(h => h.trim());
  const dataRows = headerless ? table : table.slice(1);
  if (!dataRows.length) return [];
  const rows = dataRows.map(r => Object.fromEntries(headers.map((h, i) => [h, (r[i] ?? '').trim()])));

  // headerless -> deterministic positional analysis; otherwise header-name heuristic.
  let out = buildRows(rows, headerless ? positionalMap(dataRows, headers) : heuristicMap(headers), account);
  if (!out.length) {
    console.error(`[stmt] ${headerless ? 'headerless' : 'unrecognized'} CSV (${headers.join(', ')}) — asking LLM to map columns`);
    const map = await llmCsvMap(headers, dataRows.slice(0, 4));
    if (map) out = buildRows(rows, map, account);
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
  // Keep only real transaction lines: they have BOTH a date and a currency amount.
  // Summary/balance lines (Previous Balance, Credit Limit, Payments total) have an
  // amount but no date, so this drops them — the #1 cause of phantom transactions.
  const hasDate = /\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s+\d{1,2}\b/i;
  const hasAmount = /\$?\s?\d[\d,]*\.\d{2}\b/;
  const txLines = text.split('\n').filter(l => hasDate.test(l) && hasAmount.test(l));
  if (!txLines.length) return [];

  // Chunk the filtered lines (~8k chars/chunk) so nothing is truncated; run in parallel.
  const chunks: string[] = [];
  let buf = '';
  for (const line of txLines) {
    if (buf.length + line.length + 1 > 8000) { if (buf.trim()) chunks.push(buf); buf = ''; }
    buf += line + '\n';
  }
  if (buf.trim()) chunks.push(buf);

  // Ask the model to TRANSCRIBE the signed amount (reliable) rather than JUDGE direction (error-prone).
  const parse = (body: string) => `Extract every transaction from this statement text.
Return ONLY a JSON array. Each item: {"date":"YYYY-MM-DD","description":string,"amount":number}.
amount must be NEGATIVE if the line shows a minus sign, parentheses, or "CR" (a payment/credit/refund);
POSITIVE otherwise (a charge/purchase/debit). Copy the number exactly. Assume the statement's year for MM/DD dates.
Each line here is one transaction. If a line isn't a transaction, skip it.

TRANSACTION LINES:
${body}`;

  const perChunk = await Promise.all(chunks.map(async (body): Promise<RawRow[]> => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const c = await nvidia.chat.completions.create({
          // non-reasoning model: emits the JSON array directly (reasoning models bury it in prose)
          model: CATEGORIZE_MODEL, temperature: 0, max_tokens: 4000,
          messages: [{ role: 'user', content: parse(body) }],
        }, { timeout: 45_000, maxRetries: 0 });
        const t = c.choices[0]?.message?.content ?? '';
        const m = t.match(/\[[\s\S]*\]/);
        if (!m) return [];
        return (JSON.parse(m[0]) as any[])
          .filter(r => r?.date && r?.amount != null && /^\d{4}-\d{2}-\d{2}$/.test(r.date))
          .map(r => {
            const signed = +r.amount;               // negative = credit/payment (card convention)
            return { date: r.date, description: String(r.description || '').trim(),
                     amount: Math.abs(signed), direction: signed < 0 ? 'in' : 'out', account } as RawRow;
          });
      } catch { /* retry once, then skip this chunk */ }
    }
    return [];
  }));

  // Line-boundary chunks don't overlap, so no cross-chunk de-dup needed here;
  // the occurrence-aware ext_id at commit still makes re-imports idempotent.
  const out = perChunk.flat();
  console.error(`[stmt] PDF LLM extraction: ${chunks.length} chunk(s) -> ${out.length} transactions`);
  return out;
}

// ---------- classification: transfers / card payments / income ------------

const ISSUERS = /(discover|capital one|chase|amex|american express|citi|synchrony|barclay|wells fargo|bank of america|boa|ally|sofi|visa|mastercard|cibc|rbc|td|scotiabank|bmo|tangerine)\b/i;
const PAYMENT = /\b(payment|paymt|pymt|pmt|e-?payment|autopay|auto pay|thank you|(online|mobile) (pymt|pmt|payment))\b/i;
const XFER    = /\b(zelle|quickpay|acct xfer|account transfer|online transfer|transfer (to|from)|wire (transfer|incoming|outgoing)|to sav|from sav|to chk|from chk|venmo|cash ?app|paypal|interac|e-?transfer|real time payment|ally|sofi|marcus)\b/i;
// Gambling/betting: gross deposits churn (you withdraw much of it), so treat as money-movement, not spend. Editable in review.
const BETTING = /\b(draftkings|dk\*|fanduel|betfair|betmgm|caesars ?(sports|palace)|bet365|pointsbet|polymarket|underdog|prizepicks|bovada|sportsbook|sportsbk)/i;
// Person-to-person apps (individual, not a company).
const P2P = /\b(zelle|venmo|cash ?app|quickpay|interac|e-?transfer)\b/i;
// Brokerage / robo-advisor / crypto / investing apps -> "Investment" (money moved to an asset,
// not spending). Named apps are guaranteed here; the LLM catches other investing apps dynamically.
// Prefix matchers (no trailing \b) — bank strings glue brands to more text ("APEXTRADERFUNDING", "...INVESTMENTS").
const INVESTING = /\b(robinhood|webull|wealthsimple|alinea|e\*?trade|etrade|m1 finance|stash|acorns|betterment|wealthfront|vanguard|fidelity|schwab|questrade|ameritrade|interactive brokers|ibkr|sofi invest|coinbase|crypto|kraken|binance|gemini|blockfi|brokerage|securities|invest)/i;
// Futures/forex prop-trading firms (evaluation & funding fees) — a trading cost, its own category.
const PROP_TRADING = /\b(apex[ -]?trader|alpha[ -]?futures|topstep|tradovate|ftmo|funded[ -]?trader|earn2trade|my[ -]?forex[ -]?funds|fundednext|e8[ -]?(funding|markets)|leeloo|uprofit|bulenox|take[ -]?profit[ -]?trader|myfundedfx|blue[ -]?guardian|prop[ -]?firm|prop[ -]?trading)/i;

/** Returns a definite classification, or null to let the LLM decide the category. */
function ruleClassify(r: RawRow): { excluded: boolean; type: 'expense'|'income'; category: string; reason: string } | null {
  const d = r.description;
  // Person-to-person FIRST (a "Zelle payment from X" contains the word "payment" but is P2P,
  // not a card payment): money IN from a person = reimbursement; money OUT = transfer. Both excluded.
  if (P2P.test(d)) return { excluded: true, type: r.direction === 'in' ? 'income' : 'expense',
    category: r.direction === 'in' ? 'Reimbursement' : 'Transfer', reason: 'person-to-person' };
  // Card payment -> transfer, never spend. Two shapes:
  //  - incoming "PAYMENT / THANK YOU" on a card statement (reduces the card balance)
  //  - outgoing payment from checking naming the card issuer (e.g. "DISCOVER E-PAYMENT")
  if (PAYMENT.test(d) && (r.direction === 'in' || ISSUERS.test(d))) {
    return { excluded: true, type: r.direction === 'in' ? 'income' : 'expense', category: 'Transfer', reason: 'card payment' };
  }
  if (PROP_TRADING.test(d)) return { excluded: false, type: r.direction === 'in' ? 'income' : 'expense', category: 'Prop Trading', reason: 'prop trading' };
  if (INVESTING.test(d)) return { excluded: true, type: r.direction === 'in' ? 'income' : 'expense', category: 'Investment', reason: 'investing/brokerage' };
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
    'Internet','Cell Phone Bill','Subscriptions','Utilities','Health','Entertainment','Education','Travel','Fees','Prop Trading','Miscellaneous'];
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

// ---------- learned merchant memory ---------------------------------------
// Stable key for a merchant string: alpha-only, first two significant tokens.
// Groups "WALMART STORE 04295 ..." and "WALMART STORE 00489 ..." to one key.
function normalizeMerchant(desc: string): string {
  return desc.toUpperCase().replace(/[^A-Z ]+/g, ' ').replace(/\s+/g, ' ').trim()
    .split(' ').filter(t => t.length >= 2).slice(0, 2).join(' ');
}
// Movement labels are decided by rules/direction each time, not by merchant — don't memorize them.
const MOVEMENT = new Set(['Transfer', 'Income', 'Reimbursement', 'Investment']);
export function learnMerchant(desc: string, category: string) {
  const key = normalizeMerchant(desc);
  if (!key || !category || MOVEMENT.has(category)) return;
  db.prepare(`INSERT INTO merchant_categories (merchant, category, updated_at) VALUES (?, ?, datetime('now'))
              ON CONFLICT(merchant) DO UPDATE SET category=excluded.category, updated_at=excluded.updated_at`)
    .run(key, category);
}
function lookupMerchants(descs: string[]): Record<string, string> {
  const stmt = db.prepare(`SELECT category FROM merchant_categories WHERE merchant=?`);
  const out: Record<string, string> = {};
  for (const d of descs) { const row = stmt.get(normalizeMerchant(d)) as { category: string } | undefined; if (row) out[d] = row.category; }
  return out;
}

type CatItem = { desc: string; dir: 'out' | 'in'; account: string; amount: number };

async function categorize(items: CatItem[], cats: string[]): Promise<Record<string, string>> {
  const uniq = new Map<string, CatItem>();
  for (const it of items) if (!uniq.has(it.desc)) uniq.set(it.desc, it);
  const list = [...uniq.values()];
  if (!list.length) return {};

  const result: Record<string, string> = {};
  // 1) learned merchant memory (consistent + improves from past edits)
  const mem = lookupMerchants(list.map(i => i.desc));
  // 2) local merchant dictionary (spending, money-out only)
  const remaining: CatItem[] = [];
  for (const it of list) {
    if (mem[it.desc]) { result[it.desc] = mem[it.desc]; continue; }
    if (it.dir === 'out') { const lc = localCategory(it.desc); if (lc) { result[it.desc] = lc; continue; } }
    remaining.push(it);
  }
  if (!remaining.length) return result;

  // 3) LLM for the rest — with direction/amount context and person-vs-company inflow logic.
  assertKey();
  const allowed = new Set([...cats, 'Income', 'Reimbursement', 'Transfer', 'Investment']);
  const chunkSize = 40;
  const chunks: CatItem[][] = [];
  for (let i = 0; i < remaining.length; i += chunkSize) chunks.push(remaining.slice(i, i + chunkSize));

  const results = await Promise.all(chunks.map(async (chunk): Promise<(readonly [string, string])[]> => {
    const fallback = (it: CatItem) => it.dir === 'in' ? 'Income' : 'Miscellaneous';
    const prompt = `You label bank/card transactions. Spending categories: ${cats.join(', ')}.
For each item pick ONE label:
- direction "out": a spending category, or "Investment" if it goes to a brokerage/robo-advisor/investing or crypto app (e.g. Robinhood, Wealthsimple, Webull, Fidelity, Coinbase), or "Prop Trading" for futures/forex prop-firm evaluation or funding fees (e.g. Apex Trader, Topstep, FTMO, Tradovate), or "Transfer" if it moves your own money between accounts / pays a credit card, or is a gambling/betting deposit.
- direction "in": "Income" if from a company/employer/government/refund/rewards; "Reimbursement" if an individual PERSON is paying you back; "Transfer" if moving your own money between your accounts.
Merchant/payer strings may contain city/state/ID noise — infer the real entity; a personal name implies a person.
Reply with ONLY a JSON array of labels, one per item, IN THE SAME ORDER.

Items (${chunk.length}):
${JSON.stringify(chunk.map(i => ({ description: i.desc, direction: i.dir, amount: i.amount, account: i.account })))}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const c = await nvidia.chat.completions.create({
          model: CATEGORIZE_MODEL, temperature: 0, max_tokens: 1200,
          messages: [{ role: 'user', content: prompt }],
        }, { timeout: 30_000, maxRetries: 0 });
        const t = c.choices[0]?.message?.content ?? '';
        const m = t.match(/\[[\s\S]*\]/);
        const arr: string[] = m ? JSON.parse(m[0]) : [];
        return chunk.map((it, i) => [it.desc, allowed.has(arr[i]) ? arr[i] : fallback(it)] as const);
      } catch { /* retry once, then fall back */ }
    }
    return chunk.map(it => [it.desc, fallback(it)] as const);
  }));

  return { ...result, ...Object.fromEntries(results.flat()) };
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
    raw = await extractCSV(file.buffer, account);
  }

  // occurrence index so legitimately-identical rows keep distinct ext_ids, but re-imports match.
  const occ = new Map<string, number>();
  const cats = allowedCategories();

  // rule pass first; everything else (both money-in and money-out) goes to categorize,
  // which tries learned memory -> merchant dictionary -> LLM.
  const pre = raw.map(r => ({ r, rule: ruleClassify(r) }));
  const items = pre.filter(p => !p.rule).map(p => ({
    desc: p.r.description, dir: p.r.direction, account: p.r.account, amount: p.r.amount,
  }));
  console.error(`[stmt] ${file.name}: extracted ${raw.length}, categorizing ${items.length} rows…`);
  const t0 = Date.now();
  const catMap = await categorize(items, cats);
  console.error(`[stmt] categorized in ${Date.now() - t0}ms`);

  const existing = db.prepare(`SELECT ext_id FROM transactions WHERE ext_id IS NOT NULL`).all() as {ext_id:string}[];
  const known = new Set(existing.map(e => e.ext_id));

  const proposed: ProposedTx[] = pre.map(({ r, rule }) => {
    const key = `${r.account}|${r.date}|${r.amount.toFixed(2)}|${normDesc(r.description)}`;
    const n = occ.get(key) ?? 0; occ.set(key, n + 1);
    const extId = extIdFor(r, n);

    let type: 'expense'|'income', category: string, excluded: boolean, reason: string | undefined;
    if (rule) { ({ type, category, excluded, reason } = rule); }
    else {
      const c = catMap[r.description] || (r.direction === 'in' ? 'Income' : 'Miscellaneous');
      if (c === 'Transfer') { type = r.direction === 'in' ? 'income' : 'expense'; category = 'Transfer'; excluded = true; reason = 'moved money (not spending)'; }
      else if (c === 'Investment') { type = r.direction === 'in' ? 'income' : 'expense'; category = 'Investment'; excluded = true; reason = 'investing/brokerage'; }
      else if (c === 'Reimbursement') { type = 'income'; category = 'Reimbursement'; excluded = true; reason = 'reimbursement (from a person)'; }
      else if (c === 'Income') { type = 'income'; category = 'Income'; excluded = false; }
      else if (c === 'Prop Trading') { type = r.direction === 'in' ? 'income' : 'expense'; category = 'Prop Trading'; excluded = false; }
      else if (r.direction === 'in') { type = 'income'; category = 'Income'; excluded = false; } // a spending label on an inflow -> treat as income
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
      learnMerchant(r.description, r.category); // remember the (possibly user-edited) category
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { inserted, skipped };
}
