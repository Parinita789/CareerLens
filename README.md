# Job Agent Monorepo

> **Developed for personal use.** The multi-agent-looking surface is an architecture exercise — the actual runtime is a sequential pipeline of pure functions, not a production scale-out target.

An AI-powered job-hunting tool that scrapes listings from multiple platforms, scores them for fit, generates tailored cover letters, pre-scrapes application forms for review, and — optionally — submits LinkedIn Easy Apply and Greenhouse/Ashby applications for you. Everything is in one monorepo with a single `npm run dev` workflow.

## Architecture

```
packages/
├── shared/    — Mongoose schemas, DB connection, unified LLM client, cover-letter generator
├── scraper/   — Job scraping, scoring, cover letters, form pre-scraping, auto-apply, eval harnesses
├── api/       — NestJS REST API (jobs, profile, pipeline, settings, form-answers, alerts)
└── ui/        — React + Vite dashboard
```

## Pipeline

Selectable from the dashboard's Pipeline modal, or runnable individually via npm scripts.

| Phase              | What it does                                                                                                                                                                 |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Scrape & Score** | Scrapes Ashby, Greenhouse, LinkedIn (8 queries + alerts), Lever. Two-layer filter + LLM scoring per company/query. Jobs scoring 7+ get their forms pre-scraped automatically. |
| **Gmail Alerts**   | Polls Gmail IMAP for today's LinkedIn alert emails. Parses job URLs, scrapes each page, scores per alert keyword.                                                            |
| **Cover Letters**  | LLM-generated 3-paragraph cover letters for `to_apply` jobs. Runs in-process from the API; no subprocess spawn.                                                              |
| **Auto Apply**     | Opens Greenhouse / Ashby / LinkedIn Easy Apply, fills every field from pre-scraped answers + rules + profile (zero LLM calls). Submit click gated on a global UI toggle.       |

## "LLM is last option" architecture

Every form question flows through layered answer resolution. LLM only fires when everything deterministic misses.

| Priority | Source                 | Notes                                                                              |
| -------- | ---------------------- | ---------------------------------------------------------------------------------- |
| 1        | **Pre-scraped answers**| Reviewed in Prepare tab, stored in `applicationFields` collection                  |
| 2        | **Saved rules**        | `ProfileAnswer` collection — user corrections + demographic rules + seed defaults  |
| 3        | **Profile defaults**   | Identity/demographics pulled from `UserModel` (name, phone, gender, pronouns, etc.) |
| 4        | **LLM fallback**       | Receives demographics + ALL saved rules as context so paraphrases still resolve   |

The LLM prompt for questions always includes a **Candidate demographics** block and a **Saved answers** list — so even when a paraphrase misses the rule regex, the LLM sees ground truth and can't invent answers.

## Prepare Tab — Pre-Scrape & Review Before Apply

Core workflow: every answer reviewed BEFORE the bot fills the form.

1. During scraping, jobs scoring 7+ get their Greenhouse forms pre-scraped (parallel, 5 at a time)
2. Every input, dropdown, radio, checkbox, textarea captured with labels, types, options
3. Auto-answered from pre-scraped data → saved rules → profile → LLM
4. Shown in Prepare tab — expandable table, options as chips, required fields marked with red `*`
5. Edit any answer inline — edits saved as rules for all future applications
6. One-click Auto Apply fills the form instantly, no LLM regeneration

