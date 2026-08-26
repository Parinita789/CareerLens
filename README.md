# JobPilot

A local AI job-search pipeline I built and use to manage my own search. Scrapes 200+ listings/day across LinkedIn, Greenhouse, Lever, Indeed, Ashby, and Gmail-IMAP alerts. A two-layer deterministic prefilter eliminates most jobs before any LLM call; survivors get scored 1–10 with matched/missing skills, cover letters, and pre-scraped application forms. Optional auto-apply for LinkedIn Easy Apply and Greenhouse/Ashby — gated behind a dry-run safety toggle by default.

Everything runs locally via `npm run api` + `npm run ui`. Single monorepo, no cloud services beyond MongoDB.

---

## Engineering highlights

### "LLM is last option" answer resolution

Every form question flows through a layered resolver. The LLM only fires when everything deterministic misses.

| Priority | Source                  | Notes |
| -------- | ----------------------- | ----- |
| 1        | **Pre-scraped answers** | Reviewed in Prepare tab, stored in `applicationFields` |
| 2        | **Saved rules**         | `ProfileAnswer` collection — user corrections + demographic rules + seed defaults |
| 3        | **Profile defaults**    | Identity / demographics from `UserModel` (name, phone, gender, pronouns, etc.) |
| 4        | **LLM fallback**        | Receives demographics + ALL saved rules as context, so paraphrases still resolve correctly |

The LLM prompt for questions always includes a **Candidate demographics** block and a **Saved answers** list — even when a paraphrase misses the rule regex, the LLM sees ground truth and can't fabricate.

### Pre-scrape → Review → Apply

Core workflow: every answer reviewed BEFORE the bot fills the form.

1. During scraping, jobs scoring 7+ get their Greenhouse/Ashby forms pre-scraped (parallel, 3 at a time)
2. Every input, dropdown, radio, checkbox, textarea captured with labels, types, options
3. Auto-answered from pre-scraped data → saved rules → profile → LLM
4. Shown in **Prepare tab** — expandable table, options as chips, required fields marked red
5. Edit any answer inline — edits saved as rules, applied to all future forms
6. One-click Auto Apply fills the form instantly, no LLM regeneration

Status indicators: **Ready** (all required answered) / **Needs Review** (required unknowns). Batch-apply button for all Ready jobs at once. Cover-letter preview in the expanded view. Phone-code pickers and phone radio groups auto-filtered as form garbage.

### Global dry-run safety toggle

A **master switch in the dashboard header** controls whether the bot is allowed to click "Submit Application" during auto-apply.

- **OFF (default, dry-run)** — fills every form field, runs every auto-fill routine, then STOPS before the Submit click. Prints the final form snapshot to the console.
- **ON (live)** — bot clicks Submit on Greenhouse/Ashby and on LinkedIn Easy Apply's review step.

Persisted in `UserModel.settings.allowAutoSubmit` via `GET`/`PUT /api/settings`. The pipeline service re-reads on every apply spawn — flipping the switch takes effect without restart.

### Eval harnesses

Four regression harnesses + 132 unit tests. The harnesses call real LLM paths with frozen fixtures and grade the output. Run on demand, not from `npm test`.

| Command                        | Target                               | Fixture |
| ------------------------------ | ------------------------------------ | ------- |
| `npm run eval:answers`         | `answerQuestion` (form Q&A)          | 45 cases |
| `npm run eval:cover-letters`   | `generateCoverLetter`                | 4 cases (programmatic + LLM-as-judge on 5 dimensions) |
| `npm run eval:form-pre-answer` | `preAnswerFields` (bulk form filler) | 15 field assertions — grades value AND source |
| `npm run eval:scorer`          | `scoreFitWithLLM`                    | 5 cases — drops fabricated `matched_skills` not in JD |
| `npm run eval:all`             | all four in sequence                 | ~3.5 min total; exits non-zero on any failure |

**Programmatic graders** — predicates in `_lib.ts`: `equals`, `includes`, `oneOf`, `notIncludes`, `regex`, `minLength`, `maxLength`, plus numeric-range and array-inclusion helpers for the scorer harness.

**LLM-as-judge for cover letters** — 5 dimensions scored 1–5: `specificity`, `metric_grounding`, `structure`, `tone`, `no_fabrication`. Overall score = **MIN** of the dimensions, so a single weak axis fails the case. Judge is calibrated to allow the salutation and humble close required by the prompt template — catches over-formulaic openings without false-positiving on the prescribed format.

