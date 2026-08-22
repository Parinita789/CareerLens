import { Injectable } from '@nestjs/common';
import { chromium, type Browser } from 'playwright';
import * as crypto from 'crypto';
import * as path from 'path';
import { fileURLToPath } from 'url';
import type { JobListing } from '../types';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const randomDelay = () => sleep(2000 + Math.random() * 3000);

function buildIndeedURL(keywords: string, location: string): string {
  const params = new URLSearchParams({
    q: keywords,
    l: location,
    fromage: '7',
    sort: 'date',
    sc: '0kf:jt(fulltime);',
  });
  return `https://www.indeed.com/jobs?${params.toString()}`;
}

function extractSalary(text: string): { min?: number; max?: number } {
  const rangeMatch = text.match(/\$?([\d,]+)[kK]?\s*[-–to]+\s*\$?([\d,]+)[kK]?/);
  if (rangeMatch) {
    const hasK = text.toLowerCase().includes('k');
    let min = parseInt(rangeMatch[1].replace(/,/g, ''), 10);
    let max = parseInt(rangeMatch[2].replace(/,/g, ''), 10);
    if (hasK || min < 1000) { min *= 1000; max *= 1000; }
    return { min, max };
  }

  const singleMatch = text.match(/\$?([\d,]+)[kK]?\s*(?:a year|\/yr|per year|annually)/i);
  if (singleMatch) {
    let val = parseInt(singleMatch[1].replace(/,/g, ''), 10);
    if (val < 1000) val *= 1000;
    return { min: val, max: val };
  }

  return {};
}

