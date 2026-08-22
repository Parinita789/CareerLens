import { Injectable } from '@nestjs/common';
import { ImapFlow } from 'imapflow';
import { simpleParser, type ParsedMail } from 'mailparser';
import * as dotenv from 'dotenv';
import * as path from 'path';
import * as crypto from 'crypto';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';
import * as fs from 'fs';
import type { JobListing } from '../types';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../../../../.env') });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function parseEmailForJobUrls(html: string): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();

  // Decode quoted-printable
  const decoded = html
    .replace(/=\r?\n/g, '')
    .replace(/=3D/gi, '=')
    .replace(/=26/gi, '&')
    .replace(/=3F/gi, '?');

  // Match LinkedIn job URLs — require at least 7 digits
  const patterns = [
    /https?:\/\/(?:www\.)?linkedin\.com\/(?:comm\/)?jobs\/view\/(\d{7,})/g,
    /https?:\/\/(?:www\.)?linkedin\.com\/job\/[^"'\s]*?currentJobId=(\d{7,})/g,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(decoded)) !== null) {
      const jobId = match[1];
      if (!seen.has(jobId)) {
        seen.add(jobId);
        urls.push(`https://www.linkedin.com/jobs/view/${jobId}`);
      }
    }
  }

  return urls;
}

async function scrapeJobPage(
  page: import('playwright').Page,
  url: string,
): Promise<JobListing | null> {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => null);
    // LinkedIn hydrates the job detail panel lazily — scroll to trigger it.
    await page.evaluate(() => window.scrollBy(0, 500));
    await page.waitForTimeout(1200);

    const pageTitle = await page.title();
    const parts = pageTitle
      .split(' | ')
      .map((p) => p.trim())
      .filter((p) => p && p !== 'LinkedIn');
    const title = parts[0] ?? '';
    const company = parts[1] ?? '';

    if (!title || !company) return null;
    if (title === 'Jobs' || title.toLowerCase().includes('unable to load')) return null;

    let description = await page
      .$eval(
        [
          '#job-details',
          '.jobs-description__content',
          '.jobs-description-content',
          '[class*="jobs-description"]',
          '.description__text',
          '.show-more-less-html__markup',
        ].join(', '),
        (el: Element) => el.textContent?.trim() ?? '',
      )
      .catch(() => '');

    if (description.length < 200) {
      const body = await page.evaluate(() => document.body.innerText ?? '').catch(() => '');
      const learningIdx = body.indexOf('Learning');
      description = (learningIdx >= 0 ? body.slice(learningIdx + 'Learning'.length) : body).trim();
    }

    const location = await page
      .$eval(
        [
          '.job-details-jobs-unified-top-card__primary-description-container',
          '.jobs-unified-top-card__primary-description',
          '.jobs-unified-top-card__bullet',
          '.topcard__flavor-row',
          '.topcard__flavor--bullet',
        ].join(', '),
        (el: Element) => el.textContent?.trim() ?? '',
      )
      .catch(() => '');

    const isRemote = [title, location, description].join(' ').toLowerCase().includes('remote');

    return {
      id: crypto.createHash('md5').update(`linkedin-${url}`).digest('hex').slice(0, 10),
      title,
      company,
      location,
      remote: isRemote,
      employment_type: 'full-time',
      description,
      url,
      source: 'linkedin',
      scraped_at: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

@Injectable()
export class GmailAlertsService {
  async fetchGmailAlerts(existingUrls?: Set<string>): Promise<JobListing[]> {
    const email = process.env.GMAIL_EMAIL || 'jobhunt2k26@gmail.com';
    const password = process.env.GMAIL_APP_PASSWORD;

    if (!password) {
      console.log('  GMAIL_APP_PASSWORD not set in .env — skipping Gmail fetch');
      return [];
    }

    console.log(`  Connecting to Gmail (${email})...`);

    const client = new ImapFlow({
      host: 'imap.gmail.com',
      port: 993,
      secure: true,
      auth: { user: email, pass: password },
      logger: false,
      // Bail on a stuck TLS socket after 30s instead of letting it hang
      // indefinitely. The error is delivered via promise rejection on the
      // current operation AND via the 'error' EventEmitter event below.
      socketTimeout: 30000,
    });

    // Critical: convert ImapFlow's EventEmitter 'error' event into a logged
    // warning. Without this listener, an async socket timeout (e.g. TLS idle
    // disconnect from Gmail's side) emits an unhandled 'error' which crashes
    // the entire Node process — the symptom the user reported.
    client.on('error', (err: any) => {
      console.error(`  Gmail IMAP error event (continuing): ${err?.message ?? String(err)}`);
    });

    const allUrls: string[] = [];
    const seenUrls = new Set<string>();

    try {
      await client.connect();
      console.log('  Connected to Gmail');

      const lock = await client.getMailboxLock('INBOX');

      try {
        const since = new Date();
        since.setHours(0, 0, 0, 0);

        // imapflow's search() returns `false` when nothing matches — normalize
        // to an empty array so the rest of the code can treat it uniformly.
        const uidsResult = await client.search({ since });
        const uids: number[] = Array.isArray(uidsResult) ? uidsResult : [];
        console.log(`  Found ${uids.length} emails since ${since.toLocaleDateString()}`);

        let emailCount = 0;
        let linkedinCount = 0;
        if (uids.length > 0) {
          const messages = client.fetch(uids, { source: true });

          for await (const msg of messages) {
            // msg.source can be undefined per the type; skip those rather than
            // pass undefined to simpleParser (would throw at runtime anyway).
            if (!msg.source) continue;
            const parsed: ParsedMail = await simpleParser(msg.source);
            const html = parsed.html || parsed.textAsHtml || parsed.text || '';
            const urls = parseEmailForJobUrls(html as string);

            // Skip emails with no LinkedIn job URLs
            if (urls.length === 0) continue;

            linkedinCount++;
            emailCount++;
            console.log(
              `  Email ${emailCount}: "${parsed.subject?.slice(0, 60)}" → ${urls.length} job links`,
            );

            for (const url of urls) {
              if (!seenUrls.has(url)) {
                seenUrls.add(url);
                allUrls.push(url);
              }
            }
          }
        }

        console.log(`  LinkedIn alert emails: ${linkedinCount} out of ${uids.length} total`);

        console.log(`  Processed ${emailCount} emails, ${allUrls.length} unique job URLs`);
      } finally {
        lock.release();
      }

      await client.logout();
    } catch (err) {
      console.error(`  Gmail fetch failed: ${(err as Error).message}`);
      return [];
    }

    if (allUrls.length === 0) return [];

    // Skip URLs already in the database
    const linkedinIdOf = (u: string): string | null => {
      const m = u.match(/linkedin\.com\/(?:comm\/)?jobs\/view\/(\d{7,})/i);
      return m ? m[1] : null;
    };
    if (existingUrls && existingUrls.size > 0) {
      const existingIds = new Set<string>();
      for (const u of existingUrls) {
        const id = linkedinIdOf(u);
        if (id) existingIds.add(id);
      }
      const before = allUrls.length;
      const filtered = allUrls.filter((u) => {
        const id = linkedinIdOf(u);
        // unknown URL form — keep, downstream dedup (company+title key) will handle it
        if (!id) return true;
        return !existingIds.has(id);
      });
      if (before !== filtered.length) {
        console.log(
          `  Skipped ${before - filtered.length} already-tracked URLs (by LinkedIn job ID)`,
        );
      }
      allUrls.length = 0;
      allUrls.push(...filtered);
    }

    if (allUrls.length === 0) {
      console.log('  All URLs already tracked');
      return [];
    }

    const MAX_URLS_PER_RUN = 80;
    if (allUrls.length > MAX_URLS_PER_RUN) {
      console.log(
        `  Capping this run at ${MAX_URLS_PER_RUN} URLs (${allUrls.length - MAX_URLS_PER_RUN} deferred — run again later to pick them up)`,
      );
      allUrls.length = MAX_URLS_PER_RUN;
    }

    // Scrape job details from LinkedIn
    console.log(`  Scraping ${allUrls.length} job pages (2 in parallel)...`);

    const browser = await chromium.launch({
      headless: true,
      args: ['--disable-blink-features=AutomationControlled'],
    });

    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1440, height: 900 },
    });

    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });

    // Block heavy resource types we don't need for text extraction. LinkedIn
    // job pages drag in megabytes of profile photos, ad pixels, and webfonts —
    // none of which affect page.title(), the description selectors, or
    // body.innerText. Cuts per-page memory + bandwidth roughly in half.
    // Allowed: document, script, xhr, fetch (DOM hydration still works).
    // Blocked: image, font, media, stylesheet (purely cosmetic for our purpose).
    await context.route('**/*', (route) => {
      const type = route.request().resourceType();
      if (type === 'image' || type === 'font' || type === 'media' || type === 'stylesheet') {
        return route.abort();
      }
      return route.continue();
    });

    // Load LinkedIn session
    const sessionFile = path.join(__dirname, '../../data/linkedin-session.json');
    if (fs.existsSync(sessionFile)) {
      try {
        const cookies = JSON.parse(fs.readFileSync(sessionFile, 'utf-8'));
        await context.addCookies(cookies);
        console.log('  Loaded LinkedIn session');
      } catch {
        /* ignore */
      }
    }

    const jobs: JobListing[] = [];
    // Concurrency = 2 keeps RAM well under 1 GB and frees the laptop's CPU/IO for
    // foreground work. 5 was reachable but pegged a typical 8-16 GB laptop into
    // memory pressure (Chromium Helper processes + tracking pixels per LinkedIn
    // page). Total wall time roughly doubles vs 5, but the laptop stays usable.
    const PARALLEL = 2;

    // Scrape in parallel batches of 5
    for (let i = 0; i < allUrls.length; i += PARALLEL) {
      const batch = allUrls.slice(i, i + PARALLEL);
      const batchNum = Math.floor(i / PARALLEL) + 1;
      const totalBatches = Math.ceil(allUrls.length / PARALLEL);
      console.log(
        `  Batch ${batchNum}/${totalBatches}: scraping ${batch.length} jobs in parallel...`,
      );

      const results = await Promise.all(
        batch.map(async (url) => {
          const page = await context.newPage();
          try {
            const job = await scrapeJobPage(page, url);
            if (job) console.log(`    ✓ ${job.title} @ ${job.company}`);
            return job;
          } catch {
            return null;
          } finally {
            await page.close().catch(() => {});
          }
        }),
      );

      for (const job of results) {
        if (job) jobs.push(job);
      }

      // Small delay between batches only
      if (i + PARALLEL < allUrls.length) {
        await sleep(500 + Math.random() * 500);
      }
    }

    await browser.close();

    console.log(`  Scraped ${jobs.length} jobs from ${allUrls.length} URLs`);
    return jobs;
  }
}