**Anti-fabrication validators**:

- **Scorer** — post-parse filter drops any `matched_skill` whose lowercased text isn't a substring of `title + description`. Fabricated skills are logged to a per-run audit so you can see how often the LLM invents them.
- **Rule-vs-LLM audit log** — auto-apply counts how many form questions resolved via deterministic rule vs LLM fallback, per run. Tracks drift back toward the LLM as the rule corpus grows or new ATS forms surface unfamiliar question phrasings.
- **Saved-answers context cap** — Q&A prompts include up to 30 saved answers, ranked by token overlap with the current question. Prevents prompt bloat AND prevents the LLM from latching onto an unrelated saved answer for similar-sounding questions (which used to happen with the unbounded list).

**Seeding** — one-time setup:

```bash
npm run eval:seed-rules          # canonical salary / experience / remote rules
npm run eval:seed-demographics   # UserModel.demographics + paraphrase-friendly rules
```

### Model selection (and what we tried)

Originally split traffic between two providers by cost profile:

- **Local Ollama (`llama3:8b-instruct`)** for high-volume, low-reasoning tasks — form Q&A, prefilter scoring, demographic resolution. Goal: keep daily LLM cost near zero on the workload that ran constantly.
- **Claude** for low-volume, high-reasoning tasks — cover-letter generation, scorer JSON output, LLM-as-judge.

The eval harnesses showed Ollama quality wasn't acceptable on the cheap-model side. Failure modes that cost more in rework than they saved in LLM bills:

