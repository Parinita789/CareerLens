import { Inject, Injectable } from '@nestjs/common';
import { chromium, type BrowserContext } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { ApplicationFieldsModel } from '@job-agent/shared';
import { TARGET_COMPANIES } from '../common/company-directory';
import { LinkedInProbeService } from './linkedin-probe.service';
import type { ScoredJob } from '../types';

// Diagnostic outcome of resolving a job's URL to a scrapable apply page.
// Returned alongside the resolved URL (or null) so the caller can log a
// specific reason when nothing makes it to applicationFields. Previously the
// scraper silently dropped LinkedIn / unsupported jobs — those were the bulk
// of high-score jobs not landing in the Prepare tab.
type ResolveOutcome =
  | { kind: 'ok'; url: string }
  | { kind: 'easy_apply' }
  | { kind: 'unsupported_host'; host: string }
  | { kind: 'probe_failed'; reason: string };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface ScrapedField {
  label: string;
  type: 'text' | 'textarea' | 'select' | 'radio' | 'file' | 'combobox';
  value: string;
  source: 'profile' | 'rule' | 'llm' | 'unknown';
  options: string[];
  fieldId: string;
  required: boolean;
}

function getGreenhouseUrl(job: ScoredJob): string | null {
  const ghJidMatch = job.url.match(/gh_jid=(\d+)/);
  if (!ghJidMatch) {
    if (job.url.includes('greenhouse.io')) return job.url;
    return null;
  }
  const jobId = ghJidMatch[1];
  const company = TARGET_COMPANIES.find((c) => c.name.toLowerCase() === job.company.toLowerCase());
  const slug = company?.slug || job.company.toLowerCase().replace(/[^a-z0-9]/g, '');
  return `https://job-boards.greenhouse.io/${slug}/jobs/${jobId}`;
}

interface ScrapeResult {
  fields: ScrapedField[];
  // Non-ok outcomes carry a reason the caller can surface so the user knows
  // why a high-score job didn't make it into applicationFields.
  outcome: ResolveOutcome | { kind: 'no_form' } | { kind: 'scrape_error'; reason: string };
}

@Injectable()
export class FormScraperService {
  constructor(@Inject(LinkedInProbeService) private readonly linkedInProbe: LinkedInProbeService) {}

  private async resolveApplyUrl(context: BrowserContext, job: ScoredJob): Promise<ResolveOutcome> {
    if (job.source === 'greenhouse') {
      return { kind: 'ok', url: getGreenhouseUrl(job) || job.url };
    }
    if (job.source !== 'linkedin') {
      // Ashby / Lever / Indeed / manual — try the URL as-is. The form scraper's
      // existing iframe-traversal logic still gets a shot at it.
      return { kind: 'ok', url: job.url };
    }

    // LinkedIn URLs (/jobs/view/...) aren't application forms — they're the
    // posting page. Use the same probe phase 4 uses to resolve the underlying
    // ATS URL, then route Greenhouse/Ashby targets into the form scraper.
    const probePage = await context.newPage();
    try {
      const probe = await this.linkedInProbe.probeLinkedInApplyTarget(probePage, job.url);
      if (probe.kind === 'easy_apply') return { kind: 'easy_apply' };
      if (probe.kind === 'unknown') return { kind: 'probe_failed', reason: probe.reason };
      const ats = this.linkedInProbe.classifyAts(probe.url);
      if (ats === 'unsupported') return { kind: 'unsupported_host', host: probe.host };
      return { kind: 'ok', url: probe.url };
    } finally {
      await probePage.close().catch(() => null);
    }
  }

