# Budget — personal finance tracker

Track expenses & savings, import your existing budget spreadsheet, scan receipts with a
vision LLM, and get AI insights. Multi-user with email/password auth; each account's data is
isolated. NVIDIA build API (OpenAI-compatible) powers insights and receipt scanning; your key
stays on the backend.

**Stack:** React + TypeScript + Vite (frontend) · Express + TypeScript (backend) ·
Supabase (Postgres + Auth) · Recharts · NVIDIA build API.

## Setup

1. **Supabase** — create a project and run the SQL in [`DB/`](DB/) (see [DB/README.md](DB/README.md)
   for the exact steps and where to copy each key).
2. **Env** — fill in both from the examples:

```bash
npm run install:all          # installs root + server + web
cp server/.env.example server/.env   # NVIDIA_API_KEY + DATABASE_URL + SUPABASE_* keys
cp web/.env.example web/.env         # VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY
npm run dev                          # server on :5174, web on :5173
```

Open http://localhost:5173, register an account, and sign in.

## Using it

- **Statements** — drop bank/card exports (Discover / Chase CSV, Capital One PDF; multiple at once).
  Transactions are auto-categorized and shown in a review screen **before anything saves**.
  Transfers, credit-card payments, and betting/investment churn are flagged and **excluded from
  spending** so cross-account money movement doesn't double-count. Edit any category, include/exclude
  rows, then import. Re-importing the same file is safe (idempotent — duplicates are skipped).
  Requires `pdftotext` for PDF statements (`brew install poppler`).
- **Import sheet** — drop your budget `.xlsx`, pick which monthly tabs are yours, import.
  Parses the "Budget by Paycheck" template: expense log, income, and per-category budgets.
  Re-importing **replaces** previously imported sheet data.
- **Transactions** — add / edit / delete; **✂ Split** one transaction across categories (e.g. a $100
  store run → $60 Groceries + $40 Household). The parent stays as the real money movement (kept in
  account/net-worth flow); the child slices carry the categories (counted in spending & budgets) — so
  nothing double-counts. **📷 Scan receipt** → vision LLM extracts merchant,
  total, date, category and pre-fills the form (images are downscaled in-browser before upload).
  **⬇ Export** downloads every transaction as CSV (`/api/export?format=csv`, or `?format=json`) — your data is yours.
- **Net worth** — accounts are discovered automatically from your imported transactions; set each
  account's **opening balance** and type (asset / credit / investment / cash) and the app derives a
  current balance (opening + income − expense) and a **net-worth-over-time** chart. Credit cards show
  as negative (debt). Fully derived — a payment from an account you never imported, or an asset with no
  transaction feed (house, 401k), won't appear.
- **Recurring** — detects subscriptions and recurring bills from your history by charge cadence
  (weekly/biweekly/monthly/quarterly/yearly), showing average amount, normalized monthly cost, next
  expected charge, and a total "recurring / month". Regularly-visited merchants (groceries) are filtered
  out by an interval-regularity gate; stale ones (last charge too long ago) show as inactive.
- **Dashboard** — KPIs (income / expenses / net / savings rate), spending by category,
  budget vs actual (green = within, red = over), income-vs-expense trend, and an **AI insights**
  panel you can also ask free-form questions. Budgets use **sinking-fund carryover**: unspent (or
  overspent) budget rolls into the next month, so each category shows a running *available* balance
  (available = carried-in + this month's budget − spent). Derived from your data — no setup.

### How statements are classified

| Kind | Example | Treatment |
|------|---------|-----------|
| Card purchase | `WAL-MART`, `AMAZON` | Expense, auto-categorized |
| Card payment | `CAPITAL ONE MOBILE PMT`, `INTERNET PAYMENT - THANK YOU` | Excluded (transfer) |
| Account transfer | `ONLINE TRANSFER`, `WIRE`, `TO SAV` | Excluded (transfer) |
| Investment | Robinhood, Alinea, Wealthsimple, Webull, Coinbase, brokerages | Excluded (money to an asset), category **Investment** |
| Prop Trading | Apex Trader, Alpha Futures, Topstep, FTMO, Tradovate | Counted as a **Prop Trading** expense (a trading cost); payouts count as income |
| Reimbursement | `ZELLE from <person>`, Venmo from a person | Excluded (person paying you back) |
| Income | `PAYROLL`, company deposits, refunds, rewards | Income |
| Betting | `DRAFTKINGS`, `FANDUEL`, `POLYMARKET` | Excluded by default (churn) — re-include if you count it as spending |

Classification is a **hybrid** (the industry-standard approach): user **keyword rules** (highest
priority — "any description word starting with `cuis` → Dining", managed under Transactions → ⚙
Categories), deterministic rules for the money-movement guards above (they must be reliable or totals
break), a **learned merchant→category memory** that improves from your edits, and an LLM for the long
tail with direction/amount context
(money-in is Income from a company vs Reimbursement from a person). Named investing apps are
guaranteed by rule; unknown ones are caught by the LLM. Everything is editable in the review
screen — nothing is final until you import, and any edit is remembered for next time.

**Formats:** CSV (with or without a header row — e.g. CIBC's headerless export is detected and its
columns inferred by content), and PDF (Capital One has an exact parser; other banks' PDFs are read by
the LLM). Dates handle `MM/DD/YYYY` and ISO `YYYY-MM-DD`. If an unusual bank's signs come in inverted,
use the per-row **Type** control or the **Flip income/expense** button in the review screen. Currency
display is a single constant (`USD`) in `web/src/util.ts` — change it for CAD/other.

## Config (server/.env)

| var | default | notes |
|-----|---------|-------|
| `NVIDIA_API_KEY` | — | required for insights + receipt scan |
| `INSIGHTS_MODEL` | `meta/llama-3.3-70b-instruct` | any NVIDIA chat model |
| `VISION_MODEL` | `meta/llama-3.2-90b-vision-instruct` | any NVIDIA vision model |
| `PORT` | `5174` | backend port (Vite proxies `/api` here) |
| `DATABASE_URL` | — | Supabase Postgres connection string (pooler URI) |
| `SUPABASE_URL` | — | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | — | **secret**, backend only — validates sessions |

Frontend (`web/.env`): `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, and optional
`VITE_API_URL` (backend origin in production; unset in dev).

## Deploy (use it on your phone)

The frontend is a responsive SPA — open it on your phone and **Add to Home Screen**.

- **Frontend** → Vercel / Netlify / Cloudflare Pages (free). Build `web`, set the two
  `VITE_SUPABASE_*` vars + `VITE_API_URL` pointing at the backend.
- **Backend** → a host that runs a container with a persistent process and lets you install
  `pdftotext` (Render / Fly.io / Railway). Set the server env vars there. Serverless (Vercel
  functions) can't run the `pdftotext` binary, so Capital One PDF import would break there.
- **Data + auth** → Supabase (persistent, isolated per user via RLS). Nothing to host yourself.
- Lock CORS to your frontend origin before going public.

## Notes / deliberate simplifications

- Currency is a single constant (`USD`) in `web/src/util.ts` — change there.
- Excel dates: the sheet mixed `dd/mm` and `mm/dd`; import buckets each row into its tab's
  month (keeping an exact day only when unambiguous). Correct for monthly budgeting.
- Auth is Supabase email/password; every API route requires a valid session and all data is
  scoped per user (app-level `user_id` filters + Postgres RLS as defense-in-depth).
