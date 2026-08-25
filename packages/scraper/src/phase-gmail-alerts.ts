import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';
import { connectToDatabase, disconnectDatabase } from './persistence/db';
import { AppModule } from './app.module';
import { DealBreakerService } from './scoring/deal-breakers.service';
import { LlmScorerService } from './scoring/llm-scorer.service';
import { QuickRejectService } from './scoring/quick-reject.service';
import { ScraperPersistenceService } from './persistence/persistence.service';
import { GmailAlertsService } from './sourcing/gmail-alerts.service';
import { roleKey } from './common/role-key';
import type { JobListing, ScoredJob } from './types';

const LLM_CONCURRENCY = 5;

interface Services {
  dealBreakers: DealBreakerService;
  quickReject: QuickRejectService;
  scorer: LlmScorerService;
  persistence: ScraperPersistenceService;
  gmailAlerts: GmailAlertsService;
}

async function scoreBatch(batch: JobListing[], scorer: LlmScorerService): Promise<ScoredJob[]> {
  const promises = batch.map(async (job) => {
    try {
      const score = await scorer.scoreFitWithLLM(job);
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

async function main(services: Services): Promise<number> {
  console.log('Gmail Job Alerts — Fetch + Scrape + Score');
  console.log('==========================================\n');

  const existing = await services.persistence.loadExistingJobs();
  const existingIds = new Set(existing.map((j) => j.id));
  const existingKeys = new Set(existing.map(roleKey));
  const existingUrls = new Set(existing.map((j) => j.url).filter(Boolean));
  console.log(`Existing jobs in tracker: ${existing.length}\n`);

  // Fetch from Gmail
  const alertJobs = await services.gmailAlerts.fetchGmailAlerts(existingUrls);

  // Deduplicate
  const newJobs = alertJobs.filter((j) => {
    const key = roleKey(j);
    if (existingIds.has(j.id)) return false;
    if (existingKeys.has(key)) return false;
    if (j.url && existingUrls.has(j.url)) return false;
    return true;
  });

  console.log(
    `\nNew from Gmail: ${newJobs.length} (${alertJobs.length - newJobs.length} duplicates)\n`,
  );

  if (newJobs.length === 0) {
    console.log('No new jobs from Gmail alerts.');
    return 0;
  }

  // Fast filter
  const newScored: ScoredJob[] = [];
  const needsLLM: JobListing[] = [];

  for (const job of newJobs) {
    const dealBreaker = services.dealBreakers.checkDealBreakers(job);
    if (dealBreaker.rejected) {
      newScored.push({
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
    const reject = services.quickReject.quickReject(job);
    if (reject) {
      newScored.push({
        ...job,
        fit_score: 0,
        apply: false,
        matched_skills: [],
        missing_skills: [],
        reason: reject,
        status: 'rejected',
      });
      continue;
    }
    needsLLM.push(job);
  }

  if (newScored.length > 0) await services.persistence.saveJobs(newScored);

  const filtered = newJobs.length - needsLLM.length;
  console.log(`Fast-filtered: ${filtered}`);
  console.log(`Need LLM:      ${needsLLM.length}\n`);

  // LLM scoring
  if (needsLLM.length > 0) {
    const totalBatches = Math.ceil(needsLLM.length / LLM_CONCURRENCY);
    for (let i = 0; i < needsLLM.length; i += LLM_CONCURRENCY) {
      const batch = needsLLM.slice(i, i + LLM_CONCURRENCY);
      const batchNum = Math.floor(i / LLM_CONCURRENCY) + 1;

      console.log(`[Batch ${batchNum}/${totalBatches}] Scoring ${batch.length} jobs...`);
      const scored = await scoreBatch(batch, services.scorer);

      for (const s of scored) {
        console.log(
          `  ${s.fit_score}/10 ${s.fit_score >= 5 ? '✓' : '✗'} ${s.title} @ ${s.company}`,
        );
        newScored.push(s);
      }
      await services.persistence.saveJobs(scored);
    }
  }

  // Summary
  const allJobs = await services.persistence.loadExistingJobs();
  const toApply = allJobs.filter((j) => j.status === 'to_apply');
  console.log('\n' + '━'.repeat(45));
  console.log('GMAIL ALERTS SUMMARY');
  console.log('━'.repeat(45));
  console.log(`New from Gmail:   ${newJobs.length}`);
  console.log(`Fast-filtered:    ${filtered}`);
  console.log(`LLM-scored:       ${needsLLM.length}`);
  console.log(`Total to apply:   ${toApply.length}`);

  const newToApply = newScored.filter((j) => j.status === 'to_apply');
  if (newToApply.length > 0) {
    console.log('\nNew matches:');
    newToApply
      .sort((a, b) => b.fit_score - a.fit_score)
      .forEach((j) => console.log(`  ${j.fit_score}/10 ${j.title} @ ${j.company}`));
  }

  return newJobs.length;
}

async function run() {
  const watchMode = process.argv.includes('--watch');
  const intervalArg = process.argv.find((a) => a.startsWith('--interval='));
  const intervalMinutes = intervalArg ? parseInt(intervalArg.split('=')[1], 10) : 5;

  await connectToDatabase();
  const app: INestApplicationContext = await NestFactory.createApplicationContext(AppModule, {
    logger: false,
  });
  const services: Services = {
    dealBreakers: app.get(DealBreakerService),
    quickReject: app.get(QuickRejectService),
    scorer: app.get(LlmScorerService),
    persistence: app.get(ScraperPersistenceService),
    gmailAlerts: app.get(GmailAlertsService),
  };

  if (watchMode) {
    console.log(`\n📬 Gmail watcher started (checking every ${intervalMinutes} min)\n`);
    console.log('Press Ctrl+C to stop.\n');

    // Bootstrap the Nest context once, above — never per poll iteration — so every
    // poll shares the same singleton service instances instead of re-resolving DI.
    const poll = async () => {
      try {
        const found = await main(services);
        if (found > 0) {
          console.log(`\n✓ Processed ${found} new jobs\n`);
        }
      } catch (err) {
        console.error(`Poll error: ${(err as Error).message}`);
      }
    };

    // Run immediately, then on interval
    await poll();
    setInterval(poll, intervalMinutes * 60 * 1000);
  } else {
    await main(services);
    await app.close();
    await disconnectDatabase();
  }
}

run().catch(console.error);