async function scrapeIndeedPage(
  browser: Browser,
  keywords: string,
  location: string,
  maxJobs: number,
): Promise<JobListing[]> {
  const jobs: JobListing[] = [];
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 },
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });

  const page = await context.newPage();

  try {
    const url = buildIndeedURL(keywords, location);
    console.log(`  Navigating: ${url}`);

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await randomDelay();

    // Check for CAPTCHA / block
    const blocked = await page.$('#challenge-stage, .captcha-container, [data-testid="captcha"]');
    if (blocked) {
      console.log('  Indeed CAPTCHA detected — skipping this query');
      return jobs;
    }

    // Wait for job results to load
    await page
      .waitForSelector('.jobsearch-ResultsList, #mosaic-jobResults, .job_seen_beacon, .tapItem', { timeout: 15000 })
      .catch(() => null);

    // Extra wait for dynamic rendering
    await sleep(2000);

    // Extract jobs by finding all viewjob links and walking up to their card containers
    const cardData = await page.evaluate(() => {
      const results: { title: string; company: string; location: string; salary: string; url: string; jk: string }[] = [];
      const seen = new Set<string>();

      // Strategy: find all links that point to job pages, then extract data from their card ancestor
      const allLinks = document.querySelectorAll('a[href*="/viewjob"], a[href*="/rc/clk"], a[href*="jk="]');

      allLinks.forEach((linkEl) => {
        const a = linkEl as HTMLAnchorElement;
        const href = a.href || '';

        // Extract jk from URL
        let jk = '';
        const jkMatch = href.match(/jk=([a-f0-9]+)/i);
        if (jkMatch) jk = jkMatch[1];
        if (!jk) {
          const viewjobMatch = href.match(/\/viewjob\?.*?jk=([a-f0-9]+)/i);
          if (viewjobMatch) jk = viewjobMatch[1];
        }

        if (jk && seen.has(jk)) return;
        if (jk) seen.add(jk);

        // The link text is usually the job title
        const title = a.textContent?.trim() || '';
        if (!title || title.length < 3 || title.length > 200) return;

        // Walk up to find the card container (usually 5-7 levels up)
        let card: Element | null = a;
        for (let i = 0; i < 8; i++) {
          card = card?.parentElement || null;
          if (!card) break;
          // Card container is usually a div or li with substantial content
          if (card.children.length >= 2 && card.textContent && card.textContent.length > title.length + 20) {
            break;
          }
        }
        if (!card) return;

        // Company: find text that's not the title, not a link, in a small container
        let company = '';
        const skipWords = [
          'apply', 'easily', 'easily apply', 'save', 'ago', 'posted', 'new',
          'hiring', 'urgently', 'urgently hiring', 'active', 'just posted',
          'responded', 'often replies', 'replies', 'days', 'today', 'employer',
          'full-time', 'part-time', 'contract', 'temporary', 'remote', 'hybrid',
        ];
        const allText = card.querySelectorAll('span, div, a');
        for (const el of allText) {
          if (el === a) continue;
          const text = el.textContent?.trim() || '';
          const textLower = text.toLowerCase();
          // Company names are typically short, not the title, and not generic UI text
          if (text && text !== title && text.length > 1 && text.length < 80
            && !text.includes('$') && !text.includes('ago')
            && !skipWords.some((w) => textLower === w || textLower.startsWith(w))
            && !textLower.match(/^\d+\s?(day|hour|minute)/)
            && !textLower.includes('replies in')
            && !textLower.includes('responded to')
            && el.children.length === 0) {
            company = text;
            break;
          }
        }

        // Location: look for location-like text
        let location = '';
        for (const el of allText) {
          const text = el.textContent?.trim() || '';
          if (text && text !== title && text !== company
            && (text.includes(',') || text.toLowerCase().includes('remote') || text.match(/[A-Z]{2}\s/))
            && text.length < 80 && el.children.length === 0) {
            location = text;
            break;
          }
        }

        // Salary: look for dollar amounts
        let salary = '';
        for (const el of allText) {
          const text = el.textContent?.trim() || '';
          if (text.includes('$') && text.length < 100) {
            salary = text;
            break;
          }
        }

        const url = jk ? `https://www.indeed.com/viewjob?jk=${jk}` : href;

        if (title && company) {
          results.push({ title, company, location, salary, url, jk });
        }
      });

      return results;
    });

    console.log(`  Found ${cardData.length} job cards`);

    if (cardData.length === 0) {
      const debugPath = path.join(__dirname, '../../data/debug-indeed.png');
      await page.screenshot({ path: debugPath, fullPage: true }).catch(() => null);
      console.log(`  No cards found — saved debug screenshot to data/debug-indeed.png`);
      return jobs;
    }

    const limit = Math.min(cardData.length, maxJobs);

    // Build job objects from card data (fast — no page clicks)
    for (let i = 0; i < limit; i++) {
      try {
        const { title, company, location: jobLocation, salary: salaryText, jk } = cardData[i];

        // Skip cards with bad company names
        if (!company || company.length < 2) continue;

        const salary = extractSalary(salaryText);
        const isRemote = [title, jobLocation].join(' ').toLowerCase().includes('remote');
        const cleanUrl = jk ? `https://www.indeed.com/viewjob?jk=${jk}` : '';

        console.log(`  ${i + 1}. ${title} @ ${company}`);

        jobs.push({
          id: crypto
            .createHash('md5')
            .update(`indeed-${jk || `${company}-${title}`}`)
            .digest('hex')
            .slice(0, 10),
          title,
          company,
          location: jobLocation,
          remote: isRemote,
          employment_type: 'full-time',
          salary_min: salary.min,
          salary_max: salary.max,
          description: '',
          url: cleanUrl,
          source: 'indeed',
          scraped_at: new Date().toISOString(),
        });
      } catch (err) {
        console.error(`  Skipped card ${i + 1}:`, (err as Error).message);
      }
    }

    // Fetch descriptions by visiting each job page
    console.log(`  Fetching descriptions for ${jobs.length} jobs...`);
    for (const job of jobs) {
      if (!job.url) continue;
      try {
        await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await sleep(500 + Math.random() * 500);
        const desc = await page.evaluate(() => {
          const el = document.querySelector('#jobDescriptionText, [class*="jobDescription"], [class*="job-description"]');
          return el?.textContent?.trim() ?? '';
        });
        job.description = desc;
      } catch {
        // keep empty description
      }
    }
  } catch (err) {
    console.error(`  Indeed scrape failed:`, (err as Error).message);
  } finally {
    await context.close();
  }

  return jobs;
}

@Injectable()
export class IndeedService {
  async scrapeIndeed(keywords: string, location: string, maxJobs: number = 25): Promise<JobListing[]> {
    const browser = await chromium.launch({
      headless: true,
      args: ['--disable-blink-features=AutomationControlled'],
    });

    try {
      return await scrapeIndeedPage(browser, keywords, location, maxJobs);
    } finally {
      await browser.close();
    }
  }
}
