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

- **Import** — drop your budget `.xlsx`, pick which monthly tabs are yours, import.
  Parses the "Budget by Paycheck" template: actual expense log, income actuals, and
  per-category budgets. Re-importing **replaces** previously imported data (one-time migration,
  not a live sync).
- **Transactions** — add / edit / delete; **📷 Scan receipt** → vision LLM extracts merchant,
  total, date, category and pre-fills the form (images are downscaled in-browser before upload).
- **Dashboard** — KPIs (income / expenses / net / savings rate), spending by category,
  budget vs actual (green = within, red = over), income-vs-expense trend, and an **AI insights**
  panel you can also ask free-form questions.

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
