import { chromium } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { applyViaEasyApply } from './apply/easy-apply';
import { applyViaGreenhouse } from './apply/greenhouse-apply';
import { connectToDatabase, disconnectDatabase, loadExistingJobs, saveJob } from './db';
import type { ScoredJob } from './types';

dotenv.config({ path: path.join(__dirname, '../../../.env') });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await connectToDatabase();

  // Parse --platforms flag: e.g. --platforms=greenhouse,linkedin
  const platformsArg = process.argv.find((a) => a.startsWith('--platforms='));
  const allowedPlatforms = platformsArg
    ? platformsArg.split('=')[1].split(',')
    : ['linkedin', 'greenhouse', 'ashby'];

  const limitArg = process.argv.find((a) => a.startsWith('--limit='));
  const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : Infinity;

  // Accept specific job IDs: --jobs=id1,id2,id3
  const jobsArg = process.argv.find((a) => a.startsWith('--jobs='));
  const specificJobIds = jobsArg ? jobsArg.split('=')[1].split(',') : null;

  // --submit=true|false — gate the final "Submit Application" click. Default
  // false (dry-run) so running without the flag is always safe.
  const submitArg = process.argv.find((a) => a.startsWith('--submit='));
  const submit = submitArg ? submitArg.split('=')[1] === 'true' : false;

  console.log('Phase 4 — Auto Apply');
  console.log(`Platforms: ${allowedPlatforms.join(', ')} | Limit: ${limit === Infinity ? 'all' : limit}${specificJobIds ? ` | Jobs: ${specificJobIds.length} selected` : ''} | Submit: ${submit ? 'ENABLED' : 'DISABLED (dry-run)'}`);
  console.log('==============================\n');

  // Only load specific jobs when IDs are provided (skip loading all 1600+ jobs)
  let jobs: ScoredJob[];
  if (specificJobIds) {
    const { JobModel } = await import('./db');
    const docs = await JobModel.find({ externalId: { $in: specificJobIds } }).lean();
    const { default: _ } = await import('./db'); // ensure jobDocToScoredJob is available
    jobs = docs.map((d: any) => ({
      id: d.externalId,
      title: d.title,
      company: d.company,
      url: d.url,
      description: d.description || '',
      source: d.source,
      location: d.location || '',
      salary_min: d.salary_min,
      salary_max: d.salary_max,
      posted_at: d.posted_at,
      scraped_at: d.scraped_at,
      fit_score: d.fit_score || 0,
      apply: d.apply ?? false,
      matched_skills: d.matched_skills || [],
      missing_skills: d.missing_skills || [],
      reason: d.reason || '',
      status: d.status || 'to_apply',
      deal_breaker: d.deal_breaker,
      applied_at: d.applied_at,
      applied_via: d.applied_via,
    })) as ScoredJob[];
    console.log(`Loaded ${jobs.length} specific jobs from DB`);
  } else {
    jobs = await loadExistingJobs();
  }

  const allEligible = specificJobIds
    ? jobs.filter((j) => specificJobIds.includes(j.id) && ['to_apply', 'rejected'].includes(j.status))
    : jobs.filter((j) => j.fit_score >= 5 && j.status === 'to_apply');

  const linkedinJobs = allowedPlatforms.includes('linkedin') ? allEligible.filter((j) => j.source === 'linkedin') : [];
  const greenhouseJobs = allowedPlatforms.includes('greenhouse') ? allEligible.filter((j) => j.source === 'greenhouse') : [];
  const ashbyJobs = allowedPlatforms.includes('ashby') ? allEligible.filter((j) => j.source === 'ashby') : [];
  const manualApply = allEligible.filter((j) => !allowedPlatforms.includes(j.source));

  if (manualApply.length > 0) {
    console.log(`Lever/Indeed jobs (apply manually):`);
    manualApply.forEach((j) =>
      console.log(`  ${j.fit_score}/10 — ${j.title} @ ${j.company}\n           ${j.url}`),
    );
    console.log('');
  }

  // Ashby + Greenhouse first (direct career page), then LinkedIn
  const toApply = [...ashbyJobs, ...greenhouseJobs, ...linkedinJobs].slice(0, limit);

  if (toApply.length === 0) {
    console.log('No eligible jobs with status "to_apply".');
    await disconnectDatabase();
    return;
  }

  console.log(`Ashby Apply:         ${ashbyJobs.length} jobs`);
  console.log(`Greenhouse Apply:    ${greenhouseJobs.length} jobs`);
  console.log(`LinkedIn Easy Apply: ${linkedinJobs.length} jobs\n`);
  toApply.forEach((j) => console.log(`  ${j.fit_score}/10 [${j.source}] ${j.title} @ ${j.company}`));
  console.log('');

  // Load pre-scraped answers if available (from Prepare tab) — no scraping here
  const { ApplicationFieldsModel } = await import('@job-agent/shared');

  // Launch browser
  console.log('Launching browser...');
  const browser = await chromium.launch({
    headless: false,
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-infobars',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--start-maximized',
    ],
  });
  console.log('  Browser ready\n');

  // Exit cleanly when user manually closes the browser window
  browser.on('disconnected', async () => {
    console.log('\n  Browser closed by user. Exiting...');
    await disconnectDatabase().catch(() => {});
    process.exit(0);
  });

  // Only generate cover letters if they don't already exist (pre-scraped jobs already have them)
  const { CoverLetterModel } = await import('./db');
  const coverLetterPromise = (async () => {
    for (const job of toApply) {
      // Check pre-scraped data first (already has cover letter)
      const preFilled = await ApplicationFieldsModel.findOne({ externalJobId: job.id }).lean().catch(() => null);
      if ((preFilled as any)?.coverLetter) continue;
      // Check cover letter collection
      const existing = await CoverLetterModel.findOne({ externalJobId: job.id }).lean().catch(() => null);
      if (existing) continue;
      // Generate only if missing everywhere
      try {
        const { generateCoverLetter } = await import('./cover-letter/cover-letter');
        const cl = await generateCoverLetter(job);
        const { saveCoverLetter } = await import('./db');
        await saveCoverLetter(job.id, cl);
        console.log(`  ✓ Cover letter ready: ${job.company}`);
      } catch {
        console.log(`  ✗ Cover letter failed: ${job.company}`);
      }
    }
  })();

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: null, // use full window size (--start-maximized)
    locale: 'en-US',
    timezoneId: 'America/Los_Angeles',
    permissions: ['geolocation'],
    geolocation: { latitude: 37.5485, longitude: -121.9886 }, // Fremont, CA
  });

  // Comprehensive anti-detection
  await context.addInitScript(() => {
    // Hide webdriver
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

    // Realistic plugins
    Object.defineProperty(navigator, 'plugins', {
      get: () => {
        const plugins = [
          { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
          { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
          { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
        ];
        return Object.assign(plugins, { length: 3, item: (i: number) => plugins[i], namedItem: (n: string) => plugins.find(p => p.name === n) });
      },
    });

    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
    Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
    Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 0 });

    // Chrome runtime
    (window as any).chrome = {
      runtime: { connect: () => {}, sendMessage: () => {} },
      loadTimes: () => ({}),
      csi: () => ({}),
    };

    // Hide automation flags
    const originalQuery = window.navigator.permissions.query;
    window.navigator.permissions.query = (parameters: any) =>
      parameters.name === 'notifications'
        ? Promise.resolve({ state: 'prompt' } as PermissionStatus)
        : originalQuery(parameters);

    // Realistic screen
    Object.defineProperty(screen, 'width', { get: () => 1440 });
    Object.defineProperty(screen, 'height', { get: () => 900 });
    Object.defineProperty(screen, 'availWidth', { get: () => 1440 });
    Object.defineProperty(screen, 'availHeight', { get: () => 877 });
    Object.defineProperty(screen, 'colorDepth', { get: () => 24 });
    Object.defineProperty(screen, 'pixelDepth', { get: () => 24 });
  });

  // Load saved sessions — use separate LinkedIn session for applying (your real account)
  const linkedinApplySessionFile = path.join(__dirname, '../data/linkedin-session-apply.json');
  const linkedinScrapeSessionFile = path.join(__dirname, '../data/linkedin-session.json');
  if (fs.existsSync(linkedinApplySessionFile)) {
    const cookies = JSON.parse(fs.readFileSync(linkedinApplySessionFile, 'utf-8'));
    await context.addCookies(cookies);
    console.log('LinkedIn session loaded (apply account).');
  } else if (fs.existsSync(linkedinScrapeSessionFile)) {
    console.log('⚠ Only scrape LinkedIn session found. Log into your real LinkedIn in the browser — it will be saved for future applies.');
  }

  const greenhouseSessionFile = path.join(__dirname, '../data/greenhouse-session.json');
  if (fs.existsSync(greenhouseSessionFile)) {
    const cookies = JSON.parse(fs.readFileSync(greenhouseSessionFile, 'utf-8'));
    await context.addCookies(cookies);
    console.log('Greenhouse session loaded.');
  }
  console.log('');

  const page = await context.newPage();

  const results = {
    applied: [] as string[],
    skipped: [] as { job: string; reason: string }[],
    failed: [] as { job: string; reason: string }[],
  };

  for (let i = 0; i < toApply.length; i++) {
    // Stop if page or browser was closed by user
    if (page.isClosed() || !browser.isConnected()) {
      console.log('\n  Browser/page closed. Stopping.');
      break;
    }

    const job = toApply[i];
    const label = `${job.title} @ ${job.company}`;

    console.log(`\n[${i + 1}/${toApply.length}] ${label}`);
    console.log(`  Score: ${job.fit_score}/10 | Platform: ${job.source}`);
    console.log(`  URL: ${job.url}`);

    // Same tab, sequential — more human-like
    let result: any;
    try {
      result = (job.source === 'greenhouse' || job.source === 'ashby')
        ? await applyViaGreenhouse(page, job, submit)
        : await applyViaEasyApply(page, job, submit);
    } catch (err) {
      const msg = (err as Error).message || '';
      if (msg.includes('closed') || msg.includes('destroyed')) {
        console.log('  Browser/page closed. Stopping.');
        break;
      }
      console.log(`  ERROR: ${msg}`);
      result = { success: false, reason: msg };
      await page.goto('about:blank').catch(() => {});
    }

    // Save session cookies after each job (captures login state)
    const cookies = await context.cookies();
    if (job.source === 'greenhouse') {
      const ghCookies = cookies.filter((c) => c.domain.includes('greenhouse'));
      if (ghCookies.length > 0) {
        fs.writeFileSync(greenhouseSessionFile, JSON.stringify(ghCookies, null, 2));
      }
    }
    // Save LinkedIn apply session (separate from scrape session)
    const liCookies = cookies.filter((c) => c.domain.includes('linkedin'));
    if (liCookies.length > 0) {
      fs.writeFileSync(linkedinApplySessionFile, JSON.stringify(liCookies, null, 2));
    }

    if (result.success) {
      console.log(`  APPLIED (${result.method})`);
      results.applied.push(label);

      job.status = 'applied';
      job.applied_at = new Date().toISOString();
      job.applied_via = 'auto';
      await saveJob(job);
      // Mark applicationFields as applied so it disappears from Prepare tab
      await ApplicationFieldsModel.findOneAndUpdate(
        { externalJobId: job.id },
        { $set: { status: 'applied' } },
      ).catch(() => {});
      console.log(`  ✓ Status updated to 'applied' in database`);
    } else if (result.reason.includes('No Easy Apply') || result.reason.includes('No application form')) {
      console.log(`  SKIPPED: ${result.reason}`);
      results.skipped.push({ job: label, reason: result.reason });
      // Mark as rejected so it doesn't show up again
      job.status = 'rejected';
      job.reason = result.reason;
      await saveJob(job);
    } else if (result.reason.includes('skipped') || result.reason.includes('Timed out')) {
      console.log(`  SKIPPED — moving to next job`);
      results.skipped.push({ job: label, reason: result.reason });
      // Don't change status — user can retry later
    } else {
      console.log(`  FAILED: ${result.reason}`);
      results.failed.push({ job: label, reason: result.reason });
    }

    // Delay between jobs — shorter when pre-filled, longer for manual fills
    if (i < toApply.length - 1) {
      const wasApplied = result.success;
      const delay = wasApplied ? 2000 + Math.random() * 2000 : 500 + Math.random() * 1000;
      console.log(`\n  Waiting ${Math.round(delay / 1000)}s before next job...`);
      await sleep(delay);
    }
  }

  // Wait for any remaining cover letter generation
  await coverLetterPromise.catch(() => {});
  await browser.close();

  console.log('\n==============================');
  console.log('Phase 4 Summary');
  console.log('==============================');
  console.log(`Applied:  ${results.applied.length}`);
  console.log(`Skipped:  ${results.skipped.length}`);
  console.log(`Failed:   ${results.failed.length}`);

  if (results.applied.length > 0) {
    console.log('\nSuccessfully applied to:');
    results.applied.forEach((j) => console.log(`  ✓ ${j}`));
  }

  if (results.skipped.length > 0) {
    console.log('\nSkipped (apply manually):');
    results.skipped.forEach((s) => console.log(`  - ${s.job}`));
  }

  if (results.failed.length > 0) {
    console.log('\nFailed:');
    results.failed.forEach((f) => console.log(`  ! ${f.job} — ${f.reason}`));
  }

  await disconnectDatabase();
}

main().catch(console.error);
