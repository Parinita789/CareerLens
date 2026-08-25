import 'reflect-metadata';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { AsyncLocalStorage } from 'node:async_hooks';
import { format } from 'node:util';
import { NestFactory } from '@nestjs/core';
import { connectToDatabase, disconnectDatabase } from './persistence/db';
import { TARGET_COMPANIES } from './common/company-directory';
import { Limiter } from './common/limiter';
import { AppModule } from './app.module';
import { DealBreakerService } from './scoring/deal-breakers.service';
import { LlmScorerService } from './scoring/llm-scorer.service';
import { QuickRejectService } from './scoring/quick-reject.service';
import { ScraperPersistenceService } from './persistence/persistence.service';
import { LinkedInService } from './sourcing/linkedin.service';
import { LinkedInAlertsService } from './sourcing/linkedin-alerts.service';
import { GreenhouseService } from './sourcing/greenhouse.service';
import { LeverService } from './sourcing/lever.service';
import { IndeedService } from './sourcing/indeed.service';
import { AshbyService } from './sourcing/ashby.service';
import { FormScraperService } from './sourcing/form-scraper.service';
import type { JobListing, ScoredJob } from './types';

interface Services {
  dealBreakers: DealBreakerService;
  quickReject: QuickRejectService;
  scorer: LlmScorerService;
  persistence: ScraperPersistenceService;
  linkedIn: LinkedInService;
  linkedInAlerts: LinkedInAlertsService;
  greenhouse: GreenhouseService;
  lever: LeverService;
  indeed: IndeedService;
  ashby: AshbyService;
  formScraper: FormScraperService;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const LLM_CONCURRENCY = 3;
const MAX_JOB_AGE_DAYS = 14;

// ── Cross-source concurrency ──────────────────────────────────────
// Sources run in parallel (see main), which would otherwise multiply every
// per-source limit by the number of sources. These caps are global, so total
// load on the LLM and on memory stays exactly where it was when sources ran
// one at a time.

// Total in-flight LLM scoring calls across every source. Without this, four
// parallel sources would each run LLM_CONCURRENCY calls at once.
const llmLimiter = new Limiter(LLM_CONCURRENCY);

// Form pre-scraping launches its own Chrome (3 pages). Capped at 1 so parallel
// sources can't stack several browsers on top of LinkedIn's — that was the
// memory pressure the gmail-alerts scraper already had to dial back for.
const formScrapeLimiter = new Limiter(1);

// Sources interleave their output once they run concurrently, so every line is
// tagged with the source that produced it. AsyncLocalStorage carries the tag
// through awaits into the service layer, so logs written deep inside a scraper
// are attributed correctly without threading a parameter through everything.
const sourceTag = new AsyncLocalStorage<string>();
function installSourceTaggedLogging(): void {
  const base = { log: console.log.bind(console), error: console.error.bind(console) };
  const wrap =
    (emit: (line: string) => void) =>
    (...args: unknown[]) => {
      const tag = sourceTag.getStore();
      const text = format(...args);
      if (!tag) return emit(text);
      // Tag per line so multi-line output stays attributable.
      for (const line of text.split('\n')) emit(line.length > 0 ? `[${tag}] ${line}` : '');
    };
  console.log = wrap(base.log);
  console.error = wrap(base.error);
}

// Skip postings older than MAX_JOB_AGE_DAYS. Jobs with no posted_at pass through —
function isFresh(postedAt?: string): boolean {
  if (!postedAt) return true;
  const t = Date.parse(postedAt);
  if (Number.isNaN(t)) return true;
  return Date.now() - t <= MAX_JOB_AGE_DAYS * 24 * 60 * 60 * 1000;
}

type SourceStats = {
  scraped: number; // raw count from scraper (pre-dedup, pre-freshness)
  considered: number; // post-dedup + freshness — "new this run"
  staleDropped: number; // dropped by 10-day freshness filter
  fastRejected: number; // dropped by quickReject or deal-breaker
  llmScored: number; // went to LLM
  toApply: number; // LLM gave fit_score >= 5
  scoreSum: number;
  scoreCount: number;
  samples: ScoredJob[]; // every job that was scored (LLM or fast-rejected) — source of best/worst-ok/rejected examples
};

function emptySourceStats(): SourceStats {
  return {
    scraped: 0,
    considered: 0,
    staleDropped: 0,
    fastRejected: 0,
    llmScored: 0,
    toApply: 0,
    scoreSum: 0,
    scoreCount: 0,
    samples: [],
  };
}

const INDEED_QUERIES = [
  { keywords: 'Senior Backend Engineer Node.js', location: 'United States' },
  { keywords: 'Software Engineer TypeScript Backend', location: 'United States' },
];

const INDEED_JOBS_PER_QUERY = 25;

const LINKEDIN_QUERIES = [
  // Core — these produce the most unique, relevant results
  { keywords: 'Senior Backend Engineer', location: 'United States' },
  { keywords: 'Senior Software Engineer Node.js', location: 'United States' },
  { keywords: 'Backend Engineer Team Lead', location: 'United States' },
  { keywords: 'Software Engineer TypeScript', location: 'United States' },
  // Platform / Product
  { keywords: 'Software Engineer Platform Backend', location: 'United States' },
  { keywords: 'Software Development Engineer', location: 'United States' },
  // Remote
  { keywords: 'Senior Backend Engineer', location: 'Remote' },
  // Systems
  { keywords: 'Software Engineer distributed systems', location: 'United States' },
];

const LINKEDIN_JOBS_PER_QUERY = 25;

// DB-backed load/save
async function loadJobs(persistence: ScraperPersistenceService): Promise<ScoredJob[]> {
  return persistence.loadExistingJobs();
}

async function persistJobs(jobs: ScoredJob[], persistence: ScraperPersistenceService): Promise<void> {
  await persistence.saveJobs(jobs);
}

// ── Score a batch of jobs concurrently ──────────────────────────────
async function scoreBatch(batch: JobListing[], scorer: LlmScorerService): Promise<ScoredJob[]> {
  const promises = batch.map(async (job) => {
    try {
      // Through the global limiter — a batch may be one of several submitted by
      // different sources at the same moment.
      const score = await llmLimiter.run(() => scorer.scoreFitWithLLM(job));
      return {
        ...job,
        ...score,
        status: score.fit_score >= 5 ? 'to_apply' : 'rejected',
      } as ScoredJob;
    } catch (err) {
      console.error(`  LLM failed for ${job.title}: ${(err as Error).message}`);
      return {
        ...job,
        fit_score: 0,
        apply: false,
        matched_skills: [],
        missing_skills: [],
        reason: 'LLM scoring failed',
        status: 'rejected',
      } as ScoredJob;
    }
  });

  return Promise.all(promises);
}

type Source = 'linkedin' | 'greenhouse' | 'lever' | 'indeed' | 'ashby';
const ALL_SOURCES: Source[] = ['ashby', 'greenhouse', 'linkedin', 'lever'];

// Dedup, filter, and score a batch of raw jobs. Writes per-source counters and
// scored-job samples into `stats` so main() can print a quality breakdown at the end.
async function dedupFilterScore(
  rawJobs: JobListing[],
  sourceName: string,
  seenIds: Set<string>,
  seenKeys: Set<string>,
  seenUrls: Set<string>,
  existingIds: Set<string>,
  stats: Record<string, SourceStats>,
  services: Services,
): Promise<{ total: number; deduped: number; filtered: number; scored: number }> {
  // Source is derived from the raw jobs themselves — all jobs in a single call
  // come from one scraper. Fall back to 'unknown' only when rawJobs is empty
  // (defensive — the caller already checks).
  const source = rawJobs[0]?.source ?? 'unknown';
  const bucket = (stats[source] ??= emptySourceStats());
  bucket.scraped += rawJobs.length;

  // Dedup
  let unique = rawJobs.filter((job) => {
    const key = `${job.company}|||${job.title}`.toLowerCase();
    if (seenIds.has(job.id) || existingIds.has(job.id)) return false;
    if (seenKeys.has(key)) return false;
    if (job.url && seenUrls.has(job.url)) return false;
    seenIds.add(job.id);
    seenKeys.add(key);
    if (job.url) seenUrls.add(job.url);
    return true;
  });

  console.log(`  Dedup: ${rawJobs.length} → ${unique.length} new`);

  if (unique.length === 0) return { total: rawJobs.length, deduped: 0, filtered: 0, scored: 0 };

  // Drop postings older than MAX_JOB_AGE_DAYS (10 days). Stale roles are usually
  // already filled; we'd waste LLM budget scoring them.
  const beforeStale = unique.length;
  unique = unique.filter((job) => isFresh(job.posted_at));
  const droppedStale = beforeStale - unique.length;
  bucket.staleDropped += droppedStale;
  if (droppedStale > 0) console.log(`  Stale: dropped ${droppedStale} (>${MAX_JOB_AGE_DAYS}d old)`);

  bucket.considered += unique.length;

  if (unique.length === 0)
    return { total: rawJobs.length, deduped: beforeStale, filtered: droppedStale, scored: 0 };

  // Fast filter
  const rejected: ScoredJob[] = [];
  const needsLLM: JobListing[] = [];

  for (const job of unique) {
    const dealBreaker = services.dealBreakers.checkDealBreakers(job);
    if (dealBreaker.rejected) {
      rejected.push({
        ...job,
        fit_score: 0,
        apply: false,
        matched_skills: [],
        missing_skills: [],
        reason: dealBreaker.reason!,
        deal_breaker: dealBreaker.reason,
        status: 'rejected',
      });
      continue;
    }
    const qr = services.quickReject.quickReject(job);
    if (qr) {
      rejected.push({
        ...job,
        fit_score: 0,
        apply: false,
        matched_skills: [],
        missing_skills: [],
        reason: qr,
        status: 'rejected',
      });
      continue;
    }
    needsLLM.push(job);
  }

  bucket.fastRejected += rejected.length;
  bucket.samples.push(...rejected);

  if (rejected.length > 0) await persistJobs(rejected, services.persistence);
  console.log(`  Filter: ${rejected.length} rejected, ${needsLLM.length} need LLM`);

  // LLM scoring in batches
  const highScoreJobs: ScoredJob[] = [];
  if (needsLLM.length > 0) {
    const totalBatches = Math.ceil(needsLLM.length / LLM_CONCURRENCY);
    for (let i = 0; i < needsLLM.length; i += LLM_CONCURRENCY) {
      const batch = needsLLM.slice(i, i + LLM_CONCURRENCY);
      const batchNum = Math.floor(i / LLM_CONCURRENCY) + 1;

      console.log(`  [${sourceName} ${batchNum}/${totalBatches}] Scoring ${batch.length}...`);
      const scored = await scoreBatch(batch, services.scorer);

      for (const s of scored) {
        console.log(
          `    ${s.fit_score}/10 ${s.fit_score >= 5 ? '✓' : '✗'} ${s.title} @ ${s.company}`,
        );
        if (s.fit_score >= 7) highScoreJobs.push(s);
        bucket.llmScored += 1;
        bucket.scoreSum += s.fit_score;
        bucket.scoreCount += 1;
        if (s.fit_score >= 5) bucket.toApply += 1;
        bucket.samples.push(s);
      }
      await persistJobs(scored, services.persistence);
    }
  }

  // Pre-scrape application forms for 7+ scored jobs
  if (highScoreJobs.length > 0) {
    try {
      console.log(`\n  Pre-scraping forms for ${highScoreJobs.length} high-score jobs...`);
      await formScrapeLimiter.run(() =>
        services.formScraper.scrapeApplicationForms(highScoreJobs),
      );
    } catch (err) {
      console.error(`  Form pre-scrape failed: ${(err as Error).message}`);
    }
  }

  return {
    total: rawJobs.length,
    deduped: unique.length,
    filtered: rejected.length,
    scored: needsLLM.length,
  };
}

// ── Per-source runners ────────────────────────────────────────────
// Each drives one platform end to end. Kept internally sequential (one company
// or query at a time, with the scrapers' own politeness delays intact) so that
// running them concurrently adds no extra load to any single platform.
interface SourceContext {
  services: Services;
  seenIds: Set<string>;
  seenKeys: Set<string>;
  seenUrls: Set<string>;
  existingIds: Set<string>;
  stats: Record<string, SourceStats>;
}

// dedupFilterScore's dedup pass is synchronous, so concurrent sources cannot
// interleave between its check and its add — the shared Sets stay correct.
function scoreInto(ctx: SourceContext, jobs: JobListing[], label: string) {
  return dedupFilterScore(
    jobs,
    label,
    ctx.seenIds,
    ctx.seenKeys,
    ctx.seenUrls,
    ctx.existingIds,
    ctx.stats,
    ctx.services,
  );
}

async function runAshby(ctx: SourceContext): Promise<void> {
  const companies = TARGET_COMPANIES.filter((c) => c.ats === 'ashby');
  console.log(`Ashby — scraping ${companies.length} companies`);
  for (const company of companies) {
    const jobs = await ctx.services.ashby.scrapeAshby(company.slug, company.name);
    if (jobs.length > 0) await scoreInto(ctx, jobs, company.name);
  }
}

async function runGreenhouse(ctx: SourceContext): Promise<void> {
  const companies = TARGET_COMPANIES.filter((c) => c.ats === 'greenhouse');
  console.log(`Greenhouse — scraping ${companies.length} companies`);
  for (const company of companies) {
    const jobs = await ctx.services.greenhouse.scrapeGreenhouse(company.slug, company.name);
    if (jobs.length > 0) await scoreInto(ctx, jobs, company.name);
  }
}

async function runLever(ctx: SourceContext): Promise<void> {
  const companies = TARGET_COMPANIES.filter((c) => c.ats === 'lever');
  console.log(`Lever — scraping ${companies.length} companies`);
  for (const company of companies) {
    const jobs = await ctx.services.lever.scrapeLever(company.slug, company.name);
    if (jobs.length > 0) await scoreInto(ctx, jobs, company.name);
  }
}

async function runLinkedIn(ctx: SourceContext): Promise<void> {
  for (const query of LINKEDIN_QUERIES) {
    console.log(`Searching: "${query.keywords}" in ${query.location}`);
    try {
      const jobs = await ctx.services.linkedIn.scrapeLinkedIn(
        query.keywords,
        query.location,
        LINKEDIN_JOBS_PER_QUERY,
      );
      console.log(`  Got ${jobs.length} jobs`);
      if (jobs.length > 0) await scoreInto(ctx, jobs, `LinkedIn "${query.keywords}"`);
    } catch (err) {
      console.error(`  Failed: ${(err as Error).message}`);
    }
  }

  // Gmail alerts — scrape + score per alert for real-time results
  try {
    console.log('LinkedIn Job Alerts:');
    const alertsFile = path.join(__dirname, '../data/alerts.json');
    let alerts: { label: string; keywords: string; location: string }[] = [];
    try {
      const fs = await import('fs');
      if (fs.existsSync(alertsFile)) {
        alerts = JSON.parse(fs.readFileSync(alertsFile, 'utf-8'));
      }
    } catch {
      /* no alerts */
    }

    if (alerts.length > 0) {
      for (const alert of alerts) {
        console.log(`  Alert: "${alert.label}"`);
        try {
          const jobs = await ctx.services.linkedIn.scrapeLinkedIn(
            alert.keywords,
            alert.location,
            50,
          );
          console.log(`  Got ${jobs.length} jobs`);
          if (jobs.length > 0) await scoreInto(ctx, jobs, `Alert "${alert.label}"`);
        } catch (err) {
          console.error(`  Alert "${alert.label}" failed: ${(err as Error).message}`);
        }
      }
    } else {
      // Fallback to the combined function if no alerts.json
      const alertJobs = await ctx.services.linkedInAlerts.scrapeLinkedInAlerts(50);
      console.log(`  Got ${alertJobs.length} jobs from alerts`);
      if (alertJobs.length > 0) await scoreInto(ctx, alertJobs, 'LinkedIn Alerts');
    }
  } catch (err) {
    console.error(`  Alerts failed: ${(err as Error).message}`);
  }
}

async function runIndeed(ctx: SourceContext): Promise<void> {
  const indeedSeen = new Set<string>();
  for (const query of INDEED_QUERIES) {
    console.log(`Searching: "${query.keywords}" in ${query.location}`);
    try {
      const jobs = await ctx.services.indeed.scrapeIndeed(
        query.keywords,
        query.location,
        INDEED_JOBS_PER_QUERY,
      );
      const newJobs = jobs.filter((j) => {
        if (indeedSeen.has(j.id)) return false;
        indeedSeen.add(j.id);
        return true;
      });
      console.log(`  Got ${jobs.length} jobs (${jobs.length - newJobs.length} cross-query dupes)`);
      if (newJobs.length > 0) await scoreInto(ctx, newJobs, `Indeed "${query.keywords}"`);
    } catch (err) {
      console.error(`  Failed: ${(err as Error).message}`);
    }
  }
}

const SOURCE_RUNNERS: Record<Source, (ctx: SourceContext) => Promise<void>> = {
  ashby: runAshby,
  greenhouse: runGreenhouse,
  linkedin: runLinkedIn,
  lever: runLever,
  indeed: runIndeed,
};


async function main() {
  installSourceTaggedLogging();

  const sourcesArg = process.argv.find((a) => a.startsWith('--sources='));
  const sources: Source[] = sourcesArg
    ? (sourcesArg.split('=')[1].split(',') as Source[])
    : ALL_SOURCES;

  console.log('Phase 2 — Multi-Source Job Scraper (per-source scoring)');
  console.log(`Sources: ${sources.join(', ')}`);
  console.log('=====================================\n');

  await connectToDatabase();
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const services: Services = {
    dealBreakers: app.get(DealBreakerService),
    quickReject: app.get(QuickRejectService),
    scorer: app.get(LlmScorerService),
    persistence: app.get(ScraperPersistenceService),
    linkedIn: app.get(LinkedInService),
    linkedInAlerts: app.get(LinkedInAlertsService),
    greenhouse: app.get(GreenhouseService),
    lever: app.get(LeverService),
    indeed: app.get(IndeedService),
    ashby: app.get(AshbyService),
    formScraper: app.get(FormScraperService),
  };

  const existingJobs = await loadJobs(services.persistence);
  const existingIds = new Set(existingJobs.map((j) => j.id));
  console.log(`Existing jobs in tracker: ${existingJobs.length}\n`);

  // Shared dedup sets — accumulate across sources
  const seenIds = new Set<string>();
  const seenKeys = new Set(existingJobs.map((j) => `${j.company}|||${j.title}`.toLowerCase()));
  const seenUrls = new Set(existingJobs.map((j) => j.url).filter(Boolean));

  const stats: Record<string, SourceStats> = {};

  // Ensure every enabled source appears in the summary even if it scraped nothing —
  // a "scraped=0" row for LinkedIn is the whole point (catches silent login failures).
  for (const s of sources) stats[s] = emptySourceStats();

  // ── Run every enabled source concurrently ────────────────────────
  // Platforms are independent — separate hosts, separate rate limits — so there
  // is no reason for Greenhouse to sit idle while LinkedIn drives a browser for
  // ten minutes. Each source stays internally sequential, so no single platform
  // sees more traffic than before; total wall time becomes roughly the slowest
  // source rather than the sum of all of them.
  const ctx: SourceContext = { services, seenIds, seenKeys, seenUrls, existingIds, stats };

  // Unknown names used to be skipped silently by an `enabled.has()` check; with
  // a runner lookup they'd throw instead, so filter and say what was ignored.
  const unknown = sources.filter((s) => !SOURCE_RUNNERS[s]);
  if (unknown.length > 0) {
    console.log(`Ignoring unknown source(s): ${unknown.join(', ')}`);
  }
  const active = sources.filter((s) => SOURCE_RUNNERS[s]);
  if (active.length === 0) {
    console.log('No known sources selected — nothing to scrape.\n');
  } else {
    console.log(`Running ${active.length} source(s) in parallel: ${active.join(', ')}\n`);
  }

  const startedAt = Date.now();
  const results = await Promise.allSettled(
    active.map((source) =>
      // sourceTag.run tags every line this source logs, including from inside
      // the service layer, so interleaved output stays readable.
      sourceTag.run(source, async () => {
        const t0 = Date.now();
        await SOURCE_RUNNERS[source](ctx);
        console.log(`done in ${Math.round((Date.now() - t0) / 1000)}s`);
      }),
    ),
  );

  // allSettled, not all: one source failing must not abandon the others' work.
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      console.error(`Source "${active[i]}" failed: ${(r.reason as Error)?.message ?? r.reason}`);
    }
  });
  console.log(`\nAll sources finished in ${Math.round((Date.now() - startedAt) / 1000)}s`);


  // ── Final summary ──
  const allJobs = await loadJobs(services.persistence);

  console.log('\n' + '━'.repeat(45));
  console.log('FINAL SUMMARY');
  console.log('━'.repeat(45));
  console.log(`Total in tracker: ${allJobs.length}`);
  console.log('\nPer-source quality (this run):\n');

  const configuredCounts: Record<string, number> = {
    ashby: TARGET_COMPANIES.filter((c) => c.ats === 'ashby').length,
    greenhouse: TARGET_COMPANIES.filter((c) => c.ats === 'greenhouse').length,
    lever: TARGET_COMPANIES.filter((c) => c.ats === 'lever').length,
  };

  for (const src of sources) {
    const s = stats[src] ?? emptySourceStats();
    if (s.scraped === 0) {
      const hint = configuredCounts[src] === 0 ? ' (no companies configured)' : '';
      console.log(`  ${src.padEnd(10)}  scraped=0${hint}`);
      continue;
    }
    const pct = s.scoreCount > 0 ? Math.round((s.toApply / s.scoreCount) * 100) : 0;
    const avg = s.scoreCount > 0 ? (s.scoreSum / s.scoreCount).toFixed(1) : '-';
    console.log(
      `  ${src.padEnd(10)}  scraped=${s.scraped}  considered=${s.considered}  fast-rejected=${s.fastRejected}  llm-scored=${s.llmScored}  to_apply=${s.toApply} (${pct}% of scored)  avg_score=${avg}`,
    );

    // Pick 3 samples: best, weakest-passing, representative rejected. LLM-scored
    // jobs end up in `samples` alongside fast-rejected ones; filter accordingly.
    const llmScoredSamples = s.samples.filter(
      (j) => j.reason !== undefined && !j.deal_breaker && j.fit_score > 0,
    );
    const fastRejectedSamples = s.samples.filter((j) => j.fit_score === 0);
    const passing = llmScoredSamples
      .filter((j) => j.fit_score >= 5)
      .sort((a, b) => b.fit_score - a.fit_score);
    const rejectedByLLM = llmScoredSamples
      .filter((j) => j.fit_score < 5)
      .sort((a, b) => a.fit_score - b.fit_score);

    const best = passing[0];
    const weakestOk = passing.length > 1 ? passing[passing.length - 1] : undefined;
    const rejSample = rejectedByLLM[0] ?? fastRejectedSamples[0];

    if (best) console.log(`    best:       ${best.fit_score}/10 ${best.title} @ ${best.company}`);
    if (weakestOk && weakestOk !== best)
      console.log(
        `    weakest ok: ${weakestOk.fit_score}/10 ${weakestOk.title} @ ${weakestOk.company} (${weakestOk.reason})`,
      );
    if (rejSample)
      console.log(
        `    rejected:   ${rejSample.fit_score}/10 ${rejSample.title} @ ${rejSample.company} (${rejSample.reason})`,
      );
  }

  // Top matches overall — cross-source cherry-pick.
  const toApplyAll = allJobs.filter((j) => j.status === 'to_apply');
  if (toApplyAll.length > 0) {
    console.log('\nTop matches overall:');
    toApplyAll
      .sort((a, b) => b.fit_score - a.fit_score)
      .slice(0, 10)
      .forEach((j) => console.log(`  ${j.fit_score}/10 [${j.source}] ${j.title} @ ${j.company}`));
  }

  console.log(`\nSaved to MongoDB`);

  await app.close();
  await disconnectDatabase();
}

main().catch(console.error);
