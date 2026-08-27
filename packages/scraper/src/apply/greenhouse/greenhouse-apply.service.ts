import { Inject, Injectable } from '@nestjs/common';
import { ApplyTaskContextService } from '../apply-task-context.service';
import type { Page } from 'playwright';
import * as path from 'path';
import { fileURLToPath } from 'url';
import type { ScoredJob } from '../../types';
import { GreenhouseUrlResolverService } from './greenhouse-url-resolver.service';
import { GreenhouseAttachmentService } from './greenhouse-attachment.service';
import { GreenhouseFormFillerService } from './greenhouse-form-filler.service';
import { GreenhouseSubmissionWatcherService } from './greenhouse-submission-watcher.service';
import { GreenhouseFormCaptureService } from './greenhouse-form-capture.service';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type ApplicationResult =
  | { success: true; method: 'greenhouse' }
  | { success: false; reason: string };

@Injectable()
export class GreenhouseApplyService {
  constructor(
    @Inject(GreenhouseUrlResolverService) private readonly urlResolver: GreenhouseUrlResolverService,
    @Inject(GreenhouseAttachmentService) private readonly attachment: GreenhouseAttachmentService,
    @Inject(GreenhouseFormFillerService) private readonly formFiller: GreenhouseFormFillerService,
    @Inject(GreenhouseSubmissionWatcherService) private readonly submissionWatcher: GreenhouseSubmissionWatcherService,
    @Inject(GreenhouseFormCaptureService) private readonly formCapture: GreenhouseFormCaptureService,
    @Inject(ApplyTaskContextService) private readonly taskContext: ApplyTaskContextService,
  ) {}