  private async scrapeFormFields(context: BrowserContext, job: ScoredJob): Promise<ScrapeResult> {
    const fields: ScrapedField[] = [];

    const resolved = await this.resolveApplyUrl(context, job);
    if (resolved.kind !== 'ok') {
      return { fields, outcome: resolved };
    }

    const page = await context.newPage();
    try {
      const url = resolved.url;
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await sleep(1500);

      // Click Apply if needed
      if (!page.url().includes('greenhouse.io')) {
        const applyBtn = await page.$('a[href*="apply"], a:has-text("Apply"), button:has-text("Apply")');
        if (applyBtn) {
          await applyBtn.click();
          await sleep(2000);
        }
        const ghFrame = page.frames().find((f) => f.url().includes('greenhouse.io'));
        if (ghFrame) {
          await page.goto(ghFrame.url(), { waitUntil: 'domcontentloaded', timeout: 20000 });
          await sleep(1000);
        }
      }

      // Wait for form
      await page.waitForSelector('input[id="first_name"], form', { timeout: 10000 }).catch(() => null);

      // Extract all form fields — using string eval to avoid tsx __name injection
      const rawFields = await page.evaluate(`(() => {
        const results = [];
        const seen = new Set();
        const getLabel = (el, id) => {
          let label = el.getAttribute('aria-label') || '';
          if (!label && id) {
            const labelEl = document.querySelector('label[for="' + id + '"]');
            if (labelEl) {
              const clone = labelEl.cloneNode(true);
              clone.querySelectorAll('span, abbr, svg').forEach(n => n.remove());
              label = (clone.textContent || '').trim();
            }
          }
          if (!label) {
            const wrapper = el.closest('.field, [class*="field"], [class*="question"]');
            if (wrapper) {
              const wl = wrapper.querySelector('label, [class*="label"], legend');
              if (wl) {
                const clone = wl.cloneNode(true);
                clone.querySelectorAll('span, abbr, svg').forEach(n => n.remove());
                label = (clone.textContent || '').trim();
              }
            }
          }
          if (!label) label = id.replace(/[_-]/g, ' ').replace(/question \\d+/, '').trim();
          return label;
        };

        // Text/email/tel/url inputs
        document.querySelectorAll('input[type="text"], input[type="email"], input[type="tel"], input[type="url"], input[type="number"]').forEach(el => {
          if (el.offsetParent === null || el.role === 'combobox') return;
          const id = el.id || '';
          if (seen.has(id) && id) return;
          if (id) seen.add(id);
          const label = getLabel(el, id);
          if (label && label.length > 1 && label.length < 150) {
            results.push({ label, type: 'text', id, options: [] });
          }
        });

        // Textareas
        document.querySelectorAll('textarea').forEach(el => {
          if (el.offsetParent === null) return;
          const id = el.id || '';
          const label = getLabel(el, id);
          if (label && label.length > 1) {
            results.push({ label, type: 'textarea', id, options: [] });
          }
        });

        // Native selects
        document.querySelectorAll('select').forEach(el => {
          if (el.offsetParent === null) return;
          const id = el.id || '';
          if (seen.has(id) && id) return;
          if (id) seen.add(id);
          const label = getLabel(el, id);
          const opts = Array.from(el.querySelectorAll('option:not([value=""])'))
            .map(o => (o.text || '').trim())
            .filter(t => t && t.length < 200);
          if (label && label.length > 1) {
            results.push({ label, type: 'select', id, options: opts.length <= 100 ? opts : [] });
          }
        });

        // React Select comboboxes
        document.querySelectorAll('input[role="combobox"]').forEach(el => {
          const id = el.id || '';
          if (id.includes('iti') || id.includes('country-listbox')) return;
          if (seen.has(id) && id) return;
          if (id) seen.add(id);
          const label = getLabel(el, id);
          if (label && label.length > 1) {
            results.push({ label, type: 'combobox', id, options: [] });
          }
        });

        // Greenhouse custom question containers — catch fields the above missed
        document.querySelectorAll('[class*="custom-question"], [id^="custom_fields"], [id^="question_"]').forEach(container => {
          const id = container.id || '';
          if (seen.has(id) && id) return;
          const innerInput = container.querySelector('input, select, textarea');
          if (innerInput && seen.has(innerInput.id)) return;
          const labelEl = container.querySelector('label, [class*="label"], legend');
          if (!labelEl) return;
          const clone = labelEl.cloneNode(true);
          clone.querySelectorAll('span, abbr, svg').forEach(n => n.remove());
          const label = (clone.textContent || '').trim();
          if (!label || label.length < 2) return;
          const sel = container.querySelector('select');
          const cmb = container.querySelector('input[role="combobox"]');
          const ta = container.querySelector('textarea');
          const ti = container.querySelector('input[type="text"]');
          if (sel && !seen.has(sel.id || '')) {
            const opts = Array.from(sel.querySelectorAll('option:not([value=""])')).map(o => (o.text || '').trim()).filter(t => t && t.length < 200);
            results.push({ label, type: 'select', id: sel.id || id, options: opts.length <= 100 ? opts : [] });
            if (sel.id) seen.add(sel.id);
          } else if (cmb && !seen.has(cmb.id || '')) {
            results.push({ label, type: 'combobox', id: cmb.id || id, options: [] });
            if (cmb.id) seen.add(cmb.id);
          } else if (ta) {
            results.push({ label, type: 'textarea', id: ta.id || id, options: [] });
          } else if (ti && !seen.has(ti.id || '')) {
            results.push({ label, type: 'text', id: ti.id || id, options: [] });
            if (ti.id) seen.add(ti.id);
          }
        });

        // File inputs
        document.querySelectorAll('input[type="file"]').forEach(el => {
          const id = el.id || '';
          let label = id.includes('resume') ? 'Resume' : id.includes('cover') ? 'Cover Letter' : '';
          if (!label && id) {
            const labelEl = document.querySelector('label[for="' + id + '"]') || document.querySelector('#upload-label-' + id);
            if (labelEl) label = (labelEl.textContent || '').trim();
          }
          if (label) results.push({ label, type: 'file', id, options: [] });
        });

        // Radio groups
        document.querySelectorAll('fieldset').forEach(fieldset => {
          const legend = (fieldset.querySelector('legend')?.textContent || '').trim();
          if (!legend) return;
          const labels = Array.from(fieldset.querySelectorAll('label'))
            .map(l => (l.textContent || '').trim())
            .filter(t => t && t.length < 100);
          if (labels.length > 0) {
            results.push({ label: legend, type: 'radio', id: '', options: labels });
          }
        });

        return results;
      })()`) as { label: string; type: string; id: string; options: string[] }[];

      // Read combobox options by clicking each one to open the dropdown
      for (const field of rawFields) {
        if (field.type === 'combobox' && field.id) {
          try {
            // Use attribute selector — safe for IDs starting with numbers
            const combo = await page.$(`[id="${field.id}"]`);
            if (!combo) continue;

            // Get aria-controls to scope the menu
            const menuId = await combo.getAttribute('aria-controls').catch(() => '') || '';

            // Click to open dropdown
            await combo.click({ timeout: 3000 });
            await sleep(500);

            // Read options — scoped to this combobox's menu if possible
            const escapedMenuId = JSON.stringify(menuId);
            const opts = await page.evaluate(`(() => {
              // Try scoped menu first (aria-controls)
              const menuId = ${escapedMenuId};
              if (menuId) {
                const menu = document.getElementById(menuId);
                if (menu) {
                  const opts = menu.querySelectorAll('[class*="option"], [role="option"]');
                  if (opts.length > 0) {
                    return Array.from(opts).map(el => (el.textContent || '').trim()).filter(t => t.length > 0 && t.length < 200);
                  }
                }
              }
              // Fallback: find the last visible menu (most recently opened)
              const menus = document.querySelectorAll('[class*="select__menu"], [role="listbox"]');
              const visible = Array.from(menus).filter(m => m.offsetParent !== null);
              if (visible.length > 0) {
                const menu = visible[visible.length - 1];
                const opts = menu.querySelectorAll('[class*="option"], [role="option"]');
                if (opts.length > 0) {
                  const items = Array.from(opts).map(el => (el.textContent || '').trim()).filter(t => t.length > 0 && t.length < 200);
                  // Skip if these are phone code options
                  if (items.some(t => /\\+\\d{1,3}$/.test(t))) return [];
                  return items;
                }
              }
              return [];
            })()`).catch(() => [] as string[]);

            field.options = opts as string[];
            await page.keyboard.press('Escape');
            await sleep(200);
          } catch (err) {
            // Log but continue — don't silently lose all options
            console.log(`      Options read failed for "${field.label}": ${(err as Error).message?.slice(0, 50)}`);
          }
        }
      }

      // Also read native select options that might have been missed
      for (const field of rawFields) {
        if (field.type === 'select' && field.id && field.options.length === 0) {
          try {
            const opts = await page.evaluate(`(() => {
              const sel = document.getElementById('${field.id}');
              if (!sel) return [];
              return Array.from(sel.querySelectorAll('option')).map(o => (o.text || '').trim()).filter(t => t.length > 0 && t !== '');
            })()`).catch(() => [] as string[]);
            field.options = opts as string[];
          } catch { /* skip */ }
        }
      }

      // Convert to ScrapedField — detect required from label (* anywhere) or known required fields
      const alwaysRequired = ['first name', 'last name', 'email', 'phone', 'resume',
        'sponsorship', 'visa', 'authorized to work', 'work authorization', 'country', 'gender'];
      for (const raw of rawFields) {
        const hasAsterisk = raw.label.includes('*');
        const cleanLabel = raw.label.replace(/\*/g, '').replace(/\s+/g, ' ').trim();
        const isRequired = hasAsterisk || alwaysRequired.some((r) => cleanLabel.toLowerCase().includes(r));
        fields.push({
          label: cleanLabel,
          type: raw.type as ScrapedField['type'],
          value: '',
          source: 'unknown',
          options: raw.options,
          fieldId: raw.id,
          required: isRequired,
        });
      }

      // Filter out phone country code pickers and garbage fields
      const filtered = fields.filter((f) => {
        // Phone code picker: options contain "+\d+" patterns
        if (f.options.length > 0 && f.options.some((o) => /\+\d{1,3}$/.test(o))) {
          console.log(`      Filtered out phone code picker: "${f.label}"`);
          return false;
        }
        // Label is just "Phone*" or "Country*" from a radio group (not real fields)
        if (f.type === 'radio' && f.options.some((o) => o === 'Phone*' || o === 'Country*')) {
          console.log(`      Filtered out phone radio: "${f.label}"`);
          return false;
        }
        return true;
      });
      fields.length = 0;
      fields.push(...filtered);
    } catch (err) {
      await page.close().catch(() => {});
      return { fields, outcome: { kind: 'scrape_error', reason: (err as Error).message } };
    }
    await page.close().catch(() => {});

    if (fields.length === 0) return { fields, outcome: { kind: 'no_form' } };
    return { fields, outcome: { kind: 'ok', url: resolved.url } };
  }