- Demographic paraphrases ("What is your ethnicity?" vs "How do you self-identify?") often didn't hit the saved rule and the model invented answers
- Dropdown option matching (Smart Option Matching's fallback path) returned the wrong option ~15% of the time
- Cover-letter judge dimensions (when used to grade Ollama outputs as a sanity check) consistently flagged `specificity` and `no_fabrication` failures

Consolidated on `claude-sonnet-4-6` everywhere — the unified `llmChat()` call routes through Claude CLI by default, with a one-line switch to the Anthropic SDK via `LLM_PROVIDER=anthropic`. The provider abstraction is intentionally still in place: the moment a small/cheap model (Haiku, a future local model) scores acceptably on the same eval harnesses, it can be re-introduced behind a per-call `model` argument without touching any consumer.

### Smart Option Matching

Deterministic matching of short rule-answers onto long-form dropdown options — handled by `smartMatchOption` so dropdowns don't need an LLM call.

| Rule answer       | Dropdown options                                           | Match method |
| ----------------- | ---------------------------------------------------------- | ------------ |
| `"United States"` | `"US"`, `"USA"`, `"United States of America"`              | Country aliases |
| `"Yes"` / `"No"`  | `"Yes, I am authorized..."`, `"No, I will not require..."` | Starts-with + positive/negative phrasing |
| `"Female"`        | `"Female"`, `"Woman"`, `"Female (she/her)"`                | Gender aliases |
| `"Asian"`         | `"South Asian (inclusive of...)"`, `"Asian"`               | Prefers South Asian, falls back to Asian |
| `"Heterosexual"`  | `"Straight"`, `"Cisgender"`                                | Sexual orientation aliases |
| `"No"` (veteran)  | `"I am not a protected veteran"`                           | Label-aware negative matching |

---

## Contents

1. [Engineering highlights](#engineering-highlights) (above)
2. [Architecture](#architecture)
3. [Pipeline](#pipeline)
4. [Auto Apply internals](#auto-apply-internals)
5. [Dashboard](#dashboard)
6. [Design decisions](#design-decisions)
7. [Tech stack](#tech-stack)
8. [Database collections](#database-collections)
9. [Local development](#local-development)

---

## Architecture

```
packages/
├── shared/    Mongoose schemas, DB connection, unified LLM client, cover-letter generator
├── scraper/   Scraping, scoring, cover letters, form pre-scraping, auto-apply, eval harnesses
├── api/       NestJS REST API (jobs, profile, pipeline, settings, form-answers, alerts)
└── ui/        React + Vite dashboard
```

## Pipeline

Selectable from the dashboard's Pipeline modal, or runnable individually via npm scripts.

| Phase              | What it does |
| ------------------ | ------------ |
| **Scrape & Score** | Scrapes Ashby, Greenhouse, LinkedIn (8 queries + alerts), Lever. Two-layer filter + LLM scoring per company/query. Jobs scoring 7+ get their forms pre-scraped automatically. |
| **Gmail Alerts**   | Polls Gmail IMAP for today's LinkedIn alert emails. Parses job URLs, scrapes each posting, scores per alert keyword. |
| **Cover Letters**  | LLM-generated 3-paragraph cover letters for `to_apply` jobs. Runs in-process from the API; no subprocess spawn. |
| **Auto Apply**     | Opens Greenhouse / Ashby / LinkedIn Easy Apply, fills every field from pre-scraped answers + rules + profile (zero LLM calls during fill). Submit click gated on a global UI toggle. |

---

## Auto Apply internals

### Greenhouse / Ashby

1. Loads pre-scraped answers from `applicationFields`
2. Resolves URL — converts company career-page URLs to `job-boards.greenhouse.io`, handles iframes
3. Clicks "Autofill with MyGreenhouse" if available
4. Uploads resume + cover letter (cover letter loaded from DB, no LLM regen)
5. Fills every field via `input.fill()` (pre-scraped answers + rules + profile)
6. Dropdowns scoped via `aria-controls` — prevents the phone country picker from hijacking selection
7. Two-pass combobox scan with scrolling to catch lazy-loaded fields
8. Fill-by-ID fallback finds any missed combobox directly
9. Checkbox groups — "select all that apply" handled
10. **Submit (guarded)** — clicks Submit only if the global Auto-submit toggle is ON; otherwise logs "Submit disabled — review mode" and exits
11. **Success detection** — submit button gone + "thank you" text → marks job `applied`, removes from Prepare
12. **Zero LLM calls during auto-apply** — all answers deterministic

### LinkedIn Easy Apply

Separate flow (`applyViaEasyApply`) — walks the multi-step modal, uploads resume, handles the review step. Final Submit click gated on the same global toggle.

### LinkedIn → external ATS routing

LinkedIn `/jobs/view/...` URLs are postings, not forms. The `probeLinkedInApplyTarget` helper clicks Apply, captures the popup, settles redirect chains, and returns either `easy_apply` or the underlying ATS URL (Greenhouse / Ashby) for pre-scraping.

---

## Dashboard

- **Tabs** — Queue, Prepare, Applied, Interviewing, Accepted, Declined, Rejected, Cover Letters
- **Filters** — Search (company/title), Platform, Score (5-9), "New only" (last 24h)
- **Sort** — by posted date, scrape date, or fit score; default = "new in last 24h first, then by score"
- **Scraped date column** on every tab — relative time (`3d ago`, `2w ago`), hover for full timestamp
- **Select to Auto Apply** — checkboxes on Queue → Auto Apply / Generate Cover Letters
- **Status dropdowns**:
  - Applied tab → Waiting / Interviewing / Accepted / Declined / No Response
  - **Interviewing tab** → Round dropdown (Recruiter, Hiring Manager, Coding, System Design, Behavioral, Onsite, Offer, Other) + Outcome status
  - **Accepted tab** → Outcome dropdown (Pending / Offer Received / Offer Accepted / Offer Declined / Withdrew / Position Closed / Ghosted)
- **+ Add Job / + Add Interview** — manual entry directly into Applied / Interviewing / Accepted
- **Header** — Auto-submit pill (ON green / OFF red), hamburger menu
- **Hamburger** — Candidate Profile, Saved Rules, Keywords, Pipeline
- **Floating pipeline bar** — live logs + Stop button while anything runs

---

## Design decisions

### Demographics in DB, not hardcoded

`UserModel.demographics` holds race, pronouns, disability, veteran, citizenship, etc. Injected into every LLM prompt so paraphrased questions ("What is your ethnicity?") resolve correctly without per-paraphrase keyword rules.

### Dropdown menu scoping via `aria-controls`

Greenhouse forms always have a phone country code picker in the DOM. A generic `querySelectorAll('[role="option"]')` returned 246 phone-code options. Each React Select has `aria-controls="react-select-{id}-listbox"` — option reading is now scoped to that specific menu.

### Separate LinkedIn sessions

`linkedin-session.json` for scraping (test account), `linkedin-session-apply.json` for applying (real account). Prevents bulk-scrape rate limiting from burning the account used to submit.

### Cover letter generation lives in `@job-agent/shared`

Used to spawn `npx tsx generate-one-cover-letter.ts` per call (~5s overhead). Now imported
in-process by the API. Two sequential LLM calls per letter: a draft (voice exemplars from
`packages/shared/voice/samples/` + a seeded structural variant, replacing the old fixed
3-paragraph template) followed by a humanize pass that rewrites it against explicit
anti-AI-tell rules.

### Required-field detection

`*` in label → required. Plus a known-pattern fallback: name, email, phone, resume, sponsorship, visa, authorization, country, gender. "Needs Review" only triggers when a required field is unanswered — optional unknowns don't block batch apply.

### 10-day freshness filter

Jobs older than 10 days (by source-provided `posted_at`) are dropped before scoring. Stale roles are usually filled; LLM budget would be wasted.

### Anti-detection

- Full-screen Chrome with realistic fingerprint (plugins, hardware, geolocation, screen)
- `navigator.webdriver` set to `undefined`
- Cookie persistence between runs
- LinkedIn login uses 5-minute manual-login polling, waits for the `li_at` auth cookie rather than URL patterns (catches SSO / checkpoint / email-verification flows correctly)

---

## Tech stack

- **Language** — TypeScript across the monorepo (npm workspaces)
- **Scraping** — Playwright (Chrome). Non-headless for interactive LinkedIn login + apply; headless for API-board scrapes and Gmail URL scrapes
- **LLM** — Claude CLI (default) or Anthropic SDK, switchable via `LLM_PROVIDER` env. All consumers call `llmChat()` from `@job-agent/shared` — scoring, cover letters, form Q&A, resume parsing all switch together
- **Backend** — NestJS on Node.js
- **Frontend** — React 18, Vite
- **Database** — MongoDB (Mongoose)
- **Email** — Gmail IMAP (`imapflow`, `mailparser`)

| Provider     | How                                                     | Notes |
| ------------ | ------------------------------------------------------- | ----- |
| `claude-cli` | Spawns `claude -p --model claude-sonnet-4-6` subprocess | Uses your Claude CLI subscription. Subprocess startup adds ~2-5s per call |
| `anthropic`  | Direct Anthropic SDK with `claude-sonnet-4-6`           | Fastest per-call (~5–10s). Requires `ANTHROPIC_API_KEY` |

---

## Database collections

| Collection          | Purpose |
| ------------------- | ------- |
| `jobs`              | All scraped jobs with scores, status, applied_at, interview_round, accepted_outcome |
| `coverletters`      | Generated cover letters keyed by externalJobId |
| `users`             | Candidate profile — one document. Includes `demographics` and `settings` |
| `profileanswers`    | Reusable form answer rules (question_pattern → answer) |
| `questionanswers`   | Per-job Q&A logs from auto-apply runs |
| `applicationfields` | Pre-scraped form fields with answers per job |

---

## Local development

### Prerequisites

- Node.js, npm
- MongoDB (local or Docker — `mongodb://localhost:27017/job-tracker`)
- Either Claude Code CLI (default) or an Anthropic API key

### Install + env

```bash
npm install
```

Create `.env` at the repo root:

```
MONGO_URI=mongodb://localhost:27017/job-tracker
API_PORT=3002
LLM_PROVIDER=claude-cli
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
npm run eval:seed-rules
npm run eval:seed-demographics
```

### Run

```bash
npm run api                     # NestJS API on port 3002
npm run ui                      # Vite UI on port 5173

# Individual phases from CLI:
npm run scraper                 # Scrape + score
npm run scraper:gmail-alerts    # Gmail LinkedIn alerts
npm run scraper:auto-apply      # Auto-apply (honors the UI's Auto-submit toggle)
```

After editing anything in `packages/shared/`, rebuild it so the API + scraper pick up the change (Mongoose schemas in particular load from `dist/` at boot):

```bash
npm run build -w packages/shared
```

### Gmail alerts

1. Forward LinkedIn job alerts to your Gmail (or let LinkedIn deliver them directly)
2. Set `GMAIL_EMAIL` + `GMAIL_APP_PASSWORD` (Gmail App Password, not the account password)
3. Run from the Pipeline UI or `npm run scraper:gmail-alerts`

The scraper reads **today's emails only** (since local midnight) to avoid re-processing yesterday's alerts on every run.

### Tests

```bash
npm test          # 132 unit tests across scraper fixtures — no LLM calls
```

Eval harnesses (`eval:*`) hit the live LLM and are NOT part of `npm test` — run them on demand.
