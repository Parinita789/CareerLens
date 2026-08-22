import { Injectable } from '@nestjs/common';
import type { Page } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSION_FILE = path.join(__dirname, '../../data/linkedin-session.json');

export type ApplyProbeResult =
  | { kind: 'easy_apply' }
  | { kind: 'external'; url: string; host: string }
  | { kind: 'unknown'; reason: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (...args: any[]) => console.log('    [probe]', ...args);

function safeHost(u: string): string {
  try {
    return new URL(u).hostname;
  } catch {
    return '';
  }
}

@Injectable()
export class LinkedInProbeService {
  async probeLinkedInApplyTarget(page: Page, linkedinJobUrl: string): Promise<ApplyProbeResult> {
    try {
      if (fs.existsSync(SESSION_FILE)) {
        try {
          const cookies = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8'));
          await page.context().addCookies(cookies);
        } catch {
          /* ignore */
        }
      }

      log(`navigating to ${linkedinJobUrl}`);
      await page.goto(linkedinJobUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => null);
      await sleep(800);

      // Find the PRIMARY apply button. Scope to the job-details top card so we don't
      // get confused by the "Similar Easy Apply jobs" sidebar, which contains Easy
      // Apply links to unrelated jobs.
      const primarySelectors = [
        '.jobs-apply-button--top-card button',
        '.jobs-s-apply button',
        '.job-details-jobs-unified-top-card__container--two-pane button.jobs-apply-button',
        'button.jobs-apply-button',
      ];
      let applyBtn = null;
      let matchedSelector = '';
      for (const sel of primarySelectors) {
        applyBtn = await page.$(sel).catch(() => null);
        if (applyBtn) {
          matchedSelector = sel;
          break;
        }
      }
      if (!applyBtn) {
        log('no apply button found — probe giving up');
        return { kind: 'unknown', reason: 'no apply button found on page' };
      }

      const ariaLabel = ((await applyBtn.getAttribute('aria-label').catch(() => '')) ?? '').trim();
      const innerText = ((await applyBtn.innerText().catch(() => '')) ?? '').trim();
      log(
        `matched "${matchedSelector}"  aria="${ariaLabel.slice(0, 80)}"  text="${innerText.slice(0, 40)}"`,
      );

      // Authoritative Easy Apply signal: the BUTTON's own aria-label starts with or
      // contains "Easy Apply" (LinkedIn format: "Easy Apply to Senior Backend...").
      // Text node reads "Easy Apply" for these too.
      const looksEasyApply = /easy apply/i.test(ariaLabel) || /easy apply/i.test(innerText);
      if (looksEasyApply) {
        log('classified → easy_apply');
        return { kind: 'easy_apply' };
      }

      log('classified → external (will click to resolve destination URL)');

      // Click and capture the popup. We close it once we have the final URL.
      const popupPromise = page
        .context()
        .waitForEvent('page', { timeout: 10000 })
        .catch(() => null);
      await applyBtn.click({ delay: 50 }).catch(() => null);
      const popup = await popupPromise;

      if (popup) {
        try {
          // Poll the popup URL until it either (a) leaves LinkedIn, or (b) stops
          // changing for 2s. LinkedIn's tracking chain (linkedin.com/comm → tracking
          // redirect → company hop → Greenhouse board) can take 3-6s to settle.
          const settleTimeoutMs = 12000;
          const startedAt = Date.now();
          let lastUrl = '';
          let stableSince = 0;
          while (Date.now() - startedAt < settleTimeoutMs) {
            const cur = popup.url();
            if (cur !== lastUrl) {
              log(`popup url changed → ${cur}`);
              lastUrl = cur;
              stableSince = Date.now();
            }
            // Leave early if we've clearly landed on an external host.
            if (cur && !cur.includes('linkedin.com') && !cur.startsWith('about:')) {
              if (Date.now() - stableSince > 2000) break;
            }
            await sleep(500);
          }

          const finalUrl = popup.url();
          const host = safeHost(finalUrl);
          await popup.close().catch(() => null);

          if (!finalUrl || finalUrl.startsWith('about:') || finalUrl.includes('linkedin.com')) {
            log(`popup never left linkedin (final="${finalUrl}")`);
            return {
              kind: 'unknown',
              reason: `popup stayed on LinkedIn (${finalUrl || 'about:blank'})`,
            };
          }
          log(`final external url → ${finalUrl}`);
          return { kind: 'external', url: finalUrl, host };
        } catch (err) {
          await popup.close().catch(() => null);
          return { kind: 'unknown', reason: `popup err: ${(err as Error).message}` };
        }
      }

      // Some LinkedIn variants navigate the same tab instead of opening a popup.
      const navUrl = page.url();
      if (navUrl && !navUrl.includes('linkedin.com')) {
        log(`same-tab redirect → ${navUrl}`);
        return { kind: 'external', url: navUrl, host: safeHost(navUrl) };
      }
      log('apply click produced no popup and no navigation');
      return { kind: 'unknown', reason: 'apply click produced no popup/navigation' };
    } catch (err) {
      return { kind: 'unknown', reason: `probe threw: ${(err as Error).message}` };
    }
  }

  classifyAts(url: string): 'greenhouse' | 'ashby' | 'unsupported' {
    if (!url) return 'unsupported';
    if (/(?:job-boards|boards)\.greenhouse\.io/.test(url)) return 'greenhouse';
    if (/greenhouse\.com\/embed\/job_app/.test(url)) return 'greenhouse';
    if (/jobs\.ashbyhq\.com/.test(url)) return 'ashby';
    return 'unsupported';
  }
}
