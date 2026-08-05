import * as path from 'path';
import { fileURLToPath } from 'url';
import {
  connectToDatabase,
  disconnectDatabase,
  loadExistingJobs as dbLoadJobs,
  saveJobs as dbSaveJobs,
} from './db';
import { scrapeLinkedIn } from './scraper/linkedin';
import { scrapeLinkedInAlerts } from './scraper/linkedin-alerts';
import { scrapeGreenhouse } from './scraper/greenhouse';
import { scrapeLever } from './scraper/lever';
import { scrapeIndeed } from './scraper/indeed';
import { scrapeAshby } from './scraper/ashby';
import { checkDealBreakers } from './deal-breakers';
import { scoreFitWithLLM } from './scorer/llm-scorer';
import { TARGET_COMPANIES } from './scraper/company-list';
import type { JobListing, ScoredJob } from './types';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const LLM_CONCURRENCY = 3;
const MAX_JOB_AGE_DAYS = 14;
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
async function loadJobs(): Promise<ScoredJob[]> {
  return dbLoadJobs();
}

async function persistJobs(jobs: ScoredJob[]): Promise<void> {
  await dbSaveJobs(jobs);
}

// ── Fast keyword pre-filter (no LLM needed) ────────────────────────
function quickReject(job: JobListing): string | null {
  const t = job.title.toLowerCase();
  const d = job.description.slice(0, 500).toLowerCase();

  // wrong role entirely
  const titleRejects = [
    'frontend',
    'front-end',
    'ios developer',
    'android developer',
    'data scientist',
    'machine learning engineer',
    'ml engineer',
    'designer',
    'ux ',
    'product manager',
    'sales ',
    'recruiter',
    'marketing',
    'finance',
    'legal',
    'devrel',
    'developer advocate',
    'embedded',
    'firmware',
    'hardware',
    'mechanical',
    'data analyst',
    'analytics engineer',
    'qa engineer',
    'sdet',
    'test engineer',
    'intern ',
    'junior',
    'principal',
    'staff ',
  ];
  for (const k of titleRejects) {
    if (t.includes(k)) return `Title exclude: ${k}`;
  }

  // wrong primary stack — description dominated by non-matching tech
  const wrongStack = [
    { keywords: ['java ', 'spring boot', 'jvm', 'kotlin'], label: 'Java/JVM' },
    { keywords: ['.net', 'c# ', 'asp.net', 'blazor'], label: '.NET/C#' },
    { keywords: ['ruby on rails', 'rails ', 'ruby '], label: 'Ruby/Rails' },
    { keywords: ['php ', 'laravel', 'symfony'], label: 'PHP' },
    { keywords: ['swift ', 'swiftui', 'uikit'], label: 'iOS/Swift' },
    { keywords: ['flutter', 'dart '], label: 'Flutter/Dart' },
  ];

  for (const stack of wrongStack) {
    const hits = stack.keywords.filter((k) => d.includes(k)).length;
    if (hits >= 2) return `Wrong stack: ${stack.label}`;
  }

  return null;
}

