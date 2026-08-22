import { Injectable } from '@nestjs/common';
import { chromium, type BrowserContext, type Page } from 'playwright';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import type { JobListing } from '../types';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const randomDelay = () => sleep(2000 + Math.random() * 3000);

const SESSION_FILE = path.join(__dirname, '../../data/linkedin-session.json');

function parsePostedDate(text: string): string | undefined {
  if (!text) return undefined;

  // If it's an ISO date (from datetime attribute)
  if (text.match(/^\d{4}-\d{2}-\d{2}/)) return new Date(text).toISOString();

  // Parse relative dates like "2 days ago", "1 week ago", "3 hours ago"
  const match = text.match(/(\d+)\s*(second|minute|hour|day|week|month)s?\s*ago/i);
  if (match) {
    const num = parseInt(match[1], 10);
    const unit = match[2].toLowerCase();
    const now = new Date();
    const ms: Record<string, number> = {
      second: 1000,
      minute: 60000,
      hour: 3600000,
      day: 86400000,
      week: 604800000,
      month: 2592000000,
    };
    return new Date(now.getTime() - num * (ms[unit] || 0)).toISOString();
  }

  return undefined;
}

function buildLinkedInURL(keywords: string, location: string): string {
  const base = 'https://www.linkedin.com/jobs/search';
  const params = new URLSearchParams({
    keywords,
    location,
    f_JT: 'F',
    f_E: '2,3,4',
    f_TPR: 'r604800',
    sortBy: 'DD',
  });
  return `${base}?${params.toString()}`;
}

function extractSalary(text: string): { min?: number; max?: number } {
  const match = text.match(/\$?([\d,]+)[kK]?\s*[-–]\s*\$?([\d,]+)[kK]?/);
  if (!match) return {};
  const hasK = text.toLowerCase().includes('k');
  const parse = (s: string) => {
    const n = parseInt(s.replace(/,/g, ''));
    return hasK || n < 1000 ? n * 1000 : n;
  };
  return { min: parse(match[1]!), max: parse(match[2]!) };
}

async function saveSession(context: BrowserContext) {
  const cookies = await context.cookies();
  fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true });
  fs.writeFileSync(SESSION_FILE, JSON.stringify(cookies, null, 2));
  console.log('  Session saved.');
}

async function loadSession(context: BrowserContext): Promise<boolean> {
  if (!fs.existsSync(SESSION_FILE)) return false;
  const cookies = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8'));
  await context.addCookies(cookies);
  console.log('  Loaded existing session.');
  return true;
}

function isLoginWall(url: string): boolean {
  return (
    url.includes('/login') ||
    url.includes('/authwall') ||
    url.includes('/checkpoint') ||
    url.includes('/signup')
  );
}

