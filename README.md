# Budget — personal finance tracker

Track expenses & savings, import your existing budget spreadsheet, scan receipts with a
vision LLM, and get AI insights — all local, single-user. NVIDIA build API (OpenAI-compatible)
powers insights and receipt scanning; your key stays on the backend.

**Stack:** React + TypeScript + Vite (frontend) · Express + TypeScript + `node:sqlite` (backend) ·
Recharts · NVIDIA build API.

## Setup

```bash
npm run install:all          # installs root + server + web
cp server/.env.example server/.env
# edit server/.env -> paste your NVIDIA_API_KEY (from https://build.nvidia.com)
npm run dev                  # server on :5174, web on :5173
```

Open http://localhost:5173.

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
- **Transactions** — add / edit / delete; **📷 Scan receipt** → vision LLM extracts merchant,
  total, date, category and pre-fills the form (images are downscaled in-browser before upload).
- **Dashboard** — KPIs (income / expenses / net / savings rate), spending by category,
  budget vs actual (green = within, red = over), income-vs-expense trend, and an **AI insights**
  panel you can also ask free-form questions.

### How statements are classified

| Kind | Example | Treatment |
|------|---------|-----------|
| Card purchase | `WAL-MART`, `AMAZON` | Expense, auto-categorized |
| Card payment | `CAPITAL ONE MOBILE PMT`, `INTERNET PAYMENT - THANK YOU` | Excluded (transfer) |
| Account transfer | `ONLINE TRANSFER`, `WIRE`, `TO SAV` | Excluded (transfer) |
| Investment | Robinhood, Alinea, Wealthsimple, Webull, Coinbase, brokerages | Excluded (money to an asset), category **Investment** |
| Reimbursement | `ZELLE from <person>`, Venmo from a person | Excluded (person paying you back) |
| Income | `PAYROLL`, company deposits, refunds, rewards | Income |
| Betting | `DRAFTKINGS`, `FANDUEL`, `POLYMARKET` | Excluded by default (churn) — re-include if you count it as spending |

Classification is a **hybrid** (the industry-standard approach): deterministic rules for the
money-movement guards above (they must be reliable or totals break), a **learned merchant→category
memory** that improves from your edits, and an LLM for the long tail with direction/amount context
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
| `DB_PATH` | `./budget.db` | SQLite file |

## Notes / deliberate simplifications

- Currency is a single constant (`USD`) in `web/src/util.ts` — change there.
- Excel dates: the sheet mixed `dd/mm` and `mm/dd`; import buckets each row into its tab's
  month (keeping an exact day only when unambiguous). Correct for monthly budgeting.
- No auth — it's a local single-user app. Don't expose the backend publicly as-is.