// ── Score a batch of jobs concurrently ──────────────────────────────
async function scoreBatch(batch: JobListing[]): Promise<ScoredJob[]> {
  const promises = batch.map(async (job) => {
    try {
      const score = await scoreFitWithLLM(job);
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

async function scrapeAllSources(sources: Source[] = ALL_SOURCES): Promise<JobListing[]> {
  const all: JobListing[] = [];
  const enabled = new Set(sources);

  if (enabled.has('linkedin')) {
    console.log('━'.repeat(45));
    console.log('SOURCE — LinkedIn');
    console.log('━'.repeat(45));

    for (const query of LINKEDIN_QUERIES) {
      console.log(`\nSearching: "${query.keywords}" in ${query.location}`);
      try {
        const jobs = await scrapeLinkedIn(query.keywords, query.location, LINKEDIN_JOBS_PER_QUERY);
        console.log(`  Got ${jobs.length} jobs`);
        all.push(...jobs);
      } catch (err) {
        console.error(`  Failed: ${(err as Error).message}`);
      }
    }

    console.log('\n' + '━'.repeat(45));
    console.log('SOURCE — LinkedIn Job Alerts');
    console.log('━'.repeat(45));

    try {
      const alertJobs = await scrapeLinkedInAlerts(50);
      console.log(`  Got ${alertJobs.length} jobs from alerts`);
      all.push(...alertJobs);
    } catch (err) {
      console.error(`  Alerts failed: ${(err as Error).message}`);
    }
  }

  if (enabled.has('greenhouse')) {
    console.log('\n' + '━'.repeat(45));
    console.log('SOURCE — Greenhouse');
    console.log('━'.repeat(45) + '\n');

    const greenhouseCompanies = TARGET_COMPANIES.filter((c) => c.ats === 'greenhouse');
    console.log(`Scraping ${greenhouseCompanies.length} companies...\n`);

    for (const company of greenhouseCompanies) {
      const jobs = await scrapeGreenhouse(company.slug, company.name);
      all.push(...jobs);
    }
  }

  if (enabled.has('lever')) {
    console.log('\n' + '━'.repeat(45));
    console.log('SOURCE — Lever');
    console.log('━'.repeat(45) + '\n');

    const leverCompanies = TARGET_COMPANIES.filter((c) => c.ats === 'lever');
    console.log(`Scraping ${leverCompanies.length} companies...\n`);

    for (const company of leverCompanies) {
      const jobs = await scrapeLever(company.slug, company.name);
      all.push(...jobs);
    }
  }

  if (enabled.has('indeed')) {
    console.log('\n' + '━'.repeat(45));
    console.log('SOURCE — Indeed');
    console.log('━'.repeat(45));

    const indeedSeen = new Set<string>();
    for (const query of INDEED_QUERIES) {
      console.log(`\nSearching: "${query.keywords}" in ${query.location}`);
      try {
        const jobs = await scrapeIndeed(query.keywords, query.location, INDEED_JOBS_PER_QUERY);
        // Dedup across queries by id
        const newJobs = jobs.filter((j) => {
          if (indeedSeen.has(j.id)) return false;
          indeedSeen.add(j.id);
          return true;
        });
        console.log(
          `  Got ${jobs.length} jobs (${jobs.length - newJobs.length} cross-query dupes)`,
        );
        all.push(...newJobs);
      } catch (err) {
        console.error(`  Failed: ${(err as Error).message}`);
      }
    }
  }

  return all;
}

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
    const dealBreaker = checkDealBreakers(job);
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
    const qr = quickReject(job);
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

  if (rejected.length > 0) await persistJobs(rejected);
  console.log(`  Filter: ${rejected.length} rejected, ${needsLLM.length} need LLM`);

  // LLM scoring in batches
  const highScoreJobs: ScoredJob[] = [];
  if (needsLLM.length > 0) {
    const totalBatches = Math.ceil(needsLLM.length / LLM_CONCURRENCY);
    for (let i = 0; i < needsLLM.length; i += LLM_CONCURRENCY) {
      const batch = needsLLM.slice(i, i + LLM_CONCURRENCY);
      const batchNum = Math.floor(i / LLM_CONCURRENCY) + 1;

      console.log(`  [${sourceName} ${batchNum}/${totalBatches}] Scoring ${batch.length}...`);
      const scored = await scoreBatch(batch);

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
      await persistJobs(scored);
    }
  }

  // Pre-scrape application forms for 7+ scored jobs
  if (highScoreJobs.length > 0) {
    try {
      const { scrapeApplicationForms } = await import('./scraper/form-scraper');
      console.log(`\n  Pre-scraping forms for ${highScoreJobs.length} high-score jobs...`);
      await scrapeApplicationForms(highScoreJobs);
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

async function main() {
  const sourcesArg = process.argv.find((a) => a.startsWith('--sources='));
  const sources: Source[] = sourcesArg
    ? (sourcesArg.split('=')[1].split(',') as Source[])
    : ALL_SOURCES;

  console.log('Phase 2 — Multi-Source Job Scraper (per-source scoring)');
  console.log(`Sources: ${sources.join(', ')}`);
  console.log('=====================================\n');

  await connectToDatabase();

  const existingJobs = await loadJobs();
  const existingIds = new Set(existingJobs.map((j) => j.id));
  console.log(`Existing jobs in tracker: ${existingJobs.length}\n`);

  // Shared dedup sets — accumulate across sources
  const seenIds = new Set<string>();
  const seenKeys = new Set(existingJobs.map((j) => `${j.company}|||${j.title}`.toLowerCase()));
  const seenUrls = new Set(existingJobs.map((j) => j.url).filter(Boolean));

  const enabled = new Set(sources);
  const stats: Record<string, SourceStats> = {};

  // Ensure every enabled source appears in the summary even if it scraped nothing —
  // a "scraped=0" row for LinkedIn is the whole point (catches silent login failures).
  for (const s of sources) stats[s] = emptySourceStats();

  // ── Source: Ashby (API-based, score per company — jobs appear before LinkedIn) ──
  if (enabled.has('ashby')) {
    console.log('━'.repeat(45));
    console.log('SOURCE — Ashby (direct career page API)');
    console.log('━'.repeat(45) + '\n');

    const ashbyCompanies = TARGET_COMPANIES.filter((c) => c.ats === 'ashby');

    for (const company of ashbyCompanies) {
      const jobs = await scrapeAshby(company.slug, company.name);
      if (jobs.length > 0) {
        await dedupFilterScore(jobs, company.name, seenIds, seenKeys, seenUrls, existingIds, stats);
      }
    }
  }

  // ── Source: Greenhouse (API-based, score per company for real-time results) ──
  if (enabled.has('greenhouse')) {
    console.log('━'.repeat(45));
    console.log('SOURCE — Greenhouse (scrape + score per company)');
    console.log('━'.repeat(45) + '\n');

    const greenhouseCompanies = TARGET_COMPANIES.filter((c) => c.ats === 'greenhouse');

    for (const company of greenhouseCompanies) {
      const jobs = await scrapeGreenhouse(company.slug, company.name);
      if (jobs.length > 0) {
        await dedupFilterScore(jobs, company.name, seenIds, seenKeys, seenUrls, existingIds, stats);
      }
    }
  }

  // ── Source 2: LinkedIn (score per query for real-time results) ──
  if (enabled.has('linkedin')) {
    console.log('\n' + '━'.repeat(45));
    console.log('SOURCE — LinkedIn (scrape + score per query)');
    console.log('━'.repeat(45));

    for (const query of LINKEDIN_QUERIES) {
      console.log(`\nSearching: "${query.keywords}" in ${query.location}`);
      try {
        const jobs = await scrapeLinkedIn(query.keywords, query.location, LINKEDIN_JOBS_PER_QUERY);
        console.log(`  Got ${jobs.length} jobs`);
        if (jobs.length > 0) {
          await dedupFilterScore(
            jobs,
            `LinkedIn "${query.keywords}"`,
            seenIds,
            seenKeys,
            seenUrls,
            existingIds,
            stats,
          );
        }
      } catch (err) {
        console.error(`  Failed: ${(err as Error).message}`);
      }
    }

    // Gmail alerts — scrape + score per alert for real-time results
    try {
      console.log('\nLinkedIn Job Alerts:');
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
          console.log(`\n  Alert: "${alert.label}"`);
          try {
            const jobs = await scrapeLinkedIn(alert.keywords, alert.location, 50);
            console.log(`  Got ${jobs.length} jobs`);
            if (jobs.length > 0) {
              await dedupFilterScore(
                jobs,
                `Alert "${alert.label}"`,
                seenIds,
                seenKeys,
                seenUrls,
                existingIds,
                stats,
              );
            }
          } catch (err) {
            console.error(`  Alert "${alert.label}" failed: ${(err as Error).message}`);
          }
        }
      } else {
        // Fallback to the combined function if no alerts.json
        const alertJobs = await scrapeLinkedInAlerts(50);
        console.log(`  Got ${alertJobs.length} jobs from alerts`);
        if (alertJobs.length > 0) {
          await dedupFilterScore(
            alertJobs,
            'LinkedIn Alerts',
            seenIds,
            seenKeys,
            seenUrls,
            existingIds,
            stats,
          );
        }
      }
    } catch (err) {
      console.error(`  Alerts failed: ${(err as Error).message}`);
    }
  }

  // ── Source 3: Lever (score per company for real-time results) ──
  if (enabled.has('lever')) {
    console.log('\n' + '━'.repeat(45));
    console.log('SOURCE — Lever (scrape + score per company)');
    console.log('━'.repeat(45) + '\n');

    const leverCompanies = TARGET_COMPANIES.filter((c) => c.ats === 'lever');

    for (const company of leverCompanies) {
      const jobs = await scrapeLever(company.slug, company.name);
      if (jobs.length > 0) {
        await dedupFilterScore(jobs, company.name, seenIds, seenKeys, seenUrls, existingIds, stats);
      }
    }
  }

  // ── Source 4: Indeed (if enabled) ──
  if (enabled.has('indeed')) {
    console.log('\n' + '━'.repeat(45));
    console.log('SOURCE — Indeed (scrape + score)');
    console.log('━'.repeat(45));

    const indeedSeen = new Set<string>();
    for (const query of INDEED_QUERIES) {
      console.log(`\nSearching: "${query.keywords}" in ${query.location}`);
      try {
        const jobs = await scrapeIndeed(query.keywords, query.location, INDEED_JOBS_PER_QUERY);
        const newJobs = jobs.filter((j) => {
          if (indeedSeen.has(j.id)) return false;
          indeedSeen.add(j.id);
          return true;
        });
        console.log(
          `  Got ${jobs.length} jobs (${jobs.length - newJobs.length} cross-query dupes)`,
        );
        if (newJobs.length > 0) {
          await dedupFilterScore(
            newJobs,
            `Indeed "${query.keywords}"`,
            seenIds,
            seenKeys,
            seenUrls,
            existingIds,
            stats,
          );
        }
      } catch (err) {
        console.error(`  Failed: ${(err as Error).message}`);
      }
    }
  }

  // ── Final summary ──
  const allJobs = await loadJobs();

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

  await disconnectDatabase();
}

main().catch(console.error);