@Injectable()
export class LinkedInService {
  async scrapeLinkedIn(
    keywords: string,
    location: string,
    maxJobs: number = 10,
    customUrl?: string,
  ): Promise<JobListing[]> {
    const hasSession = fs.existsSync(SESSION_FILE);
    const headless = hasSession; // run headless when session exists, visible for login

    const browser = await chromium.launch({
      headless,
      executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
    });

    if (headless) console.log('  Running headless (session found)');

    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });

    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });

    const sessionLoaded = await loadSession(context);
    const page = await context.newPage();
    const jobs: JobListing[] = [];

    try {
      const searchUrl = customUrl ?? buildLinkedInURL(keywords, location);

      await page.goto(searchUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      });

      await randomDelay();

      const initialCookies = await context.cookies('https://www.linkedin.com').catch(() => []);
      const isAuthenticated = initialCookies.some((c) => c.name === 'li_at');
      if (!isAuthenticated) console.log('  No li_at cookie — forcing login flow');

      // ── handle login wall ─────────────────────────────────────────────
      if (isLoginWall(page.url()) || !isAuthenticated) {
        if (sessionLoaded && fs.existsSync(SESSION_FILE)) {
          console.log('  Session expired, clearing...');
          fs.unlinkSync(SESSION_FILE);
        }

        // If running headless, can't do manual login — relaunch with visible browser
        if (headless) {
          console.log('  Session expired — relaunching with visible browser for login...');
          await browser.close();
          return this.scrapeLinkedIn(keywords, location, maxJobs, customUrl);
        }

        if (!isLoginWall(page.url())) {
          const loginUrl = `https://www.linkedin.com/login?session_redirect=${encodeURIComponent(searchUrl)}`;
          await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
          await sleep(1500);
        }

        console.log('\n' + '━'.repeat(45));
        console.log('Login wall detected. Please log in in the browser window.');
        console.log('Waiting up to 5 minutes for you to finish...');
        console.log('━'.repeat(45) + '\n');

        const deadline = Date.now() + 5 * 60 * 1000;
        let lastLoggedUrl = '';
        let loggedInUrl: string | null = null;
        let lastCookieReport = 0;

        while (Date.now() < deadline) {
          const cur = page.url();
          const cookies = await context.cookies('https://www.linkedin.com').catch(() => []);
          const liAt = cookies.find((c) => c.name === 'li_at');
          if (liAt) {
            loggedInUrl = cur;
            break;
          }
          if (cur !== lastLoggedUrl) {
            lastLoggedUrl = cur;
            const label = cur.includes('/checkpoint')
              ? 'LinkedIn security check — complete verification (email code / CAPTCHA) in browser'
              : cur.includes('/authwall')
                ? 'Auth wall — LinkedIn wants you to sign in'
                : isLoginWall(cur)
                  ? 'Login page'
                  : 'Transitioning — waiting for auth cookie';
            console.log(`  [${label}] ${cur}`);
          }

          if (Date.now() - lastCookieReport > 30_000) {
            lastCookieReport = Date.now();
            console.log(
              `  …still waiting for li_at cookie (have ${cookies.length} LinkedIn cookies so far)`,
            );
          }
          await sleep(2000);
        }

        if (!loggedInUrl) {
          const finalUrl = page.url();
          const shotPath = path.join(__dirname, '../../data/debug-login-timeout.png');
          await page.screenshot({ path: shotPath }).catch(() => null);
          console.error(`\nLogin timed out after 5 min. Final URL: ${finalUrl}`);
          console.error(`Screenshot: ${shotPath}`);
          console.error(
            `Hints: 1) Did LinkedIn show a CAPTCHA or email-code step? Complete it before the timeout.`,
          );
          console.error(
            `       2) If LinkedIn keeps rejecting the login, it may be flagging the automated browser — try logging in manually in regular Chrome first to clear the flag.`,
          );
          return [];
        }

        console.log(`Login successful! URL: ${loggedInUrl}`);
        await saveSession(context);
        await sleep(3000);

        console.log('Navigating to job search...');
        await page.goto(searchUrl, {
          waitUntil: 'domcontentloaded',
          timeout: 60000,
        });

        await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => null);
        await sleep(2000);
      }

      // ── confirm not still on login (LinkedIn sometimes bounces back after re-nav) ──
      if (isLoginWall(page.url())) {
        const shotPath = path.join(__dirname, '../../data/debug-login-failed.png');
        await page.screenshot({ path: shotPath }).catch(() => null);
        console.error(`Bounced back to login wall after re-nav. URL: ${page.url()}`);
        console.error(`Screenshot: ${shotPath}`);
        console.error(
          `This usually means LinkedIn rejected the session — try deleting data/linkedin-session.json and running again.`,
        );
        return [];
      }

      // ── wait for job list ─────────────────────────────────────────────
      console.log('Waiting for job list...');

      // try multiple selectors — /jobs/search/ and /jobs/search-results/ use different DOM
      const cardSelectors = [
        'li.scaffold-layout__list-item',
        'li.jobs-search-results__list-item',
        'li.reusable-search__result-container',
        '.job-card-container',
        '[data-occludable-job-id]',
      ];

      const cardSelectorStr = cardSelectors.join(', ');

      await page
        .waitForSelector(cardSelectorStr, { timeout: 20000 })
        .catch(() => console.log('Warning: list items slow to appear'));

      // ── scroll to load all cards ──────────────────────────────────────
      console.log('Scrolling to load all job cards...');

      const listContainerSelectors = [
        '.scaffold-layout__list',
        '.jobs-search-results-list',
        '.jobs-search__results-list',
      ];

      let listContainer = null;
      for (const sel of listContainerSelectors) {
        listContainer = await page.$(sel);
        if (listContainer) break;
      }

      for (let s = 0; s < 3; s++) {
        if (listContainer) {
          await page.evaluate((el) => {
            el.scrollTop = el.scrollHeight;
          }, listContainer);
        } else {
          await page.evaluate(() => window.scrollBy(0, 3000));
        }
        await sleep(1500);
      }

      // scroll back to top so first card is clickable
      if (listContainer) {
        await page.evaluate((el) => {
          el.scrollTop = 0;
        }, listContainer);
      } else {
        await page.evaluate(() => window.scrollTo(0, 0));
      }
      await sleep(1000);

      // ── find job cards using multiple selectors ─────────────────────
      let allCards = await page.$$(cardSelectorStr);
      console.log(`\nFound ${allCards.length} total cards`);

      // if still 0, try a broad fallback — any <li> inside a jobs list
      if (allCards.length === 0) {
        console.log('Trying broad fallback selectors...');
        allCards = await page.$$(
          'ul.scaffold-layout__list-container > li, div[class*="jobs-search"] li',
        );
        console.log(`Fallback found ${allCards.length} cards`);
      }

      const jobCards = [];
      const seenCardIds = new Set<string>();
      for (const card of allCards) {
        const hasTitle = await card
          .$(
            '.job-card-list__title--link, ' +
              '.job-card-container__link, ' +
              'a[data-control-name="jobcard_title"], ' +
              '[class*="job-card"][class*="title"], ' +
              'a[class*="job-card"]',
          )
          .catch(() => null);
        const cardText = await card
          .$eval('*', (el: Element) => el.textContent?.trim() ?? '')
          .catch(() => '');

        if (hasTitle || cardText.length > 50) {
          // Dedup cards by job URL — overlapping selectors can match same job twice
          const cardUrl = await card
            .$eval('a[href*="/jobs/view/"]', (el: Element) => (el as HTMLAnchorElement).href ?? '')
            .catch(() => '');
          const idMatch = cardUrl.match(/\/jobs\/view\/(\d+)/);
          const cardId = idMatch?.[1] || cardText.slice(0, 80);

          if (!seenCardIds.has(cardId)) {
            seenCardIds.add(cardId);
            jobCards.push(card);
          }
        }
      }

      console.log(`Found ${jobCards.length} unique cards (from ${allCards.length} elements)\n`);

      if (jobCards.length === 0) {
        // dump all selectors found on page for debugging
        const debugInfo = await page.evaluate(() => {
          const jobRelated = Array.from(document.querySelectorAll('[class*="job"]'));
          const classes = new Set<string>();
          jobRelated.forEach((el) => {
            el.classList.forEach((c) => {
              if (c.includes('job')) classes.add(c);
            });
          });
          return {
            url: window.location.href,
            jobClasses: Array.from(classes).slice(0, 30),
            listItems: document.querySelectorAll('li').length,
          };
        });
        console.log('Debug — page URL:', debugInfo.url);
        console.log('Debug — job-related classes:', debugInfo.jobClasses.join(', '));
        console.log('Debug — total <li> elements:', debugInfo.listItems);

        await page.screenshot({
          path: path.join(__dirname, '../../data/debug-screenshot.png'),
        });
        console.log('No cards with content — screenshot saved');
        return [];
      }

      const toProcess = jobCards.slice(0, maxJobs);

      for (let i = 0; i < toProcess.length; i++) {
        const card = toProcess[i];
        if (!card) continue;

        try {
          // ── extract title ─────────────────────────────────────────────
          const rawTitle = await card
            .$eval(
              '.job-card-list__title--link, ' +
                'a[class*="job-card"][class*="title"], ' +
                '.job-card-container__link',
              (el: Element) => el.textContent?.trim() ?? '',
            )
            .catch(() => '');

          const title =
            rawTitle
              .split('\n')
              .map((l: string) => l.trim())
              .filter(Boolean)[0]
              ?.replace(/^(.+?)\1$/, '$1') // "FooFoo" → "Foo"
              ?.replace(/^(.+?)\s+\1$/, '$1') // "Foo Foo" → "Foo"
              ?.replace(/^(.{10,}?)\1.*$/, '$1') // longer duplicates
              .trim() ?? '';

          if (!title) {
            console.log(`  [${i + 1}] Skipping — could not extract title`);
            continue;
          }

          // ── extract company ───────────────────────────────────────────
          const company = await card
            .$eval(
              '.job-card-container__primary-description-without-tagline, ' +
                '.artdeco-entity-lockup__subtitle, ' +
                '.job-card-list__company-name',
              (el: Element) => el.textContent?.trim() ?? '',
            )
            .catch(async () => {
              return await card
                .$eval(
                  '.job-card-container__metadata-wrapper span',
                  (el: Element) => el.textContent?.trim() ?? '',
                )
                .catch(() => '');
            });

          // ── extract location ──────────────────────────────────────────
          const jobLocation = await card
            .$eval('.artdeco-entity-lockup__caption', (el: Element) => el.textContent?.trim() ?? '')
            .catch(() => '');

          // ── extract url ───────────────────────────────────────────────
          const jobUrl = await card
            .$eval(
              '.job-card-container__link, a[class*="job-card"], a[href*="/jobs/view/"]',
              (el: Element) => (el as HTMLAnchorElement).href ?? '',
            )
            .catch(() => '');

          console.log(`[${i + 1}/${toProcess.length}] ${title} @ ${company}`);
          console.log(`  Location: ${jobLocation}`);

          // ── click card to load description panel ──────────────────────
          const freshCards = await page.$$(cardSelectorStr);
          const freshCard = freshCards[jobCards.indexOf(card)];

          if (freshCard) {
            await freshCard.click().catch(async () => {
              // fallback — click via javascript
              await page.evaluate((el) => (el as HTMLElement).click(), freshCard);
            });
          } else {
            await card.click();
          }
          await randomDelay();

          await page
            .waitForSelector(
              '.jobs-description__content, .jobs-description-content, .jobs-description, [class*="jobs-description"]',
              {
                timeout: 10000,
              },
            )
            .catch(() => null);

          const description = await page
            .$eval(
              '.jobs-description__content, .jobs-description-content, .jobs-description, [class*="jobs-description"]',
              (el: Element) => el.textContent?.trim() ?? '',
            )
            .catch(() => '');

          const salaryText = await page
            .$eval(
              [
                '.job-details-jobs-unified-top-card__job-insight',
                '.jobs-unified-top-card__job-insight',
                '.compensation__salary',
              ].join(', '),
              (el: Element) => el.textContent?.trim() ?? '',
            )
            .catch(() => '');

          const salary = extractSalary(salaryText);
          const isRemote = [title, jobLocation, description]
            .join(' ')
            .toLowerCase()
            .includes('remote');

          // ── extract posted date ────────────────────────────────────────
          const postedText = await card
            .$eval(
              'time, .job-card-container__listed-time, .job-card-list__date, [class*="listed-time"]',
              (el: Element) => (el as HTMLTimeElement).dateTime || el.textContent?.trim() || '',
            )
            .catch(() => '');

          const postedAt = parsePostedDate(postedText);

          console.log(`  Description: ${description.length} chars`);
          console.log(`  Salary: ${salaryText || 'not listed'}`);

          jobs.push({
            id: crypto
              .createHash('md5')
              .update(jobUrl ? `linkedin-${jobUrl}` : `${company}-${title}`)
              .digest('hex')
              .slice(0, 10),
            title,
            company,
            location: jobLocation,
            remote: isRemote,
            employment_type: 'full-time',
            salary_min: salary.min,
            salary_max: salary.max,
            description,
            url: jobUrl,
            source: 'linkedin',
            scraped_at: new Date().toISOString(),
            posted_at: postedAt,
          });
        } catch (err) {
          console.error(`  Skipped card ${i + 1}:`, (err as Error).message);
        }

        await randomDelay();
      }

      await saveSession(context);
    } finally {
      await browser.close();
    }

    return jobs;
  }
}