Features:
- **Status indicators** — Ready (all fields answered) / Needs Review (required unknowns)
- **Batch apply** — "X Ready — Click to Apply" button for all ready jobs at once
- **Per-job Auto Apply** + Dismiss (×) to remove jobs you won't touch
- **Cover letter preview** — expanded view shows the generated letter
- **Phone-code pickers + phone radio groups** auto-filtered (they're form garbage)

## Global safety toggle — Auto-submit ON/OFF

A **master switch in the header** controls whether the bot is allowed to click "Submit Application" during auto-apply.

- **OFF (default, dry-run)** — fills every form field, runs every auto-fill routine, then STOPS before the Submit click. Prints the final form snapshot to the console so you can see what would have been submitted.
- **ON (live)** — bot clicks Submit on Greenhouse/Ashby and on LinkedIn Easy Apply's review step.

The toggle is persisted in `UserModel.settings.allowAutoSubmit` via `GET`/`PUT /api/settings`. The pipeline service re-reads it on every apply spawn, so flipping the switch takes effect without restarting anything.

## Eval harnesses

Four regression harnesses that call the real LLM paths with fixtures and grade the output. Run on demand, not from `npm test`.

| Command                          | Target function                        | Fixture                                         |
| -------------------------------- | -------------------------------------- | ----------------------------------------------- |
| `npm run eval:answers`           | `answerQuestion` (form Q&A)            | `eval/fixtures/answer-cases.json` (45 cases)    |
| `npm run eval:cover-letters`     | `generateCoverLetter`                  | `eval/fixtures/cover-letter-cases.json` (4)     |
| `npm run eval:form-pre-answer`   | `preAnswerFields` (bulk form filler)   | `eval/fixtures/form-pre-answerer-cases.json` (15 field assertions — grades value AND source) |
| `npm run eval:scorer`            | `scoreFitWithLLM`                      | `eval/fixtures/scorer-cases.json` (5)           |
| `npm run eval:all`               | all four in sequence                   | ~3.5 min total; exits non-zero on any failure   |

Shared grader utilities live in `packages/scraper/src/eval/_lib.ts`. Grading predicates: `equals`, `includes`, `oneOf`, `notIncludes`, `regex`, `minLength`, `maxLength`, plus numeric-range and array-inclusion helpers for the scorer harness.

**Seeding** — one-time setup to populate canonical rules and demographics:

```bash
npm run eval:seed-rules          # salary/experience/remote keyword rules
npm run eval:seed-demographics   # UserModel.demographics + paraphrase-friendly rules
```

## Auto Apply (Greenhouse / Ashby)

The form filler:

1. **Loads pre-scraped answers** from `applicationFields` collection
2. **Resolves URL** — converts company career page URLs to `job-boards.greenhouse.io`, handles iframes
3. **Clicks "Autofill with MyGreenhouse"** if available
4. **Uploads resume + cover letter** — cover letter loaded from DB (no LLM regen)
5. **Fills every field** via `input.fill()` (pre-scraped answers + rules + profile)
6. **Dropdowns scoped via `aria-controls`** — prevents the phone country picker from hijacking selection
7. **Two-pass combobox scan** with scrolling to catch lazy-loaded fields
8. **Fill-by-ID fallback** finds any missed combobox directly
9. **Checkbox groups** — "select all that apply" handled
10. **Submit (guarded)** — clicks Submit only if the global Auto-submit toggle is ON; otherwise logs "Submit disabled — review mode" and exits
11. **Success detection** — submit button gone + "thank you" text → marks job `applied`, removes from Prepare tab
12. **Zero LLM calls during auto-apply** — all answers deterministic

### Smart Option Matching (`smartMatchOption`)

Deterministic matching of short rule-answers onto long-form dropdown options:

| Rule answer        | Dropdown options                                           | Match method                            |
| ------------------ | ---------------------------------------------------------- | --------------------------------------- |
| `"United States"`  | `"US"`, `"USA"`, `"United States of America"`              | Country aliases                         |
| `"Yes"` / `"No"`   | `"Yes, I am authorized..."`, `"No, I will not require..."` | Starts-with + positive/negative phrasing |
| `"Female"`         | `"Female"`, `"Woman"`, `"Female (she/her)"`                | Gender aliases                          |
| `"Asian"`          | `"South Asian (inclusive of...)"`, `"Asian"`               | Prefers South Asian, falls back to Asian |
| `"Heterosexual"`   | `"Straight"`, `"Cisgender"`                                | Sexual orientation aliases              |
| `"No"` (veteran)   | `"I am not a protected veteran"`                           | Label-aware negative matching           |

## Auto Apply (LinkedIn Easy Apply)

Separate flow — `applyViaEasyApply`. Walks the multi-step modal, uploads resume, handles the review step. The final Submit click is gated on the same global Auto-submit toggle.

## Dashboard

- **Tabs** — Queue, Prepare, Applied, Accepted, Declined, Rejected, Cover Letters
- **Filters** — Search (company/title), Platform, Score (5-9), "New" only
- **Scraped date column** on every tab — relative time (`3d ago`, `2w ago`), hover for full timestamp. Helps you spot "I've seen this job before."
- **Select to Auto Apply** — checkboxes on Queue → Auto Apply / Generate Cover Letters
- **Status dropdown** on Applied tab — Waiting, Interviewing, Accepted, Declined, No Response
- **Header** — Auto-submit pill (ON green / OFF red), hamburger menu
- **Hamburger** — Candidate Profile, Saved Rules, Keywords, Pipeline
- **Floating pipeline bar** — live logs + Stop button while anything is running

## Tech Stack

- **Language** — TypeScript across the monorepo (npm workspaces)
- **Scraping** — Playwright (Chrome). Non-headless for interactive LinkedIn login + apply; headless for API-board scrapes and Gmail URL scrapes
- **LLM** — Claude CLI / Anthropic SDK / Ollama — switchable via `LLM_PROVIDER` env
- **Backend** — NestJS on Node.js
- **Frontend** — React 18, Vite
- **Database** — MongoDB (Mongoose)
- **Email** — Gmail IMAP (`imapflow`)

## LLM providers

Controlled by `LLM_PROVIDER` in `.env`:

| Provider       | How                                                            | Notes                                                                    |
| -------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `claude-cli`   | Spawns `claude -p --model claude-sonnet-4-6` subprocess        | Uses your Claude CLI subscription. Subprocess startup adds ~10s per call |
| `anthropic`    | Direct Anthropic SDK with `claude-sonnet-4-6`                  | Fastest per-call (~5-10s). Requires `ANTHROPIC_API_KEY`                  |
| `ollama`       | Local or remote Ollama server                                  | Free. Quality depends on local model (defaults to `llama3:8b-instruct`)  |

All consumers call `llmChat()` from `@job-agent/shared` — scoring, cover letters, form Q&A, resume parsing all switch together.

## Design decisions

### Pre-scrape and review, don't fill live
LLM-based form filling during auto-apply was slow, error-prone, and unreviewable. Forms are pre-scraped headlessly during scoring → reviewed in Prepare → auto-apply uses pre-verified answers instantly. No LLM calls during the time-sensitive browser fill.

### Dry-run by default
The global Auto-submit toggle defaults to OFF. Flipping it ON is a deliberate, visible action in the header. Matches the pre-toggle behavior (submit was hardcoded disabled) while making the switch reachable without editing code.

### Demographics in DB, not hardcoded
`UserModel.demographics` holds race, pronouns, disability, veteran, citizenship, etc. Injected into every LLM prompt so paraphrased questions ("What is your ethnicity?") resolve correctly without needing per-paraphrase keyword rules.

### Dropdown menu scoping via `aria-controls`
Greenhouse forms always have a phone country code picker in the DOM. A generic `querySelectorAll('[role="option"]')` returned 246 phone-code options. Each React Select has `aria-controls="react-select-{id}-listbox"` — option reading is now scoped to that specific menu.

### Separate LinkedIn sessions
`linkedin-session.json` — scraping session (test account). `linkedin-session-apply.json` — apply session (real account). Prevents rate limiting during bulk scrape from burning the account used to submit applications.

### Cover letter generation lives in `@job-agent/shared`
Used to be spawned via `npx tsx generate-one-cover-letter.ts` — that added ~5s per call. Now imported in-process by the API. Single reference letter (down from 3), deduplicated banned-phrases list, `claude-sonnet-4-6` (down from Opus 4.6). End-to-end ~10-15s.

### Required-field detection
`*` in label → required. Plus a known-pattern fallback: name, email, phone, resume, sponsorship, visa, authorization, country, gender. "Needs Review" only triggers when a required field is unanswered — optional unknowns don't block batch apply.

### 10-day freshness filter
Jobs older than 10 days (by source-provided `posted_at`) are dropped before scoring. Stale roles are usually filled; LLM budget would be wasted.

### Anti-detection
- Full-screen Chrome with realistic fingerprint (plugins, hardware, geolocation, screen)
- `navigator.webdriver` set to `undefined`
- Cookie persistence between runs
- LinkedIn login uses 5-minute manual-login polling with per-transition URL logging, waits for the `li_at` auth cookie rather than URL patterns (catches SSO / checkpoint / email-verification flows correctly)

## Getting started

### Prerequisites

- Node.js, npm
- MongoDB (local or Docker — `mongodb://localhost:27017/job-tracker`)
- One of:
  - Claude Code CLI (for `claude-cli` provider)
  - Anthropic API key (for `anthropic` provider)
  - Ollama server (for `ollama` provider)

### Install

```bash
npm install
```

### Environment

Create `.env` at the repo root:

```
MONGO_URI=mongodb://localhost:27017/job-tracker
API_PORT=3001
LLM_PROVIDER=claude-cli
OLLAMA_BASE_URL=http://localhost:11434/v1
OLLAMA_MODEL=llama3:8b-instruct-q4_0
ANTHROPIC_API_KEY=
GMAIL_EMAIL=your-job-alerts@gmail.com
GMAIL_APP_PASSWORD=your-app-password
```

### Candidate profile

Upload a resume (PDF) through the UI's Candidate Profile to auto-generate the profile document, or copy the example:

```bash
cp packages/scraper/profile/candidate.example.json packages/scraper/profile/candidate.json
```

Place your resume PDF in `packages/scraper/data/resume/`.

### Seed baseline rules + demographics

```bash
npm run eval:seed-rules          # canonical salary / experience / remote rules
npm run eval:seed-demographics   # UserModel.demographics + paraphrase-friendly rules
```

### Rebuild shared (only after editing `packages/shared/`)

```bash
npx tsc --project packages/shared/tsconfig.json
```

### Run

```bash
npm run api                     # NestJS API on port 3001
npm run ui                      # Vite UI on port 5173

# Individual phases from CLI:
npm run scraper                 # Scrape + score (Ashby + Greenhouse + LinkedIn + Lever)
npm run scraper:gmail-alerts    # Today's Gmail LinkedIn alerts
npm run scraper:phase3          # Cover letters for to_apply jobs
npm run scraper:phase4          # Auto-apply (honors the UI's Auto-submit toggle)
```

### Gmail alerts

1. Forward LinkedIn job alerts to your Gmail (or let LinkedIn deliver to it directly)
2. Set `GMAIL_EMAIL` and `GMAIL_APP_PASSWORD` (Gmail App Password, not account password)
3. Run Gmail Alerts from the Pipeline UI or `npm run scraper:gmail-alerts`

The scraper reads **today's emails only** (since local midnight) to avoid re-processing yesterday's alerts on every run.

### Tests

```bash
npm test          # 132 unit tests across scraper fixtures — no LLM calls
```

Eval harnesses (`eval:*`) hit the live LLM and are NOT part of `npm test` — run them on demand.

## Database collections

| Collection          | Purpose                                                                 |
| ------------------- | ----------------------------------------------------------------------- |
| `jobs`              | All scraped jobs with scores, status, metadata, applied_at              |
| `coverletters`      | Generated cover letters keyed by externalJobId                          |
| `users`             | Candidate profile — one document. Includes `demographics` and `settings` |
| `profileanswers`    | Reusable form answer rules (question_pattern → answer)                  |
| `questionanswers`   | Per-job Q&A logs from auto-apply runs                                   |
| `applicationfields` | Pre-scraped form fields with answers per job                            |
