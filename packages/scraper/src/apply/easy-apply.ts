import { Page } from 'playwright';
import * as fs from 'fs';
import { PATHS } from '../config';
import type { ScoredJob } from '../types';
import { handleFormFields } from './form-handler';
import { setCurrentJob } from '../scorer/question-answerer';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const randomDelay = () => sleep(1500 + Math.random() * 2000);

export type ApplicationResult =
  | { success: true; method: 'easy_apply' }
  | { success: false; reason: string };

export async function applyViaEasyApply(page: Page, job: ScoredJob, submit: boolean = false): Promise<ApplicationResult> {
  try {
    // ── Step 1: navigate to job page ──────────────────────────────
    console.log(`  Navigating to job page...`);
    await page.goto(job.url, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await randomDelay();

    // ── Step 2: find Easy Apply button ────────────────────────────
    const easyApplyBtn = await page.$(
      'button[aria-label*="Easy Apply"], ' + '.jobs-apply-button--top-card',
    );

    if (!easyApplyBtn) {
      return {
        success: false,
        reason: 'No Easy Apply button — redirects to external site',
      };
    }

    const btnText = (await easyApplyBtn.textContent()) ?? '';
    if (!btnText.toLowerCase().includes('easy apply')) {
      return {
        success: false,
        reason: 'Apply button found but not Easy Apply',
      };
    }

    console.log('  Easy Apply button found — opening form...');
    setCurrentJob({ id: job.id, title: job.title, company: job.company });
    await easyApplyBtn.click();
    await randomDelay();

    // ── Step 3: loop through form steps ───────────────────────────
    let stepCount = 0;
    const MAX_STEPS = 10;

    while (stepCount < MAX_STEPS) {
      stepCount++;
      console.log(`\n  Form step ${stepCount}:`);

      // wait for modal
      await page
        .waitForSelector('.jobs-easy-apply-modal, [data-test-modal]', { timeout: 10000 })
        .catch(() => null);

      await randomDelay();

      // ── check for submit button ────────────────────────────────
      const submitBtn = await page.$(
        'button[aria-label*="Submit application"], ' + 'button[aria-label*="submit"]',
      );

      if (submitBtn) {
        if (!submit) {
          console.log('  Review step reached — SUBMIT DISABLED (dry-run). Form filled; stopping before click.');
          return { success: false, reason: 'Submit disabled — review mode' };
        }
        console.log('  Review step — submitting application...');
        await submitBtn.click();
        await randomDelay();
        console.log('  Submitted!');
        return { success: true, method: 'easy_apply' };
      }

      // ── check for resume upload ────────────────────────────────
      const resumeInput = await page.$(
        'input[type="file"][name*="resume"], ' + 'input[type="file"][accept*="pdf"]',
      );

      if (resumeInput) {
        if (!fs.existsSync(PATHS.resume)) {
          return {
            success: false,
            reason: `Resume PDF not found at ${PATHS.resume}`,
          };
        }
        console.log('  Uploading resume...');
        await resumeInput.setInputFiles(PATHS.resume);
        await randomDelay();
      }

      // ── fill all form fields on this step ─────────────────────
      await handleFormFields(page);
      await randomDelay();

      // ── click Next ─────────────────────────────────────────────
      const nextBtn = await page.$(
        'button[aria-label="Continue to next step"], ' +
          'button[aria-label*="Next"], ' +
          'button[data-easy-apply-next-button]',
      );

      if (!nextBtn) {
        await page.screenshot({
          path: `packages/scraper/data/debug-stuck-step-${stepCount}.png`,
        });
        return {
          success: false,
          reason: `Stuck on step ${stepCount} — no Next or Submit button found`,
        };
      }

      console.log('  Clicking Next...');
      await nextBtn.click();
      await randomDelay();
    }

    return {
      success: false,
      reason: `Exceeded ${MAX_STEPS} steps — form too complex`,
    };
  } catch (err) {
    return {
      success: false,
      reason: `Unexpected error: ${(err as Error).message}`,
    };
  }
}