  async apply(page: Page, job: ScoredJob, submit: boolean = false): Promise<ApplicationResult> {
  try {
    let targetUrl: string;

    if (job.source === 'ashby' && job.url.includes('ashbyhq.com')) {
      // Ashby: navigate directly to the application page
      targetUrl = job.url.endsWith('/application') ? job.url : `${job.url}/application`;
      console.log(`  Navigating to Ashby application: ${targetUrl}`);
    } else {
      // Greenhouse: build direct URL if possible
      const directUrl = this.urlResolver.getGreenhouseDirectUrl(job);
      targetUrl = directUrl || job.url;
      console.log(`  Navigating to: ${targetUrl}`);
    }

    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(1500);

    // If we landed on a company page (not Greenhouse/Ashby form), click Apply
    if (!page.url().includes('greenhouse.io') && !page.url().includes('/application')) {
      const applyBtn = await page.$(
        'a[href*="apply"], a[href*="#app"], a[href*="application"], a:has-text("Apply for this job"), a:has-text("Apply Now"), a:has-text("Apply"), button:has-text("Apply")',
      );
      if (applyBtn) {
        console.log('  Clicking Apply button...');
        await applyBtn.click();
        await sleep(1500);
      }

      // Check if the form is in an iframe
      const ghFrame = page.frames().find((f) => f.url().includes('greenhouse.io'));
      if (ghFrame) {
        console.log('  Found Greenhouse iframe — switching to it');
        const iframeUrl = ghFrame.url();
        await page.goto(iframeUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await sleep(1000);
      }
    }

    // Wait for form — Greenhouse uses first_name, Ashby uses _systemfield_name or generic input
    const nameField = await page
      .waitForSelector(
        'input[id="first_name"], input[id="firstname"], input[name*="first_name"], input[name*="name"][type="text"], form input[type="text"]',
        {
          timeout: 15000,
        },
      )
      .catch(() => null);
    if (!nameField) {
      console.log('  No application form found');
      await page
        .screenshot({ path: path.join(__dirname, '../../../data/debug-apply.png') })
        .catch(() => null);
      return { success: false, reason: 'No application form found on page' };
    }

    console.log('  Application form found');

    // ── Try "Autofill with MyGreenhouse" ──
    const autofillBtn = await page.$(
      'button:has-text("Autofill with"), button:has-text("MyGreenhouse"), button:has-text("Autofill")',
    );
    if (autofillBtn) {
      const btnText = await autofillBtn.textContent().catch(() => '');
      console.log(`  Found autofill button: "${btnText?.trim()}" — clicking...`);
      await autofillBtn.click();
      await sleep(1500);

      // Check if it triggered login or directly filled
      const firstNameValue = await page.$eval('#first_name', (el: any) => el.value).catch(() => '');
      if (firstNameValue) {
        console.log(`  ✓ Autofill worked — first name: "${firstNameValue}"`);
      } else {
        // May need login — wait for user
        console.log('  ⏸ Autofill may need login — waiting...');
        await page
          .waitForFunction(
            () => {
              const el = document.querySelector('#first_name') as HTMLInputElement;
              return el && el.value.length > 0;
            },
            { timeout: 60000 },
          )
          .catch(() => {
            console.log('  Autofill timed out — will fill manually');
          });
      }
      await sleep(500);
    } else {
      console.log('  No Autofill button found — filling manually...');
    }

    // Cover letters are pre-generated in auto-apply before browser launch

    // Fill form — wrap in try/catch so errors don't kill the watch loop
    try {
      await this.attachment.handleResumeUpload(page);
      await this.attachment.handleCoverLetterField(page, job);
      console.log('  Filling form fields...');
      await this.formFiller.fillFormFields(page, job);
    } catch (err) {
      console.log(`  ⚠ Form fill error (continuing to watch): ${(err as Error).message}`);
    }

    // Check for empty required fields
    try {
      const emptyRequired = await page.evaluate(() => {
        const empties: string[] = [];
        document.querySelectorAll('input, textarea, select').forEach((el: any) => {
          if (el.offsetParent === null) return; // hidden
          if (el.type === 'file' || el.type === 'hidden' || el.type === 'submit') return;
          if (el.role === 'combobox') return;
          const val = el.value?.trim() || '';
          if (!val) {
            const id = el.id || '';
            const label = el.getAttribute('aria-label') || id || el.name || '?';
            const tag = el.tagName?.toLowerCase() || '?';
            const role = el.role || '';
            const type = el.type || '';
            empties.push(
              `${label} [${tag}${type ? ':' + type : ''}${role ? ' role=' + role : ''}]`,
            );
          }
        });
        return empties;
      });

      if (emptyRequired.length > 0) {
        console.log(`  ⚠ ${emptyRequired.length} empty fields: ${emptyRequired.join(', ')}`);
      } else {
        console.log('  ✓ All visible fields filled');
      }
    } catch (err) {
      console.log(`  ⚠ Field check error (continuing): ${(err as Error).message}`);
    }

    // ── Auto-submit the form ──
    this.submissionWatcher.setFormPageUrl(page.url());

    // Capture answers before submitting
    try {
      await this.formCapture.captureFormAnswers(page, job);
    } catch {
      /* skip */
    }

    // Click submit button — gated on the `submit` flag threaded through from the UI.
    // When `submit=false`, the form gets filled but we DO NOT click Submit. Instead
    // of returning immediately (which would close the tab and move to the next job),
    // we fall through to the watching loop below so the window stays open: the user
    // can review and manually submit, and we'll detect that submission or the tab
    // closing.
    const skipSubmit = !submit;
    if (skipSubmit) {
      console.log('  ✓ Form filled (submit disabled). Review mode — window stays open.');
      console.log('  Either click Submit manually to complete this application, or close the tab to move to the next job.');
      // Snapshot the final form state for diagnostics
      try {
        // Comprehensive snapshot: detects unfilled required fields (text, textarea, select, combobox, radio groups)
        const snapshotScript = `
          (() => {
            const results = [];
            const seen = new Set();
            // Check each visible form field
            document.querySelectorAll('input, textarea, select').forEach((el) => {
              if (el.offsetParent === null) return;
              if (el.type === 'file' || el.type === 'hidden' || el.type === 'submit') return;
              if (el.type === 'radio' || el.type === 'checkbox') return;
              // Skip phone country picker input (always empty, managed by widget)
              if (el.id === 'country' && el.type === 'text') return;
              const role = el.getAttribute('role');
              // For React Select combobox inputs — check outer shell for value-container--has-value
              if (role === 'combobox') {
                const shell = el.closest('[class*="select-shell"], [class*="select__container"], [class*="select__control"]');
                if (shell) {
                  const filledContainer = shell.querySelector('[class*="value-container"][class*="has-value"], [class*="value-container--has-value"]');
                  if (filledContainer && (filledContainer.textContent || '').trim()) return;
                  const sv = shell.querySelector('[class*="single-value"], [class*="singleValue"], [class*="multi-value"], [class*="multiValue"]');
                  if (sv && (sv.textContent || '').trim()) return;
                  const hiddenInput = shell.querySelector('input[type="hidden"]');
                  if (hiddenInput && hiddenInput.value) return;
                }
              }
              const val = (el.value || '').trim();
              if (val) return;
              // For native <select>, check option:checked with non-empty value
              if (el.tagName === 'SELECT') {
                const checked = el.querySelector('option:checked');
                if (checked && checked.value) return;
              }
              // Get label
              const wrapper = el.closest('[class*="field"], [class*="Field"], .field, fieldset');
              let label = '';
              if (wrapper) {
                const labelEl = wrapper.querySelector('label, legend');
                label = labelEl ? (labelEl.textContent || '').trim() : '';
              }
              if (!label) label = el.getAttribute('aria-label') || '';
              if (!label) label = el.placeholder || '';
              const required = (label.includes('*') || el.required || el.getAttribute('aria-required') === 'true');
              const key = (el.id || '') + ':' + label.slice(0, 40);
              if (seen.has(key)) return;
              seen.add(key);
              results.push({
                id: el.id || '',
                tag: el.tagName + ':' + (el.type || role || ''),
                label: label.slice(0, 80),
                required,
              });
            });
            // Check radio groups that aren't selected
            const radioGroups = {};
            document.querySelectorAll('input[type="radio"]').forEach((el) => {
              const name = el.name || el.id;
              if (!name) return;
              if (!radioGroups[name]) radioGroups[name] = { any: el, checked: false };
              if (el.checked) radioGroups[name].checked = true;
            });
            for (const name in radioGroups) {
              if (radioGroups[name].checked) continue;
              const el = radioGroups[name].any;
              let node = el.parentElement;
              let label = '';
              for (let i = 0; i < 10 && node; i++) {
                const legend = node.querySelector('legend');
                if (legend) { label = (legend.textContent || '').trim(); break; }
                const labels = node.querySelectorAll(':scope > label');
                let found = false;
                for (const l of Array.from(labels)) {
                  if (!l.querySelector('input')) { label = (l.textContent || '').trim(); found = true; break; }
                }
                if (found) break;
                node = node.parentElement;
              }
              // Skip garbage phone radio groups
              if (label === 'Phone' || label === 'Country') continue;
              const required = label.includes('*');
              results.push({ id: name, tag: 'RADIO_GROUP', label: label.slice(0, 80), required });
            }
            // Check checkbox groups that aren't selected (multi-select questions)
            const checkboxGroups = {};
            document.querySelectorAll('input[type="checkbox"]').forEach((el) => {
              const name = el.name || el.id;
              if (!name) return;
              if (!checkboxGroups[name]) checkboxGroups[name] = { any: el, anyChecked: false };
              if (el.checked) checkboxGroups[name].anyChecked = true;
            });
            for (const name in checkboxGroups) {
              if (checkboxGroups[name].anyChecked) continue;
              const el = checkboxGroups[name].any;
              const wrapper = el.closest('fieldset, [class*="field"], [class*="Field"]');
              const labelEl = wrapper ? wrapper.querySelector('label, legend') : null;
              const label = labelEl ? (labelEl.textContent || '').trim() : '';
              const required = label.includes('*') || (wrapper && (wrapper.querySelector('[class*="required"], [aria-required="true"]') !== null));
              results.push({ id: name, tag: 'CHECKBOX_GROUP', label: label.slice(0, 80), required });
            }
            return results;
          })()`;
        const unfilled = (await page.evaluate(snapshotScript).catch(() => [])) as any[];
        console.log(`  === UNFILLED FIELDS (${unfilled.length}) ===`);
        for (const f of unfilled) {
          console.log(`    ${f.required ? '[REQ]' : '[opt]'} ${f.tag} "${f.label}" id=${f.id}`);
        }
      } catch {}
      // fall through to watching loop — no return, no submit click.
    } else {
      const submitBtn = await page.$(
        'form button[type="submit"], button:has-text("Submit Application"), button:has-text("Submit")',
      );
      if (submitBtn) {
        console.log('  Clicking Submit...');
        // Stamped before the click, not after: everything past this point may
        // already have reached the employer, so the task must never be retried
        // automatically even if this process dies mid-submit.
        await this.taskContext.markSubmitAttempted();
        await submitBtn.click();
        await sleep(3000);

        const success = await this.submissionWatcher.detectSubmissionSuccess(page);
        if (success) {
          console.log('  ✓ Application submitted successfully!');
          return { success: true, method: 'greenhouse' };
        }
        console.log('  Submit clicked — waiting for confirmation...');
      } else {
        console.log('  No submit button found — watching for manual submission...');
      }
    }

    console.log('  (Watching for submission confirmation...)');

    const maxWait = 30 * 60 * 1000;
    const start = Date.now();
    let pollCount = 0;
    let answersCaptured = false;

    while (Date.now() - start < maxWait) {
      await sleep(3000);
      pollCount++;

      try {
        // Detect if page/browser was closed
        if (page.isClosed()) {
          console.log('  Page closed by user. Moving to next job.');
          return { success: false, reason: 'Page closed by user' };
        }

        const currentUrl = page.url();
        if (!currentUrl || currentUrl === 'about:blank') continue;

        // Check for submission
        const pageSuccess = await this.submissionWatcher.detectSubmissionSuccess(page);
        if (pageSuccess) {
          console.log('  ✓ Submission detected!');
          console.log('  Waiting 15s for verification code...');
          await sleep(15000);
          return { success: true, method: 'greenhouse' };
        }

        // Capture answers ONCE when form is still visible (just before user submits)
        // Overwrite previous capture, don't append
        if (!answersCaptured) {
          const formExists = await page
            .$('input[id="first_name"], form button[type="submit"]')
            .catch(() => null);
          if (formExists) {
            // Wait 30s before first capture — let user fill fields
            if (Date.now() - start > 30000) {
              await this.formCapture.captureFormAnswers(page, job);
              answersCaptured = true;
            }
          }
        }

        // Log every 30 polls (~90s)
        if (pollCount % 30 === 0) {
          const elapsed = Math.round((Date.now() - start) / 60000);
          console.log(`  ... still watching (${elapsed} min elapsed)`);
          // Re-capture in case user filled more fields
          const formExists = await page.$('form button[type="submit"]').catch(() => null);
          if (formExists) {
            await this.formCapture.captureFormAnswers(page, job);
          }
        }
      } catch (err) {
        const msg = (err as Error).message || '';
        if (msg.includes('closed') || msg.includes('destroyed') || msg.includes('disposed')) {
          console.log('  Page/browser closed. Moving to next job.');
          return { success: false, reason: 'Page closed by user' };
        }
        console.log(`  Watch error (continuing): ${msg}`);
      }
    }

    // Timed out
    console.log('  ⏰ Timed out (30 min). Moving to next job.');
    return { success: false, reason: 'Timed out waiting for submission' };
  } catch (err) {
    console.log(`  ✗ CRITICAL ERROR — this is why the browser closed: ${(err as Error).message}`);
    console.log(`  Stack: ${(err as Error).stack?.slice(0, 300)}`);
    await page
      .screenshot({ path: path.join(__dirname, '../../../data/debug-greenhouse-apply.png') })
      .catch(() => null);
    return { success: false, reason: (err as Error).message };
  }
}
}