  /**
   * Scrape form fields for multiple jobs in parallel
   */
  async scrapeApplicationForms(
    jobs: ScoredJob[],
    // Lowered from 5 → 3 because LinkedIn jobs now run an Apply-button probe
    // (popup capture + redirect chain). Five concurrent LinkedIn popups was
    // tripping rate limits on the scrape session.
    parallel: number = 3,
  ): Promise<void> {
    if (jobs.length === 0) return;

    console.log(`\n  Pre-scraping application forms for ${jobs.length} jobs (${parallel} parallel)...`);

    const browser = await chromium.launch({
      headless: true,
      args: ['--disable-blink-features=AutomationControlled'],
    });

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    });

    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    // Load sessions
    const sessionFile = path.join(__dirname, '../../data/linkedin-session.json');
    if (fs.existsSync(sessionFile)) {
      const cookies = JSON.parse(fs.readFileSync(sessionFile, 'utf-8'));
      await context.addCookies(cookies);
    }
    const ghSessionFile = path.join(__dirname, '../../data/greenhouse-session.json');
    if (fs.existsSync(ghSessionFile)) {
      const cookies = JSON.parse(fs.readFileSync(ghSessionFile, 'utf-8'));
      await context.addCookies(cookies);
    }

    // Process in parallel batches
    for (let i = 0; i < jobs.length; i += parallel) {
      const batch = jobs.slice(i, i + parallel);

      const results = await Promise.all(
        batch.map(async (job) => {
          try {
            const r = await this.scrapeFormFields(context, job);
            return { job, ...r };
          } catch (err) {
            return {
              job,
              fields: [] as ScrapedField[],
              outcome: { kind: 'scrape_error', reason: (err as Error).message } as const,
            };
          }
        }),
      );

      for (const { job, fields, outcome } of results) {
        if (outcome.kind !== 'ok' || fields.length === 0) {
          const why =
            outcome.kind === 'easy_apply'        ? 'LinkedIn Easy Apply (no pre-scrape possible)' :
            outcome.kind === 'unsupported_host'  ? `external host ${outcome.host} not supported` :
            outcome.kind === 'probe_failed'      ? `LinkedIn probe failed: ${outcome.reason}` :
            outcome.kind === 'scrape_error'      ? `scrape error: ${outcome.reason}` :
                                                    'no form found';
          console.log(`    ○ ${job.company} [${job.source}] — ${why}`);
          continue;
        }

        // Pre-answer fields
        const { preAnswerFields } = await import('../answer-resolution/form-pre-answerer.service');
        const answered = await preAnswerFields(fields, job);
        const unknownCount = answered.filter((f) => f.source === 'unknown' && f.type !== 'file' && f.required).length;
        const status = unknownCount === 0 ? 'ready' : 'needs_review';

        // Use an existing (manually-generated) cover letter if there is one — never generate one here.
        let coverLetter = '';
        const { CoverLetterModel } = await import('../persistence/db');
        const existingCL = await CoverLetterModel.findOne({ externalJobId: job.id }).lean().catch(() => null);
        if (existingCL) {
          coverLetter = (existingCL as any).content || '';
        }

        await ApplicationFieldsModel.findOneAndUpdate(
          { externalJobId: job.id },
          {
            $set: {
              title: job.title,
              company: job.company,
              source: job.source,
              url: job.url,
              status,
              fields: answered,
              unknownCount,
              coverLetter,
              scrapedAt: new Date(),
            },
          },
          { upsert: true },
        );

        const icon = status === 'ready' ? '✓' : '⚠';
        console.log(`    ${icon} ${job.company} — ${fields.length} fields, ${unknownCount} unknown`);
      }

      if (i + parallel < jobs.length) await sleep(500);
    }

    await browser.close();
  }
}
